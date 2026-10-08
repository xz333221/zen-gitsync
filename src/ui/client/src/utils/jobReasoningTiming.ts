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
// 执行记录（job）→ 对话气泡的「思考段计时」。
//
// 服务端在追加思考分片时记 job.thinkingStartedAt / thinkingEndedAt（ISO 字符串，
// 第一个分片 → 最后一个分片），两个视图（WorkbenchView 任务对话流、JobLogDetails
// 执行日志详情）共享这一份，免得"同一个 job 在一处有时间、另一处没有"。
//
// zen-ai-chat-ui 的 ThinkingBlock 只认 ChatMessage 上的两个**毫秒时间戳**
// （reasoningStartedAt / reasoningEndedAt）：流式期间按起点实时跳、结束后用终点定格。
// 拿不到（老 job、这轮没思考过、值非法）就一个字段都不给 —— 库那边不会显示
// 「—」这类占位，这正是期望行为。

import type { ChatMessage } from 'zen-ai-chat-ui'
import type { Job } from '@/types/workbench'

/** ISO 字符串 → epoch ms；缺省 / 非法 / 老数据一律 undefined */
function isoToMs(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

/**
 * job 的思考段计时 → ChatMessage 的 reasoningStartedAt / reasoningEndedAt。
 *
 * 起点是硬前提（库的推导以 startedAt 为准），它拿不到就整个返回空对象，
 * 调用点直接展开即可，不需要再判。
 */
export function buildJobReasoningTiming(
  job: Job | null | undefined
): Pick<ChatMessage, 'reasoningStartedAt' | 'reasoningEndedAt'> {
  const start = isoToMs(job?.thinkingStartedAt)
  if (start === undefined) return {}
  return {
    reasoningStartedAt: start,
    // 终点交给库自己判（它只接受 end > start 的定格；流式期间根本不用这个值）
    reasoningEndedAt: isoToMs(job?.thinkingEndedAt)
  }
}
