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
// 长任务结束后的"人不在终端前也能收到"的提醒:系统通知 + 提示音 + 终端标题。
//
// 为什么需要它:release 的"装全局"阶段实测能磨十几分钟(registry 元数据/对象就绪慢,
// 见 scripts/release.js 顶部那一长串注释),用户不可能一直盯着终端。终端里再醒目的一行
// "🎉 发布完成",对已经走去干别的事的人等于没打 —— 提醒必须走**终端之外**的信道。
//
// 三条信道各自独立、各自 best-effort,一条挂掉不影响另外两条:
//   ① 系统通知(Windows toast / macOS osascript / Linux notify-send);
//   ② 提示音(成功与失败**不同**的音 —— 人不在屏幕前时,响成什么样是唯一能分辨结果的信号);
//   ③ 终端标题(任务栏上那行字变成结果,回头扫一眼就知道)。
//
// 硬约束(踩过的坑都在这三条里):
//   - **绝不抛异常、绝不阻塞**:提醒是附加品,不许把一次成功的发布变成失败退出,
//     也不许让父进程等着它。派生进程一律 unref(),`main()` 该返回就返回。
//   - spawn 一个不存在的命令(比如 Linux 上没装 notify-send)是走 `'error'` 事件而不是
//     抛异常 —— 不挂这个监听就是**未捕获异常**,会直接打挂发布流程。
//   - 文案里带用户可控内容(版本号 / 报错原文 / 任务标题)时,**按目标信道各自转义**:
//     toast 正文进的是 XML(要转义 `& < >`),PowerShell 走单引号字符串(内部单引号翻倍)。
//     漏了这两处不会报错,只会"什么都没弹出来",排查起来毫无线索。
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
  fail: ['Windows Critical Stop.wav', 'Windows Battery Critical.wav', 'Alarm01.wav'],
}
const WIN_SYSTEM_SOUND = { ok: 'Asterisk', fail: 'Hand' }

function winSoundScript(ok) {
  const kind = ok ? 'ok' : 'fail'
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

// ---------------------------------------------------------------------------
// 计划(纯函数 —— 单测只断言这里)
// ---------------------------------------------------------------------------

/**
 * 按平台把"提醒一次"翻译成要跑的进程列表。
 *
 * 纯函数,不碰进程也不碰文件系统,便于单测;真正 spawn 的是 notifyDesktop()。
 * 返回 `{ title, cmds: [{ cmd, args }] }`。
 */
export function buildNotifyPlan({ platform = process.platform, title, message, ok = true } = {}) {
  const safeTitle = String(title ?? '')
  const safeMessage = String(message ?? '')

  if (platform === 'win32') {
    const ps = ['-NoProfile', '-NonInteractive', '-Command']
    return {
      title: safeTitle,
      cmds: [
        { cmd: 'powershell.exe', args: [...ps, winToastScript(safeTitle, safeMessage)] },
        { cmd: 'powershell.exe', args: [...ps, winSoundScript(ok)] },
      ],
    }
  }

  if (platform === 'darwin') {
    const script = `display notification ${appleScriptQuote(safeMessage)}`
      + ` with title ${appleScriptQuote(safeTitle)}`
      + ` sound name ${appleScriptQuote(ok ? 'Glass' : 'Basso')}`
    return { title: safeTitle, cmds: [{ cmd: 'osascript', args: ['-e', script] }] }
  }

  // Linux / 其他:notify-send 是事实标准,声音文件各发行版路径不一,拿不到就是没声音
  return {
    title: safeTitle,
    cmds: [
      {
        cmd: 'notify-send',
        args: ['-a', 'zen-gitsync', '-u', ok ? 'normal' : 'critical', safeTitle, safeMessage],
      },
      {
        cmd: 'paplay',
        args: [
          ok
            ? '/usr/share/sounds/freedesktop/stereo/complete.oga'
            : '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
        ],
      },
    ],
  }
}

/**
 * 发一次提醒。返回成功派生的进程数(拿不到具体结果 —— 提醒本身没有失败可言)。
 *
 * 不 await、不阻塞:所有子进程 unref(),调用方紧接着 process.exit() 也不会把它们掐掉。
 */
export function notifyDesktop({ title, message, ok = true, platform = process.platform } = {}) {
  let plan
  try {
    plan = buildNotifyPlan({ platform, title, message, ok })
  } catch {
    return 0
  }

  let launched = 0
  for (const { cmd, args } of plan.cmds) {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore' })
      // 命令不存在只会触发 'error' 事件;没有这个监听就是未捕获异常
      child.on('error', () => {})
      child.unref()
      launched += 1
    } catch {
      /* 参数非法等同步异常:吞掉,提醒失败不反噬主线 */
    }
  }
  return launched
}

/**
 * 改终端标题。
 *
 * Windows 走 `process.title`(Node 内部是 SetConsoleTitle,实测 cmd 窗口标题会变);
 * 其他平台 process.title 只改进程名,所以额外写一次 OSC 0 转义 —— 只在 TTY 上写,
 * 重定向到文件时写这个等于往文件里灌乱码。
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
