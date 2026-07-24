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
//   - 思考过程:✻ 思考 头 + 灰色斜体流式输出
//   - 工具调用块(Claude Code 风格):⏺ 工具头 + 智能参数摘要,
//     结果用 ⎿/│ 缩进槽,按退出码/错误前缀着色
//   - 正文:⏺ 项目符号 + 逐行缓冲的轻量 markdown 渲染
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
    chalk.green.bold(title),
    `${modelText}: ${chalk.cyan(modelLabel)}${baseURL ? ' ' + chalk.dim(baseURL) : ''}`,
    `${cwdText}: ${chalk.cyan(cwd)}`,
    chalk.dim(tip),
  ].join('\n')
  process.stdout.write(
    boxenAdaptive(lines, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      margin: { top: 1, bottom: 0, left: 0, right: 0 },
      borderColor: 'cyan',
      borderStyle: 'round',
    }) + '\n'
  )
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
//   ❯ 用户输入…                              ← readline prompt
//   ╰────────────────────────────────────────╯   ← drawInputBottom()
//
// readline 只能管一行提示符,上下边框由我们在 prompt 前 / line 事件后补画。
// 非 TTY 或终端过窄时静默降级为裸提示符。

function borderLine(left, right) {
  const w = Math.max(MIN_BOX_WIDTH, termWidth() - 2)
  return chalk.dim(left + '─'.repeat(w) + right)
}

export function drawInputTop(write = (s) => process.stdout.write(s)) {
  if (!process.stdout.isTTY) return
  write(borderLine('╭', '╮') + '\n')
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
    text: chalk.dim(text),
    spinner: 'dots',
    color: 'cyan',
  })
  spinner.start()
  return {
    stop() {
      if (spinner.isSpinning) spinner.stop()
    },
  }
}

// ──────────────────────────────────────────────
// 流式回复 writer:思考(灰斜体) + 正文(⏺ + 轻量 markdown)
// ──────────────────────────────────────────────

/** 行内 markdown:`code` 优先提取防干扰,再处理 **bold** */
function renderInline(line) {
  const spans = []
  // 先抠出 inline code,避免其中的 * 被 bold 规则误吃
  line = line.replace(/`([^`\n]+)`/g, (m, c) => {
    spans.push(c)
    return `\u0000${spans.length - 1}\u0000`
  })
  line = line.replace(/\*\*([^*\n]+)\*\*/g, (m, c) => chalk.bold(c))
  line = line.replace(/\u0000(\d+)\u0000/g, (m, i) => chalk.cyan(spans[Number(i)]))
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
  let contentLines = 0     // 已输出正文行数(首行带 ⏺ 子弹头)
  let lastBlank = false    // 上一行是空白行(连续空行合并,避免模型输出头部/分隔空行刷屏)

  const emitContentLine = (raw, withNewline = true) => {
    // 围栏标记行:切换状态,用一个淡淡的槽线代替裸 ```
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      const bullet = contentLines === 0 ? chalk.green('⏺ ') : '  '
      contentLines++
      lastBlank = false
      write(bullet + chalk.dim(inFence ? '┄ code ' + '┄'.repeat(8) : '┄'.repeat(14)) + (withNewline ? '\n' : ''))
      return
    }
    // 围栏内:代码行原样带槽线(空行也保留,代码格式不能动)
    if (inFence) {
      const bullet = contentLines === 0 ? chalk.green('⏺ ') : '  '
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
    const bullet = contentLines === 0 ? chalk.green('⏺ ') : '  '
    contentLines++
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    const body = h ? chalk.bold(renderInline(h[2])) : renderInline(raw)
    write(bullet + body + (withNewline ? '\n' : ''))
  }

  const flushLineBuf = (withNewline = true) => {
    if (!lineBuf) return
    emitContentLine(lineBuf, withNewline)
    lineBuf = ''
  }

  return {
    /** 思考段:灰斜体直写(不做 markdown),段头只打印一次 */
    writeThinking(text) {
      if (!showThinking || !text) return
      if (mode !== 'thinking') {
        flushLineBuf()
        mode = 'thinking'
        write('\n' + chalk.dim.italic(thinkingHeader) + '\n')
      }
      write(chalk.dim.italic(text))
    },

    /** 正文段:⏺ 子弹头 + 逐行 markdown 渲染 */
    writeContent(text) {
      if (!text) return
      if (mode !== 'content') {
        if (mode === 'thinking') write('\n')
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

/** 工具头:⏺ name  参数摘要 */
export function printToolHeader(name, summary, write = (s) => process.stdout.write(s)) {
  write('\n' + chalk.green('⏺ ') + chalk.bold(name) + (summary ? '  ' + chalk.dim(summary) : '') + '\n')
}

/**
 * 工具结果块:
 *   ⎿ 首行
 *   │ 后续行…
 * 退出码非 0 → 黄色;"错误/已拒绝"开头 → 红色;其余暗色。
 */
export function printToolResult(result, write = (s) => process.stdout.write(s)) {
  const text = truncateDisplay(result)
  const exitMatch = text.match(/^\$[^\n]*\n\(exit (\d+)\)/)
  const exitCode = exitMatch ? Number(exitMatch[1]) : null
  const isError = exitCode !== null && exitCode !== 0
    || /^(错误|已拒绝|Error)/.test(text.trim())
  const colorize = isError ? chalk.yellow : chalk.dim
  const lines = text.split('\n')
  const rendered = lines.map((l, i) => {
    const gutter = i === 0 ? chalk.dim('  ⎿  ') : chalk.dim('  │  ')
    return gutter + colorize(l)
  }).join('\n')
  write(rendered + '\n')
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
  printBanner,
  printHelpPanel,
  drawInputTop,
  drawInputBottom,
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
