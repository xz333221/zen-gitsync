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
import { $t } from '@/lang/static'

/**
 * 推送失败的展示文案。
 *
 * 后端 `gitExitCode.js` 会把「git 进程没跑起来」的退出码翻成中文并带上 `errorCode`，
 * 这里按 errorCode 换成当前语言的文案 —— 后端那份是中文兜底（命令历史 / 未知 errorCode 时用）。
 *
 * 背景：`git push` 进程被 Windows 加载器拒绝初始化时 stdout/stderr 全空，
 * 以前界面只显示 `Push failed with code 3221225794`，用户既看不懂也不知道该不该重试。
 */

export interface PushFailurePayload {
  /** 后端给的中文文案（已翻译过，或 git 自己的 fatal: ...） */
  error?: string
  /** 后端 gitExitCode.js 的错误码；git 自己有输出时为 null */
  errorCode?: string | null
  /** 进程退出码，仅 PROCESS_EXITED 兜底文案需要拿它拼十六进制 */
  exitCode?: number | null
}

/**
 * errorCode → 文案生成器。
 *
 * 刻意写成函数体内的字面量 `$t(...)` 调用，而不是 `{ errorCode: 'key 字符串' }` 数据表 ——
 * `scripts/verify-i18n-keys.mjs` 只识别源码里的 `$t(<字符串字面量>)` / `labelKey: '<字符串>'` 两种写法
 * （它不剥注释，所以这里也不能写出完整的调用示例，否则会被当成一个真实的 key），
 * 写成数据表的话 key 打错字不会被任何检查发现，界面会直接把原始 key 露给用户。
 *
 * 命名空间沿用推送弹窗的 @PUSH（这份文案的主要展示位）。有 git 自己的输出时后端不给
 * errorCode，这里自然退回原样展示 —— 见后端 gitExitCode.js 里的优先级约定。
 */
const FAILURE_MESSAGES: Record<string, (data: PushFailurePayload) => string> = {
  PROCESS_INIT_FAILED: () => $t('@PUSH:未能启动 git 进程（Windows 错误 0xC0000142：系统加载 DLL 失败）。这通常是系统的一次性瞬时故障，不是仓库的问题——请直接重试推送。'),
  PROCESS_DLL_NOT_FOUND: () => $t('@PUSH:未能启动 git 进程（Windows 错误 0xC0000135：缺少依赖 DLL）。请检查 Git 安装是否完整，必要时重装 Git for Windows。'),
  PROCESS_NO_MEMORY: () => $t('@PUSH:系统内存不足，git 进程未能启动（Windows 错误 0xC0000017）。请关闭一些程序后重试。'),
  PROCESS_CRASHED: () => $t('@PUSH:git 进程崩溃（Windows 错误 0xC0000005：访问冲突），没有产生任何输出。请重试；若反复出现，检查安全软件是否拦截了 git。'),
  PROCESS_INTERRUPTED: () => $t('@PUSH:推送已被中断（Windows 错误 0xC000013A）。'),
  GIT_NOT_FOUND: () => $t('@PUSH:找不到 git 命令，请先安装 Git 并确保它在 PATH 中。'),
  // 退出码不在码表里，但同样是"零输出"——把码带上，用户报障时至少有个抓手
  PROCESS_EXITED: (data) => $t('@PUSH:git 进程异常退出（退出码 {code}），且没有产生任何输出——通常是进程未能成功启动，请重试。', {
    code: formatExitCode(data.exitCode)
  })
}

/**
 * 退出码 → 0xC0000142 这种十六进制（NTSTATUS）或十进制。
 * 与后端 gitExitCode.js 的 formatExitCode 保持一致：无符号 DWORD，转了才能对上系统错误码。
 */
export function formatExitCode(code?: number | null): string {
  if (typeof code !== 'number' || !Number.isFinite(code)) return String(code)
  const unsigned = code >>> 0
  return unsigned >= 0x80000000 ? `0x${unsigned.toString(16).toUpperCase()}` : String(unsigned)
}

/**
 * 把后端返回的失败载荷变成给用户看的文案。
 * 优先级：已知 errorCode 的本地化文案 > 后端文案 > 通用兜底。
 */
export function describePushFailure(data: PushFailurePayload | null | undefined): string {
  if (!data) return $t('@PUSH:未知错误')

  const build = data.errorCode ? FAILURE_MESSAGES[data.errorCode] : undefined
  if (build) return build(data)

  return data.error || $t('@PUSH:未知错误')
}
