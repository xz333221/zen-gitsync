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
// 工作台对话的助手头像。
//
// 这条链路（任务连续对话 / 执行日志详情）的执行者有 claude / opencode / codex /
// codebuddy / pi / codearts 六种（taskRunner 执行器，job.agent 记录本轮实际用的是谁），头像按
// job.agent 切换。前三家用 zen-ai-chat-ui 内置品牌头像（0.1.0-beta.8 起提供 13 个，
// 见 dist/avatars）；codebuddy 与 pi 不在库里（2026-10-12 / 2026-10-13 先后核对过键名），
// 用自家资源 assets/icons/svg/{codebuddy,pi}.svg 顶上 —— Vite 会把它变成 URL 字符串，
// 与库里 data URL 的消费方式一致（都是 <img src>）。
//
// resolveAvatar 的语义是「透传」：命中内置键名返回内联 data URL（运行时零网络请求），
// 未命中则原样返回。所以将来要换成按模型动态取头像，只需把入参换掉：
//   resolveAvatar(modelKey)   // 'claude' | 'openai' | 'gemini' | ...
//
// 注意：zen-ai-chat-ui 的组件不会自己解析键名 —— 直接把 'claude' 传给
// :assistant-avatar 会变成一个坏掉的 <img src="claude">，必须在调用侧先 resolve。

import { resolveAvatar } from 'zen-ai-chat-ui'
// ?inline 强制 data URL（5.2KB 超 vite 默认 4KB 内联阈值；与 TaskExecutorIcon 同一口径）
import codebuddyAvatar from '@/assets/icons/svg/codebuddy.svg?inline'
// pi 官方标（pi.dev/logo-auto.svg，2026-10-13 随执行器接入一起补）
import piAvatar from '@/assets/icons/svg/pi.svg?inline'
// 码道：华为云标 + 华为红（2026-10-25 随执行器接入一起补）
import codeartsAvatar from '@/assets/icons/svg/codearts.svg?inline'

/** Claude Code 品牌头像（内联 data URL）。WorkbenchView 任务对话与 JobLogDetails 共用。 */
export const CLAUDE_AVATAR = resolveAvatar('claude')
/** OpenCode 品牌头像（内联 data URL）。 */
export const OPENCODE_AVATAR = resolveAvatar('opencode')
/** Codex（OpenAI）品牌头像（内联 data URL）。 */
export const CODEX_AVATAR = resolveAvatar('codex')
/** CodeBuddy Code 品牌头像（自家 SVG 资源，库内置头像里没有它）。 */
export const CODEBUDDY_AVATAR = codebuddyAvatar
/** Pi Agent 品牌头像（自家 SVG 资源，库内置头像里没有它）。 */
export const PI_AVATAR = piAvatar
/** CodeArts 码道品牌头像（自家 SVG 资源，库内置头像里没有它）。 */
export const CODEARTS_AVATAR = codeartsAvatar

/** 按执行器 id 取头像；未知/缺省（老 job 没有 agent 字段）回落 Claude（与标签口径一致）。 */
export function avatarForExecutor(agent?: string | null): string {
  if (agent === 'opencode') return OPENCODE_AVATAR
  if (agent === 'codex') return CODEX_AVATAR
  if (agent === 'codebuddy') return CODEBUDDY_AVATAR
  if (agent === 'pi') return PI_AVATAR
  if (agent === 'codearts') return CODEARTS_AVATAR
  return CLAUDE_AVATAR
}
