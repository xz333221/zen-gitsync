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
// 纯函数工具 — 与 git 子进程、IO、网络均无关,易于单测;
// 抽到独立文件是为了让 utils/index.js 聚焦 git 包装,体积减小一半以上。

/**
 * 从 argv 数组里解析出 --path / --cwd 的值
 * 严格匹配 `--path` / `--path=<v>` / `--cwd` / `--cwd=<v>`,避免误匹配 `--pathTo=...`
 *
 * @param {readonly string[]} argv - 类似 process.argv 的参数数组
 * @returns {string | null} 解析到的值,没匹配到返回 null
 */
export function parseCwdArg(argv) {
  if (!Array.isArray(argv)) return null
  const cwdArg = argv.find((arg) => {
    if (typeof arg !== 'string') return false
    if (arg === '--path' || arg === '--cwd') return true
    return arg.startsWith('--path=') || arg.startsWith('--cwd=')
  })
  if (!cwdArg) return null
  const eqIdx = cwdArg.indexOf('=')
  if (eqIdx >= 0) {
    const value = cwdArg.slice(eqIdx + 1)
    return value || null
  }
  // 空格分隔形式: `--path <value>`,取下一个 argv
  const next = argv[argv.indexOf(cwdArg) + 1]
  return next || null
}

/**
 * 按 char 边界安全截断,避免切断 UTF-16 代理对(emoji / 辅助平面 CJK)。
 * 原 substring(0, N) 在 N-1 是 high surrogate 时会把半个字符拼到末尾,
 * 前端 history 渲染可能显示 '�'。本函数检测这种情况并向前回退 1 个码元。
 *
 * @param {string} str
 * @param {number} limit - 最大字符数(<=0 视为"不截断",原样返回)
 * @param {string} suffix - 截断提示后缀
 * @returns {string}
 */
export function truncateForHistory(str, limit, suffix) {
  if (typeof str !== 'string') return str
  if (!Number.isFinite(limit) || limit <= 0 || str.length <= limit) return str
  // 码元 = UTF-16 code unit;length 已经是码元数,但 surrogate pair 占 2 个码元。
  const cutAt = limit
  const code = str.charCodeAt(cutAt - 1)
  // 0xD800–0xDBFF = high surrogate,后面必须跟 low surrogate 才完整;
  // 如果在 limit 处正好停在 high surrogate,回退一格避免半个 emoji/罕见汉字。
  if (code >= 0xD800 && code <= 0xDBFF) {
    return str.substring(0, cutAt - 1) + suffix
  }
  return str.substring(0, cutAt) + suffix
}

/**
 * 把毫秒时长格式化为中文 d天h小时m分s秒(各部分为 0 时省略)
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0秒'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / (3600 * 24))
  const hours = Math.floor((totalSeconds % (3600 * 24)) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [
    days && `${days}天`,
    hours && `${hours}小时`,
    minutes && `${minutes}分`,
    `${seconds}秒`
  ].filter(Boolean).join('')
}

/**
 * sleep N ms — 取代 npm scripts 里的 `sleep || ping -n 127` 跨平台 hack,
 * Node 原生 API,Linux/macOS/Windows 一致。
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}