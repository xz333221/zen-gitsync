// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 长任务结束后的"人不在终端前也能收到"的提醒:系统通知 + 置顶弹窗 + 提示音 + 终端标题。
//
// 为什么需要它:release 的"装全局"阶段实测能磨十几分钟(registry 元数据/对象就绪慢,
// 见 scripts/release.js 顶部那一长串注释),用户不可能一直盯着终端。终端里再醒目的一行
// "🎉 发布完成",对已经走去干别的事的人等于没打 —— 提醒必须走**终端之外**的信道。
//
// ============================ 两个必须踩过的坑 ============================
//
// ① **`spawn` 之后 `unref()` 就走人,提醒根本发不出去。**
//    第一版就是这么写的(当时想的是"别让提醒拖住发布"),结果是:cmd 里老老实实打出
//    "已发送结束提醒",而系统通知中心里一条都没有 —— 2026-09-30 实测,发版 v2.17.30 /
//    v2.17.31 两次都没有任何提醒落地(注册表里 AUMID 的 LastNotificationAddedTime 停在
//    更早的一次手工测试上)。隔离实验(子进程睡 3s 再写 marker,父进程立刻退出):
//    普通 spawn、`detached: true`、甚至让子进程用 Start-Process 甩孙进程 —— **三个 marker
//    一个都没写出来**;父进程只要不 unref(让 node 等着),marker 立刻就有。
//    结论:**发提醒必须等子进程**,调用方 `await`。发布本来就跑了十几分钟,多等一两秒
//    换"提醒真的送出去"完全值得。
//
// ② **弹窗不能由 release 进程自己扛着。** 置顶弹窗是要停留几十秒给人看的,可子进程活不过
//    父进程(见①),node 一退弹窗就没了。办法是让"启动器"用 `Start-Process` 把它**甩出去**
//    —— 实验证明被甩出去的进程能独立活到用户关掉它(启动器退出、甚至 node 退出之后,窗口
//    标题仍在枚举里)。所以链路是:node wait 启动器 → 启动器把弹窗甩出去后立刻退出。
//
// 另外两个 Windows 细节(都实测过,改的时候别想当然):
//   - `Start-Process -WindowStyle Hidden` 会把**窗体也一起藏掉**(STARTUPINFO 的
//     wShowWindow=SW_HIDE 会被子进程继承,而进程的第一次 ShowWindow 会强制用它)。
//     → 先 `Show()` 一个丢弃窗体把这一次用掉,真窗体再正常显示。
//   - 不给 `-WindowStyle Hidden` 的话会多出一个黑色控制台窗口 → 必须给。
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// 转义
// ---------------------------------------------------------------------------

/**
 * PowerShell 单引号字符串字面量。
 *
 * 单引号是 PS 里唯一"什么都不解释"的字符串形式(双引号里 `$` 和反引号会被展开),
 * 所以文案一律走这里;内部单引号翻倍即可,换行 / 中文 / 反斜杠都不用额外处理。
 */
export function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/**
 * XML 文本节点转义(toast 正文专用)。
 *
 * toast 正文是塞进 `XmlDocument.LoadXml()` 的 —— 报错原文里只要出现一个 `<`
 * (例如 `Unexpected token < in JSON at position 0`),整份 XML 就解析失败,
 * 结果是一条 toast 都弹不出来,而且 PowerShell 的错误还被我们吞掉了。
 */
export function xmlEscape(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
  return String(value ?? '').replace(/[&<>]/g, (c) => map[c])
}

/**
 * AppleScript 字符串字面量(osascript 用)。双引号字符串,转义 `\` 与 `"`。
 */
export function appleScriptQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// 用 PowerShell 自己的 AUMID 注册 toast —— 它是系统里**已经有快捷方式**的那一个,
// toast 因此能弹出来(归属显示为 Windows PowerShell)。自己造一个 AUMID 需要先往开始
// 菜单写 .lnk,发布脚本不该干那种事。
const POWERSHELL_AUMID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

// 提示音:wav 名以 `%WINDIR%\Media` 下的文件名为准(zh-CN 的 Windows 11 上同样是
// 这几个英文名)。逐个试,一个都没有才退回 SystemSounds 的默认音。
const WIN_WAVS = {
  ok: ['Windows Notify System Generic.wav', 'notify.wav', 'chimes.wav'],
  error: ['Windows Critical Stop.wav', 'Windows Battery Critical.wav', 'Alarm01.wav'],
}
const WIN_SYSTEM_SOUND = { ok: 'Asterisk', error: 'Hand' }

// 三条可能出现的结局各一套配色(置顶弹窗的底色)。warn 用琥珀色:"包已经发出去了、
// 只是没装到全局"既不是成功也不是失败,涂成绿的或红的都是误导。
const LEVEL_COLORS = {
  ok: { accent: [46, 160, 67], bg: [24, 28, 26] },
  warn: { accent: [204, 141, 30], bg: [32, 28, 18] },
  error: { accent: [200, 70, 70], bg: [34, 22, 24] },
}

/** `level` 缺省时按 ok 回落:true → ok,false → error */
function normalizeLevel(level, ok) {
  if (level === 'ok' || level === 'warn' || level === 'error') return level
  return ok === false ? 'error' : 'ok'
}

function winSoundScript(level) {
  // warn 也走"普通提示音":它要人看一眼,但不是出错
  const kind = level === 'error' ? 'error' : 'ok'
  const candidates = WIN_WAVS[kind].map((f) => `(Join-Path $env:WINDIR 'Media\\${f}')`).join(', ')
  return [
    '$played = $false',
    `foreach ($w in @(${candidates})) {`
      + ' if (-not $played -and (Test-Path $w)) {'
      + ' try { (New-Object System.Media.SoundPlayer $w).PlaySync(); $played = $true } catch { }'
      + ' } }',
    // 兜底:Play() 是异步的,不放这个 Start-Sleep 的话 PowerShell 会先于声音退出
    `if (-not $played) { [System.Media.SystemSounds]::${WIN_SYSTEM_SOUND[kind]}.Play(); Start-Sleep -Milliseconds 700 }`,
  ].join('; ')
}

function winToastScript(title, message) {
  const xml = '<toast><visual><binding template="ToastGeneric">'
    + `<text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text>`
    + '</binding></visual></toast>'
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(${psQuote(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(POWERSHELL_AUMID)}).Show($toast)`,
  ].join('; ')
}

// 置顶弹窗的停留时长。给足 5 分钟:系统横幅只挂 MessageDuration(本机实测 5 秒)就没了,
// 而"人走开几分钟再回来"才是常态;再长就没必要了(通知中心 + 终端标题都是常驻的)。
export const POPUP_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 置顶弹窗的脚本。**由启动器用 Start-Process 甩出去单独跑**(理由见文件头坑②)。
 *
 * 用 -EncodedCommand(UTF-16LE base64)传,绕开所有命令行引号问题:标题/正文里带单引号、
 * 双引号、`&`、`%` 都不会出事。
 */
export function winPopupScript({ title, message, level, ok = true, timeoutMs = POPUP_TIMEOUT_MS } = {}) {
  const lv = normalizeLevel(level, ok)
  const { accent, bg } = LEVEL_COLORS[lv]
  const rgb = ([r, g, b]) => `[System.Drawing.Color]::FromArgb(${r}, ${g}, ${b})`
  const minutes = Math.max(1, Math.round(timeoutMs / 60000))
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    // 先 Show 一个丢弃窗体:进程的**第一次** ShowWindow 会被 STARTUPINFO 里的
    // wShowWindow(SW_HIDE,来自 Start-Process -WindowStyle Hidden)强制覆盖,
    // 让它顶掉,真窗体才能正常显示 —— 不加这段弹窗永远不出现。
    '$d = New-Object System.Windows.Forms.Form',
    '$d.Show(); $d.Hide(); $d.Dispose()',
    '$f = New-Object System.Windows.Forms.Form',
    `$f.Text = ${psQuote(title)}`,
    '$f.TopMost = $true',
    "$f.StartPosition = 'CenterScreen'",
    '$f.ClientSize = New-Object System.Drawing.Size(540, 250)',
    '$f.MinimizeBox = $false',
    '$f.MaximizeBox = $false',
    "$f.FormBorderStyle = 'FixedToolWindow'",
    `$f.BackColor = ${rgb(bg)}`,
    '$f.KeyPreview = $true',
    // 整块窗体都能点掉:人在键盘前时一下就走,不用瞄准按钮
    '$f.Add_Click({ $f.Close() })',
    "$f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $f.Close() } })",
    '$bar = New-Object System.Windows.Forms.Label',
    '$bar.Dock = "Top"',
    '$bar.Height = 5',
    `$bar.BackColor = ${rgb(accent)}`,
    '$f.Controls.Add($bar)',
    '$t = New-Object System.Windows.Forms.Label',
    `$t.Text = ${psQuote(title)}`,
    "$t.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)",
    "$t.ForeColor = [System.Drawing.Color]::FromArgb(240, 242, 245)",
    '$t.Dock = "Top"',
    '$t.Height = 56',
    '$t.Padding = New-Object System.Windows.Forms.Padding(20, 14, 20, 0)',
    '$f.Controls.Add($t)',
    '$m = New-Object System.Windows.Forms.Label',
    `$m.Text = ${psQuote(message)}`,
    "$m.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)",
    "$m.ForeColor = [System.Drawing.Color]::FromArgb(190, 196, 205)",
    '$m.Dock = "Fill"',
    '$m.Padding = New-Object System.Windows.Forms.Padding(20, 8, 20, 0)',
    '$f.Controls.Add($m)',
    '$h = New-Object System.Windows.Forms.Label',
    `$h.Text = ${psQuote(`点击窗口任意位置关闭(${minutes} 分钟后自动关闭)`)}`,
    "$h.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)",
    "$h.ForeColor = [System.Drawing.Color]::FromArgb(130, 138, 150)",
    '$h.Dock = "Bottom"',
    '$h.Height = 34',
    '$h.TextAlign = "MiddleLeft"',
    '$h.Padding = New-Object System.Windows.Forms.Padding(20, 0, 20, 6)',
    '$f.Controls.Add($h)',
    '$timer = New-Object System.Windows.Forms.Timer',
    `$timer.Interval = ${timeoutMs}`,
    '$timer.Add_Tick({ $f.Close() })',
    '$timer.Start()',
    '[void]$f.ShowDialog()',
  ].join('\n')
}

/**
 * Windows 的"启动器":在**一个** PowerShell 里按顺序做完三件事,然后退出。
 * 三件事各自 try 住 —— 通知被策略挡了不该把提示音一起带走。
 *
 * 顺序是有讲究的:toast 和甩弹窗都是瞬间返回的(体感上同时出现),提示音是同步阻塞的
 * (PlaySync 要把 wav 放完),放最后才不会拖慢前两者。
 */
export function winLauncherScript({ title, message, level, ok = true, timeoutMs } = {}) {
  const lv = normalizeLevel(level, ok)
  const popupB64 = Buffer.from(
    winPopupScript({ title, message, level: lv, timeoutMs }),
    'utf16le'
  ).toString('base64')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `try { ${winToastScript(title, message)} } catch { }`,
    "try { Start-Process -WindowStyle Hidden -FilePath 'powershell.exe'"
      + ` -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${popupB64}') } catch { }`,
    `try { ${winSoundScript(lv)} } catch { }`,
  ].join('; ')
}

// ---------------------------------------------------------------------------
// 计划(纯函数 —— 单测只断言这里)
// ---------------------------------------------------------------------------

/**
 * 按平台把"提醒一次"翻译成要跑的进程列表。
 *
 * 纯函数,不碰进程也不碰文件系统,便于单测;真正 spawn + 等待的是 notifyDesktop()。
 * 返回 `{ title, cmds: [{ cmd, args }] }`。
 */
export function buildNotifyPlan({ platform = process.platform, title, message, ok = true, level, timeoutMs } = {}) {
  const safeTitle = String(title ?? '')
  const safeMessage = String(message ?? '')
  const lv = normalizeLevel(level, ok)

  if (platform === 'win32') {
    const script = winLauncherScript({ title: safeTitle, message: safeMessage, level: lv, timeoutMs })
    return {
      title: safeTitle,
      cmds: [{ cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }],
    }
  }

  if (platform === 'darwin') {
    const script = `display notification ${appleScriptQuote(safeMessage)}`
      + ` with title ${appleScriptQuote(safeTitle)}`
      + ` sound name ${appleScriptQuote(lv === 'error' ? 'Basso' : 'Glass')}`
    return { title: safeTitle, cmds: [{ cmd: 'osascript', args: ['-e', script] }] }
  }

  // Linux / 其他:notify-send 是事实标准,声音文件各发行版路径不一,拿不到就是没声音
  return {
    title: safeTitle,
    cmds: [
      {
        cmd: 'notify-send',
        args: ['-a', 'zen-gitsync', '-u', lv === 'error' ? 'critical' : 'normal', safeTitle, safeMessage],
      },
      {
        cmd: 'paplay',
        args: [
          lv === 'error'
            ? '/usr/share/sounds/freedesktop/stereo/dialog-error.oga'
            : '/usr/share/sounds/freedesktop/stereo/complete.oga',
        ],
      },
    ],
  }
}

// 等子进程结束(或超时后杀掉它,免得把调用方一直吊着)
function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    let timer = null
    const finish = (settled) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(settled)
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish(false)
    }, timeoutMs)
    // 命令不存在(比如 Linux 上没装 notify-send)只会走 'error' 事件,不挂这个监听
    // 就是未捕获异常 —— 会直接把一次成功的发布打挂。提醒是附加品,不许反噬主线。
    child.on('error', () => finish(false))
    child.on('exit', () => finish(true))
  })
}

/**
 * 发一次提醒,**并等它真的做完**(默认最多 15s)。返回 `{ launched, delivered }`。
 *
 * 为什么必须 await(而不是 spawn 完就走):见文件头坑①。第一版就是 fire-and-forget,
 * 结果 cmd 里打着"已发送结束提醒"、而系统里一条通知都没有。
 *
 * 超时不会抛异常,只是把子进程杀掉并如实报 `delivered: false` —— 提醒失败不影响发布结果。
 */
export async function notifyDesktop({
  title,
  message,
  ok = true,
  level,
  platform = process.platform,
  timeoutMs = 15000,
} = {}) {
  let plan
  try {
    plan = buildNotifyPlan({ platform, title, message, ok, level })
  } catch {
    return { launched: 0, delivered: false }
  }

  const children = []
  for (const { cmd, args } of plan.cmds) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' })
      children.push(child)
    } catch {
      /* 参数非法等同步异常:吞掉,提醒失败不反噬主线 */
    }
  }

  const settled = await Promise.all(children.map((c) => waitForChild(c, timeoutMs)))
  return {
    launched: children.length,
    delivered: children.length > 0 && settled.every(Boolean),
  }
}

/**
 * 改终端标题。
 *
 * Windows 走 `process.title`(Node 内部是 SetConsoleTitle,实测 cmd 窗口标题会变),
 * 其他平台 process.title 只改进程名,所以额外写一次 OSC 0 转义 —— 只在 TTY 上写,
 * 重定向到文件时写这个等于往文件里灌乱码。
 *
 * 这条信道**不需要任何子进程**,所以哪怕通知/弹窗全被系统挡住,任务栏上那行字也还在。
 */
export function setTerminalTitle(text) {
  const title = String(text ?? '')
  try {
    process.title = title
  } catch {
    /* 个别平台 process.title 只读 */
  }
  if (process.platform !== 'win32' && process.stdout?.isTTY) {
    try {
      process.stdout.write(`\u001b]0;${title}\u0007`)
    } catch {
      /* 忽略 */
    }
  }
  return title
}
