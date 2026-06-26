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
// --cmd= 自定义命令的输入校验与执行模式选择。
// 抽到独立模块是为了集中 SEC-CLI-1 的对策,便于单测和复用。
//
// 设计原则:
//   1. **不破坏向后兼容**:`g:test-cmd="echo hello | wc -l"` 这种合法用法必须能跑
//   2. **检测而非阻止**:本地 CLI 工具,用户明确输入,主要拦截意外/恶意输入
//   3. **严格模式可显式启用**:--cmd-strict 走 execFile 拆 argv,无 shell 特性

/**
 * 自定义命令的最大允许长度 — 防止误粘贴巨型 base64 等
 */
export const MAX_CUSTOM_CMD_LENGTH = 1000

/**
 * 检测输入校验结果
 * @typedef {Object} CmdValidation
 * @property {boolean} ok - 是否可继续执行
 * @property {string[]} warnings - 风险提示(不阻止,仅 console.warn)
 * @property {string} [rejectReason] - 不可执行的硬性原因(null/undefined 表示允许)
 */

/**
 * 校验 --cmd= 的输入
 *
 * 校验项:
 *   - 必须是非空字符串
 *   - 不能以 - 开头(看起来像选项,容易被 exec 误解析或 git 误接收)
 *   - 长度不超过 MAX_CUSTOM_CMD_LENGTH
 *   - 包含明显危险模式时打 warning(不阻止):rm -rf / · fork bomb · chmod -R 777 /
 *
 * @param {unknown} cmd - 来自 argv 的命令字符串
 * @returns {CmdValidation}
 */
export function validateCustomCommand(cmd) {
  const warnings = []
  if (typeof cmd !== 'string') {
    return { ok: false, warnings, rejectReason: '命令必须是字符串' }
  }
  const trimmed = cmd.trim()
  if (trimmed.length === 0) {
    return { ok: false, warnings, rejectReason: '命令不能为空' }
  }
  if (cmd.length > MAX_CUSTOM_CMD_LENGTH) {
    return {
      ok: false,
      warnings,
      rejectReason: `命令过长(${cmd.length} > ${MAX_CUSTOM_CMD_LENGTH} 字符),可能是误粘贴`
    }
  }
  // 以 - 开头容易被 exec 解析成 flag 而非命令
  if (trimmed.startsWith('-')) {
    return {
      ok: false,
      warnings,
      rejectReason: '命令不能以 - 开头(避免被误解析为选项)'
    }
  }
  // 危险模式检测 — 仅警告不阻止,因为这是本地 CLI,用户明确输入
  if (/\brm\s+(-\w+\s+)*\/(?:\s|$|\*)/.test(trimmed)) {
    warnings.push('检测到 `rm -<flag> /` 模式,确认这不是误输入?')
  }
  if (/:?\(?\)\s*\{.*:\|:.*\}/.test(trimmed)) {
    warnings.push('检测到 fork bomb 模式(:(){ :|:& };:),确定要执行?')
  }
  if (/\bchmod\s+(-\w+\s+)*\s*777\s+\//.test(trimmed)) {
    warnings.push('检测到 `chmod 777 /` 模式,会放开根目录权限')
  }
  return { ok: true, warnings }
}

/**
 * 判断是否启用严格模式(--cmd-strict 表示禁用 shell 特性)
 *
 * @param {readonly string[]} argv
 * @returns {boolean}
 */
export function isCmdStrictMode(argv) {
  if (!Array.isArray(argv)) return false
  return argv.includes('--cmd-strict')
}