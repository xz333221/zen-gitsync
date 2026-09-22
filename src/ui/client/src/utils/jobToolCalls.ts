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
// 执行记录（job）→ 对话气泡的工具调用块。
//
// 服务端 taskRunner 把 claude / opencode 的 tool_use 事件归一成 job.toolCalls
// （服务端已做参数与结果的截断），这里只做两件事：
//   1. 字段兜底（老 job 没有 toolCalls / 历史数据字段缺失）
//   2. 终态归一（进程都退了还挂在 running 的调用不该在前端一直转圈）
//
// 两个视图（WorkbenchView 任务对话流、JobLogDetails 执行日志详情）共享这一份，
// 免得"同一个 job 在两处显示得不一样"。

import type { ToolCall } from 'zen-ai-chat-ui'
import type { Job, JobToolCall, JobToolCallStatus } from '@/types/workbench'

/** 单条工具结果的展示上限：服务端已经截到 4KB，这里兜历史数据与二次保险 */
export const MAX_TOOL_RESULT_DISPLAY = 8 * 1024

function clip(text: string, max: number): string {
  return text.length > max ? `…（前文已截断）\n${text.slice(-max)}` : text
}

/**
 * job 已是终态时，还挂在 pending / running 的调用归一成终态。
 * 服务端 seal() 正常会收口（取消 → error，其余 → done），这里兜历史数据与异常路径：
 * 一个永远转圈的工具块比"少显示一条"更让人困惑。
 */
function normalizeStatus(status: JobToolCallStatus | undefined, jobStatus: Job['status']): JobToolCallStatus {
  const s = status || 'done'
  if (s !== 'pending' && s !== 'running') return s
  if (jobStatus === 'running' || jobStatus === 'pending') return s
  if (jobStatus === 'cancelled' || jobStatus === 'error') return 'error'
  return 'done'
}

/** 把 job.toolCalls 映射成 zen-ai-chat-ui 的 ToolCall[]（老 job / 空值一律返回空数组） */
export function buildJobToolCalls(job: Job | null | undefined): ToolCall[] {
  const list = job?.toolCalls
  if (!Array.isArray(list) || list.length === 0) return []
  const jobStatus: Job['status'] = job?.status || 'done'
  const out: ToolCall[] = []
  for (let i = 0; i < list.length; i++) {
    const c = list[i] as JobToolCall | null | undefined
    if (!c || typeof c !== 'object') continue
    const status = normalizeStatus(c.status, jobStatus)
    const rawResult = typeof c.result === 'string' ? c.result : ''
    out.push({
      id: typeof c.id === 'string' && c.id ? c.id : `tool-${i}`,
      name: typeof c.name === 'string' ? c.name : '',
      argsPreview: typeof c.argsPreview === 'string' ? c.argsPreview : '',
      arguments: typeof c.arguments === 'string' ? c.arguments : '',
      result: rawResult ? clip(rawResult, MAX_TOOL_RESULT_DISPLAY) : '',
      status,
      error: typeof c.error === 'string' && c.error ? c.error : undefined
    })
  }
  return out
}
