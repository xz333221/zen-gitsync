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

/**
 * Shell / PowerShell 字符串转义工具
 *
 * 提供三种转义策略:
 *   - shQuote: POSIX shell 单引号包字符串（git add / osascript / gnome-terminal 用）
 *   - psEscape: PowerShell 双引号内安全转义（terminal.js 的 PowerShell 脚本用）
 *   - appleEscape: AppleScript 双引号字符串内安全转义（macOS 终端用）
 *
 * 三种都不依赖外部包，纯字符串操作。
 *
 * @typedef {string | number | null | undefined} ShellInput
 */

/**
 * POSIX shell 单引号包裹
 * 单引号内不解释 $ ` " \,只把单引号自身转义为 '\''
 * 例: shQuote('a"b$c') === "'a\"b$c'"
 *
 * @param {ShellInput} input
 * @returns {string}
 */
export function shQuote(input) {
  if (input === null || input === undefined) return "''"
  return `'${String(input).replace(/'/g, `'\\''`)}'`
}

/**
 * PowerShell 双引号字符串内安全转义
 * 需要把 $ (变量/子表达式) 和 ` (子表达式) 各自前置一个反引号
 * 双引号本身用 "" 转义;反引号自身先用 `` 转义避免吃掉后续转义
 *
 * @param {ShellInput} input
 * @returns {string}
 */
export function psEscape(input) {
  if (input === null || input === undefined) return '""'
  return String(input)
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '""')
}

/**
 * AppleScript 双引号字符串内安全转义
 * 反斜杠和双引号都需要前置反斜杠
 *
 * @param {ShellInput} input
 * @returns {string}
 */
export function appleEscape(input) {
  if (input === null || input === undefined) return '""'
  return String(input).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}