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
// g ai 智能体的工具层 — OpenAI function calling 格式的工具定义 + 执行器。
//
// 权限模型(用户在需求里明确授权):
//   - 文件读写 / 命令执行不设目录白名单,工作目录与其他目录都可以操作
//   - 唯一限制来自 safety.js 的系统级红线(格式化、删根目录、关机等)
//
// 输出约束:
//   - 所有工具结果都是字符串,直接作为 role:'tool' 消息回喂给模型
//   - 大输出在源头截断(头 + 尾保留),避免撑爆上下文窗口
//   - 工具内部异常一律 catch 成字符串返回,不抛给 agent 循环 ——
//     让模型看到错误信息自己修正,而不是中断整轮对话

import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import iconv from 'iconv-lite'
import { trackChild } from '../cleanup.js'
import { checkDangerousCommand } from './safety.js'

// ──────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────
const MAX_CMD_OUTPUT = 8000        // run_command 输出截断预算(字符)
const MAX_READ_LINES = 2000        // read_file 单次最多返回行数
const MAX_LINE_WIDTH = 2000        // 单行截断宽度
const MAX_LIST_ENTRIES = 400       // list_files 最多条目
const MAX_SEARCH_HITS = 100        // search_text 最多命中
const MAX_SEARCH_FILE_SIZE = 1024 * 1024  // search_text 跳过大文件(1MB)
const CMD_TIMEOUT_DEFAULT = 120    // run_command 默认超时(秒)
const CMD_TIMEOUT_MAX = 600        // run_command 超时上限(秒)

// 目录遍历时跳过的目录名(产物/依赖/VCS)
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  'coverage', '.next', '.nuxt', '.cache', 'target', 'vendor',
  '__pycache__', '.idea', '.vscode',
])

// search_text 跳过的二进制/资源扩展名
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.mp3', '.wav', '.ogg', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.tar', '.gz',
  '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.lock', '.min.js',
  '.map', '.jar', '.class', '.pyc',
])

// ──────────────────────────────────────────────
// 工具 schema(OpenAI function calling 格式)
// ──────────────────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统默认 shell 执行一条命令(Windows 为 cmd.exe,POSIX 为 /bin/sh)。可用于构建、测试、安装依赖、git 操作(add/commit/push)、查看系统信息等。命令以当前用户权限运行;会把系统搞崩的命令(格式化、删根目录、关机等)会被安全守卫拒绝。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的完整命令行' },
          cwd: { type: 'string', description: '执行目录,默认是智能体启动目录;可传任意绝对/相对路径' },
          timeout_seconds: { type: 'number', description: `超时秒数,默认 ${CMD_TIMEOUT_DEFAULT},最大 ${CMD_TIMEOUT_MAX}` },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文本文件内容,带行号返回。大文件用 offset/limit 分段读取。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径(相对智能体启动目录或绝对路径)' },
          offset: { type: 'number', description: '起始行(1 起始),默认 1' },
          limit: { type: 'number', description: `最多读取行数,默认 ${MAX_READ_LINES}` },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或整体覆盖写入一个文件(父目录不存在会自动创建)。适合新建文件或小文件整体改写;大文件局部修改请用 edit_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '完整文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '对文件做精确字符串替换:old_string 必须与文件内容完全一致(含缩进/换行)且默认要求唯一匹配。修改前先 read_file 确认原文。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的原始文本(精确匹配)' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '为 true 时替换所有出现位置;默认 false,要求 old_string 唯一' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '递归列出目录内容(跳过 node_modules/.git/dist 等产物目录),返回带缩进的树状列表。用于快速了解项目结构。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径,默认智能体启动目录' },
          depth: { type: 'number', description: '递归深度,默认 2,最大 6' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '搜索正则匹配的行,返回 文件:行号: 内容。path 可以是目录(递归搜全部文本文件)或单个文件。用于定位符号、关键字、调用点。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式(JavaScript 语法)' },
          path: { type: 'string', description: '搜索目录或单个文件路径,默认智能体启动目录' },
          ext: { type: 'string', description: '限定扩展名过滤,如 "js" 或 "js,ts,vue";不传则搜全部文本文件' },
          ignore_case: { type: 'boolean', description: '忽略大小写,默认 false' },
        },
        required: ['pattern'],
      },
    },
  },
]

// ──────────────────────────────────────────────
// 内部工具函数
// ──────────────────────────────────────────────

// 相对 ctx.cwd 解析路径;绝对路径原样保留(用户授权了任意目录访问)
function resolvePath(ctx, p) {
  if (!p || typeof p !== 'string') return ctx.cwd
  return path.resolve(ctx.cwd, p)
}

// 头 + 尾截断:超过 budget 时保留前 head 字符 + 后 tail 字符
function truncateMiddle(text, budget) {
  if (!text || text.length <= budget) return text || ''
  const head = Math.floor(budget * 0.4)
  const tail = budget - head
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n\n... [中间省略 ${omitted} 字符] ...\n\n${text.slice(text.length - tail)}`
}

// 子进程输出解码:Windows cmd/PowerShell 的本地化消息(错误提示等)是
// GBK(CP936) 字节流,直接按 UTF-8 解会变成 '����' 乱码(实测踩坑)。
// 策略:先严格 UTF-8 解码(node/git 等现代工具的输出都能过),
// 失败(含非法字节序列,GBK 中文几乎必挂)再按 GBK 兜底。
function decodeOutput(buf) {
  if (!buf || buf.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return iconv.decode(buf, 'gbk')
  }
}

// 包装 exec 为 Promise,stdout/stderr 合并返回;出错(非零退出)也正常返回输出
// encoding:'buffer' 拿原始字节,由 decodeOutput 决定真实编码
function execCommand(command, options) {
  return new Promise((resolve) => {
    const child = exec(command, { ...options, encoding: 'buffer' }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        killed: !!err?.killed,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        errorMessage: err && !('code' in err) ? err.message : null,
      })
    })
    trackChild(child)
    // 把 child 暴露给 agent 循环,支持用户 Ctrl+C 时立即中止当前命令
    if (typeof options.onChild === 'function') options.onChild(child)
  })
}

// ──────────────────────────────────────────────
// 各工具实现
// ──────────────────────────────────────────────

async function toolRunCommand(args, ctx) {
  const command = String(args.command || '').trim()
  if (!command) return '错误: command 不能为空'

  // 红线检查 — 唯一硬性限制
  const danger = checkDangerousCommand(command)
  if (danger.blocked) {
    return `已拒绝执行(安全守卫): ${danger.reason}\n命令: ${command}\n如果你确认需要类似效果,请换一种不破坏系统的方式,或明确告知用户需要他手动执行。`
  }

  const cwd = resolvePath(ctx, args.cwd)
  let timeoutSec = Number(args.timeout_seconds) || CMD_TIMEOUT_DEFAULT
  timeoutSec = Math.max(1, Math.min(CMD_TIMEOUT_MAX, timeoutSec))

  // 验证 cwd 存在,避免 exec 抛模糊错误
  try {
    const st = await fs.stat(cwd)
    if (!st.isDirectory()) return `错误: 执行目录不是目录: ${cwd}`
  } catch {
    return `错误: 执行目录不存在: ${cwd}`
  }

  const result = await execCommand(command, {
    cwd,
    timeout: timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
    onChild: ctx.onChild,
  })

  const parts = []
  if (result.killed) parts.push(`[命令超时被终止(>${timeoutSec}s)]`)
  if (result.stdout) parts.push(result.stdout.trimEnd())
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
  if (result.errorMessage) parts.push(`[执行错误] ${result.errorMessage}`)
  const output = parts.join('\n').trim()

  return [
    `$ ${command}`,
    `(exit ${result.code})`,
    output ? truncateMiddle(output, MAX_CMD_OUTPUT) : '(无输出)',
  ].join('\n')
}

async function toolReadFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    return `错误: 无法读取 ${filePath}: ${err.message}`
  }
  const lines = raw.split('\n')
  const total = lines.length
  const offset = Math.max(1, Number(args.offset) || 1)
  const limit = Math.max(1, Math.min(MAX_READ_LINES, Number(args.limit) || MAX_READ_LINES))
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((line, i) => {
    const text = line.length > MAX_LINE_WIDTH ? line.slice(0, MAX_LINE_WIDTH) + ' ...[行截断]' : line
    return `${offset + i}→${text}`
  })
  const header = total > limit
    ? `# ${filePath} (共 ${total} 行, 显示 ${offset}-${offset + slice.length - 1})`
    : `# ${filePath} (共 ${total} 行)`
  return `${header}\n${numbered.join('\n')}`
}

async function toolWriteFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  const content = String(args.content ?? '')
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `已写入 ${filePath} (${content.length} 字符)`
  } catch (err) {
    return `错误: 写入 ${filePath} 失败: ${err.message}`
  }
}

async function toolEditFile(args, ctx) {
  const filePath = resolvePath(ctx, args.path)
  const oldStr = String(args.old_string ?? '')
  const newStr = String(args.new_string ?? '')
  if (!oldStr) return '错误: old_string 不能为空'
  if (oldStr === newStr) return '错误: old_string 与 new_string 相同,无需修改'

  let raw
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    return `错误: 无法读取 ${filePath}: ${err.message}`
  }

  // 统计出现次数(手写 indexOf 循环,避免正则转义问题)
  let count = 0
  let idx = raw.indexOf(oldStr)
  while (idx !== -1) {
    count++
    idx = raw.indexOf(oldStr, idx + oldStr.length)
  }

  if (count === 0) {
    return `错误: 在 ${filePath} 中找不到 old_string。请先用 read_file 确认文件的精确内容(注意缩进/换行/空白必须完全一致)。`
  }
  if (count > 1 && !args.replace_all) {
    return `错误: old_string 在 ${filePath} 中出现 ${count} 次,不唯一。请提供更多上下文让它唯一,或显式传 replace_all=true 全部替换。`
  }

  const updated = args.replace_all ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr)
  try {
    await fs.writeFile(filePath, updated, 'utf-8')
    return `已修改 ${filePath} (替换 ${args.replace_all ? count : 1} 处)`
  } catch (err) {
    return `错误: 写入 ${filePath} 失败: ${err.message}`
  }
}

async function toolListFiles(args, ctx) {
  const dir = resolvePath(ctx, args.path)
  const maxDepth = Math.max(1, Math.min(6, Number(args.depth) || 2))
  const entries = []
  let overflow = false

  async function walk(current, depth, prefix) {
    if (entries.length >= MAX_LIST_ENTRIES) { overflow = true; return }
    let items
    try {
      items = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      entries.push(`${prefix}[无法读取: ${err.message}]`)
      return
    }
    // 目录在前,文件在后,各自按名字排序
    items.sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) { overflow = true; return }
      if (item.isDirectory()) {
        // 跳过产物/依赖/隐藏目录,避免列表被 node_modules 之类淹没
        if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
        entries.push(`${prefix}${item.name}/`)
        if (depth < maxDepth) await walk(path.join(current, item.name), depth + 1, `${prefix}  `)
      } else {
        entries.push(`${prefix}${item.name}`)
      }
    }
  }

  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return `错误: 不是目录: ${dir}`
  } catch {
    return `错误: 目录不存在: ${dir}`
  }

  await walk(dir, 1, '')
  const suffix = overflow ? `\n... [超过 ${MAX_LIST_ENTRIES} 条,已截断,请缩小 depth 或指定子目录]` : ''
  return `# ${dir}\n${entries.join('\n')}${suffix}`
}

async function toolSearchText(args, ctx) {
  const dir = resolvePath(ctx, args.path)
  let regex
  try {
    regex = new RegExp(String(args.pattern), args.ignore_case ? 'i' : '')
  } catch (err) {
    return `错误: 正则无效: ${err.message}`
  }
  const extFilter = args.ext
    ? new Set(String(args.ext).split(',').map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))
    : null

  const hits = []
  let scanned = 0
  let overflow = false

  // 在单个文件内匹配各行(path 直接指向文件时走这个分支 ——
  // 模型经常拿文件路径来搜,兼容掉,别让它吃"不是目录"的错)
  async function searchOneFile(full) {
    let text
    try { text = await fs.readFile(full, 'utf-8') } catch { return }
    scanned++
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i])) {
        hits.push(`${path.relative(ctx.cwd, full) || full}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
      }
    }
  }

  async function walk(current, depth) {
    if (hits.length >= MAX_SEARCH_HITS || depth > 12) { if (depth > 12) return; overflow = true; return }
    let items
    try { items = await fs.readdir(current, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (hits.length >= MAX_SEARCH_HITS) { overflow = true; return }
      const full = path.join(current, item.name)
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name) || item.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else {
        const ext = path.extname(item.name).toLowerCase()
        if (BINARY_EXTS.has(ext) || BINARY_EXTS.has(item.name.toLowerCase())) continue
        if (extFilter && !extFilter.has(ext.replace('.', ''))) continue
        let st
        try { st = await fs.stat(full) } catch { continue }
        if (st.size > MAX_SEARCH_FILE_SIZE) continue
        await searchOneFile(full)
      }
    }
  }

  let st
  try {
    st = await fs.stat(dir)
  } catch {
    return `错误: 路径不存在: ${dir}`
  }
  // 文件:直接搜它自己(忽略 ext 过滤 — 用户/模型明确指名了这个文件)
  if (!st.isDirectory()) {
    if (st.size > MAX_SEARCH_FILE_SIZE) return `错误: 文件过大(${(st.size / 1024 / 1024).toFixed(1)}MB),请用 read_file 分段查看`
    await searchOneFile(dir)
    if (hits.length === 0) return `未找到匹配 "${args.pattern}" 的内容(已扫描 1 个文件)`
    return hits.join('\n')
  }

  await walk(dir, 1)
  if (hits.length === 0) return `未找到匹配 "${args.pattern}" 的内容(已扫描 ${scanned} 个文件)`
  const suffix = overflow ? `\n... [超过 ${MAX_SEARCH_HITS} 条命中,已截断,请缩小范围或加 ext 过滤]` : ''
  return `${hits.join('\n')}${suffix}`
}

// ──────────────────────────────────────────────
// 工具分发
// ──────────────────────────────────────────────
const TOOL_HANDLERS = {
  run_command: toolRunCommand,
  read_file: toolReadFile,
  write_file: toolWriteFile,
  edit_file: toolEditFile,
  list_files: toolListFiles,
  search_text: toolSearchText,
}

/**
 * 执行一个工具调用,返回字符串结果(直接作为 role:'tool' 消息内容)。
 * 所有异常都在内部消化成字符串,不向外抛。
 *
 * @param {string} name - 工具名
 * @param {object} args - 已解析的参数对象
 * @param {{ cwd: string, onChild?: (child: object) => void }} ctx
 */
export async function executeTool(name, args, ctx) {
  const handler = TOOL_HANDLERS[name]
  if (!handler) return `错误: 未知工具 "${name}",可用工具: ${Object.keys(TOOL_HANDLERS).join(', ')}`
  try {
    return await handler(args || {}, ctx)
  } catch (err) {
    return `错误: 工具 ${name} 执行异常: ${err.message}`
  }
}

export default { TOOL_DEFINITIONS, executeTool }
