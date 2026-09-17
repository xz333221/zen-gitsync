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
// git 进程退出码 → 用户看得懂的失败原因。
//
// 背景：git 自己报错时 stderr 里有 `fatal: ...` 这类可读信息，直接透传就够。
// 但进程**根本没跑起来**的时候（被 Windows 加载器拒绝初始化、被信号杀掉），
// stdout/stderr 是空的，界面只能显示 `Push failed with code 3221225794` ——
// 用户既看不懂码，也无从判断该不该重试。
//
// 实测报障（zen-gitsync）：git push 一段进度都没打出来就挂掉，stdout/stderr 全空，
// 退出码 0xC0000142。同一个请求里几毫秒前的 `git rev-parse` 还是好的，事后复现不了 ——
// 属于 Windows 上已知的瞬时进程初始化失败（DLL 加载失败），重试即可恢复。
// 所以文案的重点是「这不是仓库的问题，直接重试」，而不是甩一个十六进制码。

// Windows NTSTATUS 码表。键是**无符号 DWORD** —— Node 把退出码原样返回，
// 3221225794 就是 0xC0000142，不会转成负数，所以这里不能用有符号比较。
const WINDOWS_EXIT_CODES = new Map([
  // STATUS_DLL_INIT_FAILED —— 加载器初始化 DLL 失败，进程连 main() 都没进
  [0xC0000142, {
    errorCode: 'PROCESS_INIT_FAILED',
    error: '未能启动 git 进程（Windows 错误 0xC0000142：系统加载 DLL 失败）。这通常是系统的一次性瞬时故障，不是仓库的问题——请直接重试推送。'
  }],
  // STATUS_DLL_NOT_FOUND —— Git 安装缺文件 / 依赖 DLL 丢失
  [0xC0000135, {
    errorCode: 'PROCESS_DLL_NOT_FOUND',
    error: '未能启动 git 进程（Windows 错误 0xC0000135：缺少依赖 DLL）。请检查 Git 安装是否完整，必要时重装 Git for Windows。'
  }],
  // STATUS_NO_MEMORY —— 系统提交内存不足，进程起不来
  [0xC0000017, {
    errorCode: 'PROCESS_NO_MEMORY',
    error: '系统内存不足，git 进程未能启动（Windows 错误 0xC0000017）。请关闭一些程序后重试。'
  }],
  // STATUS_ACCESS_VIOLATION —— 除 0xC0000142 外最常见的「进程秒退」
  [0xC0000005, {
    errorCode: 'PROCESS_CRASHED',
    error: 'git 进程崩溃（Windows 错误 0xC0000005：访问冲突），没有产生任何输出。请重试；若反复出现，检查安全软件是否拦截了 git。'
  }],
  // STATUS_CONTROL_C_EXIT —— 被 Ctrl+C / 被 kill 中断，不是故障
  [0xC000013A, {
    errorCode: 'PROCESS_INTERRUPTED',
    error: '推送已被中断（Windows 错误 0xC000013A）。'
  }]
])

// spawn 直接失败（PATH 里没有 git.exe）。与退出码无关，是另一条路径 ——
// 走 child_process 的 'error' 事件而不是 'close'，所以单独给一份。
export const GIT_NOT_FOUND = {
  errorCode: 'GIT_NOT_FOUND',
  error: '找不到 git 命令，请先安装 Git 并确保它在 PATH 中。'
}

/**
 * 退出码 → 展示形式。
 *
 * Windows 的 NTSTATUS 在 Node 里是 3221225794 这种无符号 DWORD，十进制对用户没有意义；
 * 转成 0xC0000142 才能和系统错误码、搜索结果对上。正常退出码（0/128/...）保持十进制。
 *
 * @param {number|null|undefined} code
 * @returns {string} 例如 '0xC0000142'
 */
export function formatExitCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return String(code)
  const unsigned = code >>> 0
  return unsigned >= 0x80000000 ? `0x${unsigned.toString(16).toUpperCase()}` : String(unsigned)
}

/**
 * 已知的进程级退出码 → 用户提示。未知返回 null（交给调用方兜底）。
 *
 * @param {number|null|undefined} code
 * @returns {{errorCode: string, error: string}|null}
 */
export function describeGitExitCode(code) {
  if (typeof code !== 'number') return null
  const hit = WINDOWS_EXIT_CODES.get(code >>> 0)
  return hit ? { ...hit } : null
}

/**
 * 生成「git 进程失败」的展示文案 + 机器可读错误码。
 *
 * 优先级：git 自己的输出 > 退出码映射 > 兜底文案。
 * git 有输出时一律透传 —— stderr 里的 `fatal: ...` 永远比任何翻译都准确，
 * 映射只负责「零输出」这种 git 连话都没说出来的情况。
 *
 * @param {{ code?: number|null, stdout?: string, stderr?: string }} params
 * @returns {{ error: string, errorCode: string|null, exitCode: number|null }}
 */
export function describeGitProcessFailure({ code = null, stdout = '', stderr = '' } = {}) {
  const gitOutput = String(stderr || '').trim() || String(stdout || '').trim()
  if (gitOutput) {
    // git 自己说了话，errorCode 留空 —— 前端据此走「原样展示」，不会覆盖成通用文案
    return { error: gitOutput, errorCode: null, exitCode: code }
  }

  const known = describeGitExitCode(code)
  if (known) return { ...known, exitCode: code }

  return {
    errorCode: 'PROCESS_EXITED',
    exitCode: code,
    error: `git 进程异常退出（退出码 ${formatExitCode(code)}），且没有产生任何输出——通常是进程未能成功启动，请重试。`
  }
}
