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
// 这条链路（简单任务连续对话 / 执行日志详情）的执行者有 claude / opencode 两种
// （taskRunner 双执行器，job.agent 记录本轮实际用的是谁），头像按 job.agent 切换，
// 都用 zen-ai-chat-ui 内置品牌头像（0.1.0-beta.8 起提供 13 个，见 dist/avatars）。
//
// resolveAvatar 的语义是「透传」：命中内置键名返回内联 data URL（运行时零网络请求），
// 未命中则原样返回。所以将来要换成按模型动态取头像，只需把入参换掉：
//   resolveAvatar(modelKey)   // 'claude' | 'openai' | 'gemini' | ...
//
// 注意：zen-ai-chat-ui 的组件不会自己解析键名 —— 直接把 'claude' 传给
// :assistant-avatar 会变成一个坏掉的 <img src="claude">，必须在调用侧先 resolve。

import { resolveAvatar } from 'zen-ai-chat-ui'

/** Claude Code 品牌头像（内联 data URL）。WorkbenchView 简单任务对话与 JobLogDetails 共用。 */
export const CLAUDE_AVATAR = resolveAvatar('claude')
/** OpenCode 品牌头像（内联 data URL）。 */
export const OPENCODE_AVATAR = resolveAvatar('opencode')

/** 按执行器 id 取头像；未知执行器回落 Claude（与标签口径一致）。 */
export function avatarForExecutor(agent?: string | null): string {
  return agent === 'opencode' ? OPENCODE_AVATAR : CLAUDE_AVATAR
}
