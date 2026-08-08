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
// g ai 终端渲染层 — 对标 Codex CLI / Claude Code / OpenCode 的视觉效果:
//
//   - 盒式输入框(Codex composer 风格):╭───╮ + ❯ 提示符 + ╰───╯
//   - 等待 spinner(ora):首个 token 到达前持续转动
//   - 思考过程:✻ 思考 头 + 橙黄斜体流式输出
//   - 工具调用块(Claude Code 风格):⚙ 工具头 + 智能参数摘要,
//     结果用 │ 缩进槽,按退出码/错误前缀着色
//   - 正文:➤ 子弹头 + 逐行缓冲的轻量 markdown 渲染
//     (**bold**、`code`、# 标题、``` 代码块、- 列表)
//
// 设计约束:
//   - 纯 readline CLI(非全屏 TUI),所有渲染都是"追加式"的,不做光标重排
//   - 非 TTY(管道/CI)下自动降级:不画边框、spinner 退化为静态文本
//   - 所有需要单测的函数都支持注入 write 函数,不直接绑死 process.stdout

import chalk from 'chalk'
import ora from 'ora'
import { boxenAdaptive } from '../ui.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
export const DISPLAY_RESULT_LIMIT = 600    // 工具结果回显截断长度(完整结果仍进上下文)

// 回显截断的"最小省略量":只超出一两个字符时截断反而碍事(实测:git status
// 输出 614 字符被截,省略 14 字符还把路径从中间切断),不值得就不截
const TRUNCATE_MIN_OMITTED = 200

const MIN_BOX_WIDTH = 24   // 终端窄于这个宽度就不画输入框边框(画了也难看)

// ──────────────────────────────────────────────
// 基础工具
// ──────────────────────────────────────────────

/** 终端宽度;非 TTY / 获取不到时给 fallback */
export function termWidth(fallback = 100) {
  const cols = process.stdout?.columns
  return (typeof cols === 'number' && cols > 0 && Number.isFinite(cols)) ? cols : fallback
}

/** 去掉 ANSI 转义(测试断言用) */
export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * 回显截断(纯函数,便于单测):
 *   - 只超出一点点(< TRUNCATE_MIN_OMITTED)时原样返回
 *   - 截断保留 头+尾,且切口对齐到整行边界 —— 避免把路径/单词从中间切断
 *   - 命令输出最关键的信息(报错、最终结果)通常在末尾,所以头尾都要
 */
export function truncateDisplay(text, limit = DISPLAY_RESULT_LIMIT) {
  text = String(text || '')
  if (text.length <= limit + TRUNCATE_MIN_OMITTED) return text
  const half = Math.floor(limit / 2)
  const headRaw = text.slice(0, half)
  const tailRaw = text.slice(text.length - half)
  // 头部对齐到最后一个完整行;尾部对齐到第一个完整行
  const lastNl = headRaw.lastIndexOf('\n')
  const head = lastNl > 0 ? headRaw.slice(0, lastNl) : headRaw
  const firstNl = tailRaw.indexOf('\n')
  const tail = firstNl >= 0 ? tailRaw.slice(firstNl + 1) : tailRaw
  const omitted = text.length - head.length - tail.length
  return `${head}\n  ⋮ [回显省略 ${omitted} 字符,完整结果已提供给模型]\n${tail}`
}

// ──────────────────────────────────────────────
// 横幅 / 帮助
// ──────────────────────────────────────────────

/** 启动横幅:模型 + 目录 + 快捷键提示,盒式自适应宽度 */
export function printBanner({ title, modelLabel, baseURL, cwd, modelText, cwdText, tip }) {
  const lines = [
    // greenBright 在黑底上比 green 更鲜亮,与 🤖 回答图标同色系
    chalk.greenBright.bold(title),
    `${modelText}: ${chalk.cyanBright(modelLabel)}${baseURL ? ' ' + chalk.hex('#a0aec0')(baseURL) : ''}`,
    `${cwdText}: ${chalk.cyanBright(cwd)}`,
    // dim 在黑底太暗,改用浅灰可读
    chalk.hex('#a0aec0')(tip),
  ].join('\n')
  process.stdout.write(
    boxenAdaptive(lines, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderColor: 'greenBright',
      borderStyle: 'round',
    }) + '\n'
  )
}

// ──────────────────────────────────────────────
// 斜杠命令即时提示(输入 / 时在提示符下方浮现,随输入过滤)
// ──────────────────────────────────────────────
//
// 命令元数据集中放这里,printSlashHelp(agent.js)与即时提示共用同一份来源,
// 新增命令时只改这一处。desc 分中英,由调用方按 locale 取用。

export const SLASH_COMMANDS = [
  { cmd: '/help',     descZh: '显示帮助',            descEn: 'Show help' },
  { cmd: '/model',    descZh: '列出 / 切换模型',      descEn: 'List / switch models' },
  { cmd: '/addmodel', descZh: '添加模型配置(向导)',  descEn: 'Add a model (wizard)' },
  { cmd: '/cd',       descZh: '切换工作目录',         descEn: 'Change working directory' },
  { cmd: '/image',    descZh: '附加 / 查看图片',      descEn: 'Attach / list images' },
  { cmd: '/think',    descZh: '开关思考过程显示',      descEn: 'Toggle thinking display' },
  { cmd: '/new',      descZh: '开启新对话',            descEn: 'Start a new chat' },
  { cmd: '/resume',   descZh: '恢复之前的对话',         descEn: 'Resume a previous chat' },
  { cmd: '/clear',    descZh: '清空对话历史',         descEn: 'Clear conversation' },
  { cmd: '/exit',     descZh: '退出',                descEn: 'Quit' },
  { cmd: '/quit',     descZh: '退出',                descEn: 'Quit' },
]

/**
 * 按当前输入过滤斜杠命令(纯函数,便于单测)。
 *   - 仅当输入以 / 开头、且尚未输入空格(还在敲命令名)时才提示
 *   - 前缀匹配,大小写不敏感
 *   - 精确等于某命令且无后续参数时仍然展示该命令(便于确认拼写)
 * @returns {{cmd:string, desc:string}[]}
 */
export function filterSlashCommands(input, locale) {
  const zh = !String(locale || '').startsWith('en')
  const line = String(input || '')
  if (!line.startsWith('/') || /\s/.test(line)) return []
  const q = line.toLowerCase()
  return SLASH_COMMANDS
    .filter((c) => c.cmd.startsWith(q))
    .map((c) => ({ cmd: c.cmd, desc: zh ? c.descZh : c.descEn }))
}

/**
 * 生成即时提示面板的 ANSI 字符串(不含定位,由调用方负责保存/恢复光标)。
 * 每行:两空格缩进 + 蓝色命令名(左对齐补齐 12 字符宽)+ 灰色说明。
 * 所有行的"视觉起点"一致(均为 2 空格缩进);选中行用整行反白区分(从缩进处
 * 开始),不另加 ❯ 之类的偏移标记 —— 避免反白块起点与其他行不齐。
 *   - 越界 selectedIndex(<0 / >=matches.length) 自动回退为 -1(即不高亮)
 *   - 空数组返回空串
 */
export function renderSlashHintBody(matches, selectedIndex = -1) {
  if (!Array.isArray(matches) || matches.length === 0) return ''
  const sel = (Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < matches.length)
    ? selectedIndex
    : -1
  return matches
    .map((m, i) => {
      const command = String(m.cmd).padEnd(12)
      if (i !== sel) return '  ' + chalk.cyan(command) + ' ' + chalk.dim(m.desc)
      // Windows Terminal 的 inverse 会把命令原有的青色吃掉。选中项改用灰色背景,
      // 命令文字仍保持与其他项一致的青色,只用背景表达当前选择。
      return chalk.bgGray('  ')
        + chalk.bgGray.cyan(command)
        + chalk.bgGray(' ')
        + chalk.bgGray.white(m.desc)
    })
    .join('\n')
}

/**
 * 解析 readline keypress 事件,识别"斜杠命令提示"专用快捷键。
 * 返回动作字符串(消费方据此改 selectedIndex 或补全输入);
 * 不识别的键返回 null(由 readline 正常处理)。
 *
 *   - ↑ / Shift+Tab → 'prev'
 *   - ↓             → 'next'
 *   - Tab           → 'complete'(补全选中命令到输入行)
 *   - Enter         → 'complete'(补全选中命令到输入行,与 Tab 一致)
 *   - Esc           → 'cancel'
 *
 * 注意:readline 默认会把方向键当历史浏览。消费方需要在我们这个 handler
 * 里"事后回滚":把 rl.line 恢复成 hint 显示时的基线,再 _refreshLine()。
 * (详见 agent.js 的 keypress 监听与说明)
 */
export function parseKeyForSlashHint(key) {
  if (!key) return null
  const name = key.name
  if (name === 'tab') return key.shift ? 'prev' : 'complete'
  if (name === 'up') return 'prev'
  if (name === 'down') return 'next'
  if (name === 'return' || name === 'enter') return 'complete'
  if (name === 'escape') return 'cancel'
  return null
}

// ──────────────────────────────────────────────────
// 交互式可选列表(供 modelSetup 等一次性向导使用:上下键切换 + Enter 提交)
// ──────────────────────────────────────────────────
//
// 与 renderSlashHintBody 的差异:
//   - 必须支持 Enter 提交(parseKeyForSlashHint 把它当 'complete',但斜杠提示由 REPL 接管;
//     可选列表场景下 wizard 自己消费 Enter,不能丢给 readline)
//   - 多支持直接按数字 1..9/0 跳到指定项(给经常用键盘的用户省一趟 ↑↓)
//   - Ctrl+C 在可选列表场景下与 Esc 等价(都视作取消)
//
// 渲染/解析都做成纯函数,wizard 内部(modelSetup.selectFromList)负责:
//   - 调用 renderSelectableListBody 把列表写到屏幕
//   - 在 rl.input 上挂 keypress 监听,把 readline 默认行为(历史浏览)回滚掉
//   - 每次 selectedIndex 变化时,重绘列表(用 ANSI 把光标上移、清行、再写)

/**
 * 渲染可选项列表 body(纯函数,便于单测)。
 *
 *   - 标准项:`  [k]. label`(未选中)
 *   - 选中项:`▶ [k]. label`(整行反白,含前缀空格,跟下方其它行起点对齐)
 *   - 额外项:编号 0,dim 灰;选中时整行反白(与普通选中项视觉一致)
 *
 * @param {Array<{label: string, value: any}>} items
 * @param {number} [selectedIndex=0] - 选中项下标;范围 [0, items.length+extra)
 *   越界回退为 0(默认选第一项,避免空数组报错)
 * @param {string|null} [extraOptionLabel=null] - 额外项(如"自定义" / "手动输入")
 * @returns {string} body 字符串(不含末尾换行 — 由调用方控制)
 */
export function renderSelectableListBody(items, selectedIndex = 0, extraOptionLabel = null) {
  const safeItems = Array.isArray(items) ? items : []
  const extraActive = !!extraOptionLabel
  const totalLen = safeItems.length + (extraActive ? 1 : 0)
  // selectedIndex 越界时静默回退为 0(首次调用时通常如此)
  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= totalLen) {
    selectedIndex = 0
  }
  const rows = []
  for (let i = 0; i < safeItems.length; i++) {
    const num = String(i + 1).padStart(2)
    const label = safeItems[i].label
    if (i === selectedIndex) {
      // 整行反白(含 '  ' 缩进) — 起点与未选中行严格对齐,不留左侧白边
      rows.push(chalk.inverse(`  ${num}. ${label}`))
    } else {
      rows.push(`  ${chalk.cyan(num)}. ${label}`)
    }
  }
  if (extraActive) {
    const extraIdx = safeItems.length
    if (extraIdx === selectedIndex) {
      // extra 选中时也整行反白,这样高亮跨度统一(虽然 label 是 dim,但反白让它可读)
      rows.push(chalk.inverse(`  ${chalk.dim('0')}. ${extraOptionLabel}`))
    } else {
      rows.push(`  ${chalk.dim('0')}. ${chalk.dim(extraOptionLabel)}`)
    }
  }
  return rows.join('\n')
}

/**
 * 解析 readline keypress 事件,识别"可选列表"专用键。
 * 返回动作字符串(消费方据此改 selectedIndex 或提交);
 * 不识别的键返回 null(让 readline 正常处理 — 但消费方应恢复 line buffer
 * 防止方向键的历史浏览把当前输入覆盖)。
 *
 *   - ↑ / Shift+Tab  → 'prev'
 *   - ↓              → 'next'
 *   - Enter          → 'confirm'
 *   - Esc / Ctrl+C   → 'cancel'
 *   - 数字 0..9      → 'jump:N'(1-based;0 = extra option,需消费方映射)
 *
 * 与 parseKeyForSlashHint 的差别:
 *   - 这里 Enter 直接是 'confirm'——wizard 不会让 readline 默认提交(否则进 line 事件
 *     走 REPL 的命令分发,体验错乱);Esc / Ctrl+C 都是 'cancel';不支持 Tab 补全
 *     (列表项不是命令片段,不需要补全语义)
 */
export function parseKeyForSelectableList(key) {
  if (!key) return null
  const name = key.name
  if (name === 'up') return 'prev'
  if (name === 'tab') return key.shift ? 'prev' : 'next'
  if (name === 'down') return 'next'
  if (name === 'return' || name === 'enter') return 'confirm'
  if (name === 'escape') return 'cancel'
  if (key.ctrl && name === 'c') return 'cancel'
  // 数字键 0..9:readline keypress 事件的 key.name 会是该字符
  if (typeof name === 'string' && /^[0-9]$/.test(name)) return `jump:${name}`
  return null
}

/** 盒式帮助面板 */
export function printHelpPanel(title, lines) {
  const body = [chalk.bold(title), ...lines].join('\n')
  process.stdout.write(
    boxenAdaptive(body, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderColor: 'gray',
      borderStyle: 'round',
    }) + '\n'
  )
}

// ──────────────────────────────────────────────
// 盒式输入框(Codex composer 风格)
// ──────────────────────────────────────────────
//
//   ╭────────────────────────────────────────╮   ← drawInputTop()
//   ❯ 用户输入…                              ← readline prompt(光标停在这行)
//   ╰────────────────────────────────────────╯   ← 与上行同时画好,输入时就看到完整框
//
// readline 只能管一行提示符,边框由我们补画:
// 画完下边框后由调用方把光标移回输入行(readline 的刷新只动当前行,互不影响);
// 用户回车后光标正好落在下边框行,write('\n') 越过它即可,框完整留在回显里。
// 非 TTY 或终端过窄时静默降级为裸提示符。

function borderLine(left, right) {
  const w = Math.max(MIN_BOX_WIDTH, termWidth() - 2)
  return chalk.dim(left + '─'.repeat(w) + right)
}

export function drawInputTop(write = (s) => process.stdout.write(s)) {
  if (!process.stdout.isTTY) return
  write(borderLine('╭', '╮') + '\n')
}

/** 下边框字符串(不带换行)—— 由调用方在 prompt 之后补画并自行恢复光标 */
export function inputBottomBorder() {
  return borderLine('╰', '╯')
}

export function drawInputBottom(write = (s) => process.stdout.write(s)) {
  if (!process.stdout.isTTY) return
  write(borderLine('╰', '╯') + '\n')
}

// ──────────────────────────────────────────────
// 等待 spinner(ora 包装)
// ──────────────────────────────────────────────
//
// 首个 token 到达前转动;到达后 stop() 清行,接着流式输出。
// 非 TTY 时 ora 自动退化为只打印一次文本。

export function startSpinner(text) {
  const spinner = ora({
    // 琥珀色加粗,与思考内容同色系,dim 太浅看不清
    text: chalk.hex('#e8a33d').bold(text),
    spinner: 'dots',
    color: 'yellow',
    // ora 默认 discardStdin: true,内部用 stdin-discarder 在 spinner 运行时
    // 丢弃 stdin 输入。但 stdin-discarder 的 stop() 在 Windows 上有 bug:
    // start() 跳过 Windows,但 stop() 没有 Windows 检查,无条件执行
    // process.stdin.pause() + setRawMode(false),导致 readline 的 stdin
    // 停止 flowing → 事件循环失去引用 → 进程退出。
    // 关闭这个选项即可避免问题。
    discardStdin: false,
  })
  spinner.start()
  return {
    stop() {
      if (spinner.isSpinning) spinner.stop()
    },
  }
}

// ──────────────────────────────────────────────
// 流式回复 writer:思考(橙黄斜体) + 正文(➤ 子弹头 + 轻量 markdown)
// ──────────────────────────────────────────────

/** 行内 markdown:`code` 优先提取防干扰,再处理 **bold**
 * @param {string} resetFg - 行内 code 后需重置的前景色 ANSI 码(如 whiteBright 用 '\x1b[97m'),
 *   避免 chalk.cyan 的 \x1b[39m 把外层 base 色清掉导致后续文字掉色
 */
function renderInline(line, resetFg = '') {
  const spans = []
  // 先抠出 inline code,避免其中的 * 被 bold 规则误吃
  line = line.replace(/`([^`\n]+)`/g, (m, c) => {
    spans.push(c)
    return `\u0000${spans.length - 1}\u0000`
  })
  line = line.replace(/\*\*([^*\n]+)\*\*/g, (m, c) => chalk.bold(c))
  line = line.replace(/\u0000(\d+)\u0000/g, (m, i) => chalk.cyan(spans[Number(i)]) + resetFg)
  return line
}

/**
 * 创建一个流式回复 writer。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.showThinking=true] - false 时丢弃思考段(不影响历史)
 * @param {string}  [opts.thinkingHeader]   - 思考段头文案(如 "✻ 思考")
 * @param {(s:string)=>void} [opts.write]   - 输出函数,默认写 stdout(测试可注入)
 */
export function createAssistantWriter({
  showThinking = true,
  thinkingHeader = '✻ 思考',
  write = (s) => process.stdout.write(s),
} = {}) {
  let mode = null          // null | 'thinking' | 'content'
  let lineBuf = ''         // 正文行缓冲(逐行渲染,保证 ** 等标记完整)
  let inFence = false      // ``` 代码块状态
  let contentLines = 0     // 已输出正文行数(首行带 ➤ 子弹头)
  let lastBlank = false    // 上一行是空白行(连续空行合并,避免模型输出头部/分隔空行刷屏)
  let thinkAtLineStart = true  // 思考流当前是否在行首(用于逐行缩进 + 计算与正文的分隔)
  // ➤ 后留 2 个空格,后续行 3 空格对齐 — 图标与文字之间别太挤
  // 正文 🤖(亮绿):模型最终回复的视觉锚点;用亮绿 + 加粗图标,普通绿在深背景上偏暗
  const BULLET_FIRST = chalk.bold(chalk.hex('#5eff8b')('🤖')) + '  '
  const BULLET_REST = '   '
  // whiteBright ANSI 码:行内 code 的 \x1b[39m 会清掉外层色,用此恢复正文亮白色
  const WB = '\x1b[97m'
  // 思考内容整体右移,与正文文字左缘对齐,视觉上成为独立子块
  const THINK_INDENT = '   '
  // 思考用橙黄色斜体(gray/dim 太浅看不清;橙黄既醒目又与正文白、工具青区分开)
  const thinkStyle = (s) => chalk.hex('#e8a33d').italic(s)
  // 思考图标:🧠 大脑 — 紧贴最左(0 缩进),与工具头、正文对齐到同一左缘
  const THINK_ICON = '🧠'

  const emitContentLine = (raw, withNewline = true) => {
    // 围栏标记行:切换状态,用一个淡淡的槽线代替裸 ```
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      const bullet = contentLines === 0 ? BULLET_FIRST : BULLET_REST
      contentLines++
      lastBlank = false
      write(bullet + chalk.dim(inFence ? '┄ code ' + '┄'.repeat(8) : '┄'.repeat(14)) + (withNewline ? '\n' : ''))
      return
    }
    // 围栏内:代码行原样带槽线(空行也保留,代码格式不能动)
    if (inFence) {
      const bullet = contentLines === 0 ? BULLET_FIRST : BULLET_REST
      contentLines++
      lastBlank = false
      write(bullet + chalk.dim('│ ') + raw + (withNewline ? '\n' : ''))
      return
    }
    // 空白行:首个正文行之前不输出;连续空行合并为一行
    if (raw.trim() === '') {
      if (contentLines === 0 || lastBlank) return
      lastBlank = true
      write('\n')
      return
    }
    lastBlank = false
    const bullet = contentLines === 0 ? BULLET_FIRST : BULLET_REST
    contentLines++
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    // 正文用 whiteBright(亮白)比默认白更醒目;resetFg=WB 让行内 code 后恢复亮白
    const body = h
      ? chalk.bold.whiteBright(renderInline(h[2], WB))
      : chalk.whiteBright(renderInline(raw, WB))
    write(bullet + body + (withNewline ? '\n' : ''))
  }

  const flushLineBuf = (withNewline = true) => {
    if (!lineBuf) return
    emitContentLine(lineBuf, withNewline)
    lineBuf = ''
  }

  return {
    /** 思考段:橙黄斜体 + 整体右缩进(不做 markdown),段头只打印一次 */
    writeThinking(text) {
      if (!showThinking || !text) return
      if (mode !== 'thinking') {
        flushLineBuf()
        mode = 'thinking'
        // 图标 🧠 靠最左(0 缩进),与 ⚙ 工具头、➤ 正文对齐同一左缘
        // 段头前空一行与上文(spinner / 上一轮输出)分隔,视觉更清晰
        write('\n' + THINK_ICON + '  ' + thinkStyle(chalk.bold(thinkingHeader)) + '\n')
        thinkAtLineStart = true
      }
      // 按换行切段,整段着色(避免逐字符 escape 刷屏);每逢行首补一层缩进,
      // 使多行思考整体右移成独立子块。流式 token 可能不以换行结尾,
      // 故用 thinkAtLineStart 记住跨调用的行首状态。
      const parts = text.split('\n')
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i]
        if (seg) {
          if (thinkAtLineStart) write(THINK_INDENT)
          write(thinkStyle(seg))
          thinkAtLineStart = false
        }
        if (i < parts.length - 1) {   // 段间的换行(最后一段后不补)
          write('\n')
          thinkAtLineStart = true
        }
      }
    },

    /** 正文段:➤ 子弹头 + 逐行 markdown 渲染 */
    writeContent(text) {
      if (!text) return
      if (mode !== 'content') {
        // 思考→正文:补足换行 + 空一行,让思考块与正文之间有呼吸间隔(不再紧挨)
        if (mode === 'thinking') write((thinkAtLineStart ? '' : '\n') + '\n')
        // 无思考段直接出正文:null→content 时在 🤖 上方加一空行,与 spinner 分隔
        else if (mode === null) write('\n')
        mode = 'content'
      }
      lineBuf += text
      let idx
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        emitContentLine(lineBuf.slice(0, idx))
        lineBuf = lineBuf.slice(idx + 1)
      }
    },

    /** 流结束:冲刷行缓冲,补结尾换行(任何段都没输出过则不产生空行) */
    finish() {
      if (mode === null) return
      flushLineBuf(false)
      write('\n')
    },
  }
}

// ──────────────────────────────────────────────────────
// 耗时格式化
// ──────────────────────────────────────────────────────

/**
 * 格式化耗时(毫秒 → 人类可读)。
 *   < 1s  → "123ms"
 *   < 60s → "1.2s"
 *   ≥ 60s → "2m30s"
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m${rem}s`
}

// ──────────────────────────────────────────────
// 工具调用块(Claude Code 风格)
// ──────────────────────────────────────────────

/** 按工具类型生成一行参数摘要(纯函数,便于单测) */
export function summarizeToolArgs(name, args, { chars = '字符' } = {}) {
  const clamp = (s, n = 120) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim()
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  switch (name) {
    case 'run_command':
      return '$ ' + clamp(args?.command)
    case 'read_file': {
      const range = (args?.offset || args?.limit)
        ? ` L${args?.offset || 1}-${(args?.offset || 1) + (args?.limit || 2000) - 1}`
        : ''
      return clamp(`${args?.path || ''}${range}`)
    }
    case 'write_file':
      return clamp(`${args?.path || ''} (${String(args?.content ?? '').length} ${chars})`)
    case 'edit_file':
      return clamp(args?.path || '')
    case 'list_files':
      return clamp(`${args?.path || '.'} depth=${args?.depth || 2}`)
    case 'search_text':
      return clamp(`/${args?.pattern || ''}/ ${args?.path || '.'}`)
    default:
      return clamp(JSON.stringify(args ?? {}))
  }
}

/** 工具头:▶  name  参数摘要(青色三角表示"工具执行";name 加粗白色,摘要灰色,避免整块青色) */
export function printToolHeader(name, summary, write = (s) => process.stdout.write(s)) {
  // ▶ 保留青色作为工具执行的标识色;name 用白色加粗与下方结果区分;
  // summary 用浅灰(#a0aec0)— dim 在黑底下太暗看不清,浅灰可读且仍比 name 低调
  write('\n' + chalk.cyan('▶') + '  '
    + chalk.bold.white(name)
    + (summary ? '  ' + chalk.hex('#a0aec0')(summary) : '')
    + '\n')
}

/**
 * 工具结果块:
 *   │  每行统一用 │ 槽线对齐(不做首行 └─ 拐角,看着更干净)
 * 退出码非 0 → 琥珀色;"错误/已拒绝"开头 → 琥珀色;其余用柔和灰蓝(避免与工具头同色)。
 *
 * run_command 的结果里首行是 `$ <command>` 回显——这条信息已经出现在上方的
 * `▶ run_command $ <summary>` 工具头里,这里再印一次就是重复。所以这里把首
 * 行 `$ ...` 剥掉,同时复用它来识别退出码(退出码仍驱动错误着色)。
 *
 * @param {string} result - 工具输出文本
 * @param {(s: string) => void} [write] - 输出函数,默认写 stdout
 * @param {number} [durationMs] - 执行耗时(毫秒),有值时在结果末尾追加 ⏱ 计时行
 */
export function printToolResult(result, write = (s) => process.stdout.write(s), durationMs) {
  const text = truncateDisplay(result)
  // 先把 "$ <command>\n" 这一行回显从展示里剥掉(退出码仍在第二行里识别)
  const visible = text.replace(/^\$[^\n]*\n/, '')
  const exitMatch = text.match(/^\$[^\n]*\n\(exit (\d+)\)/)
  const exitCode = exitMatch ? Number(exitMatch[1]) : null
  const isError = exitCode !== null && exitCode !== 0
    || /^(错误|已拒绝|Error)/.test(text.trim())
  // 正文用柔和灰蓝(#94a3b8)— 不再用青色,避免与工具头同色连成一片;
  // 错误用琥珀色(#f0a020)比黄色更醒目
  const colorize = isError ? chalk.hex('#f0a020') : chalk.hex('#94a3b8')
  const lines = visible.split('\n')
  const rendered = lines.map((l) => chalk.dim('  │  ') + colorize(l)).join('\n')
  // 有耗时时在结果末尾追加 ⏱ 计时行(与结果块同缩进)
  const timingLine = (durationMs != null && Number.isFinite(durationMs))
    ? '\n' + chalk.dim('  │  ⏱ ') + chalk.hex('#7a87a0')(formatDuration(durationMs))
    : ''
  write(rendered + timingLine + '\n')
}

// ──────────────────────────────────────────────
// 杂项状态行
// ──────────────────────────────────────────────
export const printOk = (s, write = (x) => process.stdout.write(x)) => write(chalk.green(s) + '\n')
export const printWarn = (s, write = (x) => process.stdout.write(x)) => write(chalk.yellow(s) + '\n')
export const printError = (s, write = (x) => process.stdout.write(x)) => write(chalk.red(s) + '\n')
export const printDim = (s, write = (x) => process.stdout.write(x)) => write(chalk.dim(s) + '\n')

export default {
  DISPLAY_RESULT_LIMIT,
  termWidth,
  stripAnsi,
  truncateDisplay,
  formatDuration,
  printBanner,
  printHelpPanel,
  SLASH_COMMANDS,
  filterSlashCommands,
  renderSlashHintBody,
  parseKeyForSlashHint,
  renderSelectableListBody,
  parseKeyForSelectableList,
  drawInputTop,
  drawInputBottom,
  inputBottomBorder,
  startSpinner,
  createAssistantWriter,
  summarizeToolArgs,
  printToolHeader,
  printToolResult,
  printOk,
  printWarn,
  printError,
  printDim,
}
