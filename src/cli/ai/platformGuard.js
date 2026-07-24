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
// g ai 智能体的平台兼容性守卫 — 拦截"在当前 shell 里注定失败"的命令。
//
// 设计背景:
//   Windows cmd.exe 没有 tail/head/grep/ls/sed/cat 等 Unix 命令,模型(尤其
//   训练数据偏 Unix 的模型)经常写出 `npm test | tail -60` 这类管道,在
//   Windows 上直接报"不是内部或外部命令"。虽然 system prompt 已经提醒过,
//   但模型仍会忽略 —— 本模块在运行时做最后一道防线。
//
// 与 safety.js 的区别:
//   - safety.js 拦截"会把系统搞崩"的命令(硬红线,所有平台)
//   - 本模块拦截"在当前平台注定失败"的命令(软红线,仅检测 + 给替代方案)
//   - 两者互补:safety.js 保命,platformGuard 省时间
//
// 避免误杀策略:
//   不靠命令名硬判,而是先 `where <cmd>` 检查命令是否真的存在于 PATH 中
//   (很多 Windows 开发者装了 Git Bash,tail/grep 等确实可用)。只有确认
//   不存在时才拦截。检查结果按命令名缓存,同一会话内不重复查。

import { exec } from 'node:child_process'

// ──────────────────────────────────────────────
// Unix-only 命令清单 + 跨平台替代方案
// ──────────────────────────────────────────────
// key = 命令名(小写),value = 拦截时回喂给模型的替代方案说明。
// 只收录"Windows cmd.exe 几乎肯定没有"的命令;像 sort/find 这类 Windows
// 自带的(虽然行为不同)不收录,避免误判。
export const UNIX_ONLY_COMMANDS = {
  tail:   'Windows cmd 没有 tail。查看输出末尾:用 PowerShell "命令 | Select-Object -Last 60";查看文件末尾用 read_file 工具(传 offset 靠后)',
  head:   'Windows cmd 没有 head。查看输出开头:直接运行命令即可;查看文件开头用 read_file 工具(offset=1)',
  cat:    'Windows cmd 没有 cat。查看文件用 read_file 工具,或 cmd 的 type 命令',
  grep:   'Windows cmd 没有 grep。搜内容用 search_text 工具,或 cmd 的 findstr 命令',
  ls:     'Windows cmd 没有 ls。列目录用 list_files 工具,或 cmd 的 dir 命令',
  sed:    'Windows cmd 没有 sed。用 node -e "..." 或 PowerShell 做文本替换',
  awk:    'Windows cmd 没有 awk。用 node -e "..." 或 PowerShell 处理文本',
  wc:     'Windows cmd 没有 wc。用 node -e "..." 或 PowerShell 统计行数/字数',
  cut:    'Windows cmd 没有 cut。用 node -e "..." 或 PowerShell 截取字段',
  uniq:   'Windows cmd 没有 uniq。用 node -e "..." 或 PowerShell 去重',
  xargs:  'Windows cmd 没有 xargs。用 PowerShell ForEach-Object,或改写命令逻辑',
  which:  'Windows cmd 没有 which。用 cmd 的 where 命令查找可执行文件',
  touch:  'Windows cmd 没有 touch。用 node -e "require(\'fs\').writeFileSync(\'file\',\'\')" 或 PowerShell "New-Item -Type File"',
}

// ──────────────────────────────────────────────
// 纯函数:命令段解析(便于单测)
// ──────────────────────────────────────────────

/**
 * 将命令串按管道/链式操作符切分为段。
 * 与 safety.js 的 splitCommandSegments 逻辑一致,但独立维护(两个模块各有侧重)。
 * @param {string} cmd
 * @returns {string[]} 去空白后的命令段
 */
export function splitCommandSegments(cmd) {
  return String(cmd).split(/&&|\|\||[;|]/).map(s => s.trim()).filter(Boolean)
}

/**
 * 从一个命令段中提取命令名(第一个 token,去掉 sudo/doas 前缀)。
 * @param {string} seg
 * @returns {string} 小写命令名,可能为空
 */
export function extractCommandName(seg) {
  const m = String(seg).match(/^(?:sudo|doas)\s+(\S+)|^(\S+)/)
  const name = m?.[1] || m?.[2] || ''
  return name.toLowerCase()
}

/**
 * 检测命令串中出现的 Unix-only 命令(纯函数,不查 PATH)。
 *
 * 遍历所有段(管道/链式),返回检测到的 Unix-only 命令名列表。
 * 调用方(如 guardCommand)再决定是否需要查 PATH 确认。
 *
 * @param {string} command - 完整命令行
 * @returns {string[]} 检测到的 Unix-only 命令名(去重,保持出现顺序)
 */
export function detectUnixOnlyCommands(command) {
  if (typeof command !== 'string' || !command.trim()) return []
  const found = []
  const seen = new Set()
  for (const seg of splitCommandSegments(command)) {
    const name = extractCommandName(seg)
    // 去掉可能的路径前缀(如 /usr/bin/tail → tail)
    const base = name.split(/[/\\]/).pop()
    if (UNIX_ONLY_COMMANDS[base] && !seen.has(base)) {
      seen.add(base)
      found.push(base)
    }
  }
  return found
}

// ──────────────────────────────────────────────
// 命令可用性检查(带缓存,仅 Windows 用)
// ──────────────────────────────────────────────

// 缓存:命令名 → true(可用)/ false(不可用)。同一进程内 PATH 不变,缓存安全。
const _availabilityCache = new Map()

/**
 * 清空可用性缓存(测试用)。
 */
export function _clearAvailabilityCache() {
  _availabilityCache.clear()
}

/**
 * 在 Windows 上用 `where <cmd>` 检查命令是否存在于 PATH 中。
 *
 * @param {string} cmdName - 命令名(如 "tail")
 * @param {object} [opts]
 * @param {(cmd: string, opts: object, cb: (err, stdout) => void) => void} [opts.execFn]
 *   可注入的 exec 函数(测试用),默认用 child_process.exec
 * @returns {Promise<boolean>} true = 命令可用;false = 不存在
 */
export async function checkCommandAvailability(cmdName, { execFn } = {}) {
  if (_availabilityCache.has(cmdName)) return _availabilityCache.get(cmdName)
  const _exec = execFn || exec
  return new Promise((resolve) => {
    _exec(`where ${cmdName}`, { windowsHide: true }, (err) => {
      const available = !err
      _availabilityCache.set(cmdName, available)
      resolve(available)
    })
  })
}

// ──────────────────────────────────────────────
// 主接口:平台守卫
// ──────────────────────────────────────────────

/**
 * 检查一条命令在当前平台是否会因命令不存在而注定失败。
 *
 * 仅在 Windows 上生效:检测命令中的 Unix-only 命令,逐个用 `where` 确认
 * 是否可用;不可用的直接拦截并给出跨平台替代方案。
 *
 * 非 Windows 平台直接放行(Unix 命令天然可用)。
 *
 * @param {string} command - 待检查的完整命令行
 * @param {object} [opts]
 * @param {string} [opts.platform=process.platform] - 平台标识(测试用)
 * @param {(cmd: string, opts: object, cb: (err, stdout) => void) => void} [opts.execFn]
 *   可注入的 exec 函数(测试用)
 * @returns {Promise<{ blocked: boolean, reason: string|null }>}
 *   blocked=true 时 reason 给出中文原因 + 替代方案(会回喂给模型)
 */
export async function guardCommand(command, { platform = process.platform, execFn } = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    return { blocked: false, reason: null }
  }
  // 非 Windows 平台:Unix 命令天然可用,不需要守卫
  if (platform !== 'win32') {
    return { blocked: false, reason: null }
  }

  const detected = detectUnixOnlyCommands(command)
  if (detected.length === 0) {
    return { blocked: false, reason: null }
  }

  // 逐个检查检测到的 Unix-only 命令是否真的不存在于 PATH
  const missing = []
  for (const cmdName of detected) {
    const available = await checkCommandAvailability(cmdName, { execFn })
    if (!available) missing.push(cmdName)
  }

  if (missing.length === 0) {
    return { blocked: false, reason: null }
  }

  // 构建拦截原因:列出每个缺失命令的替代方案
  const hints = missing.map(name => `  • ${name}: ${UNIX_ONLY_COMMANDS[name]}`)
  const reason = [
    `当前 Windows 环境(cmd.exe)中不存在以下 Unix 命令,执行会失败:`,
    ...hints,
    '',
    `请改用上述跨平台方案或内置工具,然后重试。`,
    `原始命令: ${command}`,
  ].join('\n')

  return { blocked: true, reason }
}

export default { guardCommand, detectUnixOnlyCommands, checkCommandAvailability, UNIX_ONLY_COMMANDS }
