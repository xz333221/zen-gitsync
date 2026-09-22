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
// buildJobToolCalls 的单测。
//
// 这是"执行流里能不能看到模型在干什么"的唯一一层前端映射，锁住四条边界：
//   1. 空值 / 老 job（没有 toolCalls 字段）→ 空数组，不能抛
//   2. 字段平移到 zen-ai-chat-ui 的 ToolCall 形态
//   3. job 已终态但调用还挂着 running → 归一成终态（取消 → error），不能让工具块一直转圈
//   4. 结果文本超长 → 尾部截断（历史数据兜底）

import { describe, expect, test } from 'vitest'
import type { Job } from '@/types/workbench'
import { buildJobToolCalls, MAX_TOOL_RESULT_DISPLAY } from './jobToolCalls'

function makeJob(patch: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    taskId: 't1',
    subId: 't1__simple',
    title: '任务',
    status: 'running',
    output: '',
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    error: null,
    ...patch
  }
}

describe('buildJobToolCalls', () => {
  test('老 job 没有 toolCalls 字段 / 传空 → 空数组', () => {
    expect(buildJobToolCalls(null)).toEqual([])
    expect(buildJobToolCalls(undefined)).toEqual([])
    expect(buildJobToolCalls(makeJob())).toEqual([])
    expect(buildJobToolCalls(makeJob({ toolCalls: [] }))).toEqual([])
  })

  test('字段平移到 ToolCall 形态', () => {
    const job = makeJob({
      toolCalls: [
        {
          id: 'toolu_1',
          name: 'Bash',
          argsPreview: 'npm test',
          arguments: '{"command":"npm test"}',
          result: 'pass',
          status: 'done'
        }
      ]
    })
    expect(buildJobToolCalls(job)).toEqual([
      {
        id: 'toolu_1',
        name: 'Bash',
        argsPreview: 'npm test',
        arguments: '{"command":"npm test"}',
        result: 'pass',
        status: 'done',
        error: undefined
      }
    ])
  })

  test('缺 id / 缺 name / 缺 status 时兜底，不产生 undefined 字段', () => {
    const job = makeJob({ status: 'done', toolCalls: [{ id: '', name: '' } as any] })
    const [call] = buildJobToolCalls(job)
    expect(call.id).toBe('tool-0')
    expect(call.name).toBe('')
    expect(call.argsPreview).toBe('')
    expect(call.arguments).toBe('')
    expect(call.result).toBe('')
    expect(call.status).toBe('done')
  })

  test('job 运行中：调用保持 running（前端继续转圈是正确语义）', () => {
    const job = makeJob({
      status: 'running',
      toolCalls: [{ id: 'a', name: 'Read', status: 'running' }]
    })
    expect(buildJobToolCalls(job)[0].status).toBe('running')
  })

  test('job 已 done 但调用还挂 running → 归一成 done', () => {
    const job = makeJob({
      status: 'done',
      toolCalls: [{ id: 'a', name: 'Read', status: 'running' }]
    })
    expect(buildJobToolCalls(job)[0].status).toBe('done')
  })

  test('job 被取消 / 出错 → 未收尾的调用归一成 error', () => {
    for (const status of ['cancelled', 'error'] as const) {
      const job = makeJob({
        status,
        toolCalls: [{ id: 'a', name: 'Read', status: 'pending' }]
      })
      expect(buildJobToolCalls(job)[0].status).toBe('error')
    }
  })

  test('已完成的调用不受 job 终态影响（不会被改写）', () => {
    const job = makeJob({
      status: 'cancelled',
      toolCalls: [
        { id: 'a', name: 'Read', status: 'done', result: 'ok' },
        { id: 'b', name: 'Read', status: 'error', error: '失败' }
      ]
    })
    const calls = buildJobToolCalls(job)
    expect(calls[0].status).toBe('done')
    expect(calls[1].status).toBe('error')
    expect(calls[1].error).toBe('失败')
  })

  test('超长结果尾部截断并留提示', () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_DISPLAY + 500)
    const job = makeJob({
      status: 'done',
      toolCalls: [{ id: 'a', name: 'Bash', status: 'done', result: long }]
    })
    const [call] = buildJobToolCalls(job)
    expect(call.result!.startsWith('…（前文已截断）')).toBe(true)
    expect(call.result!.length).toBeLessThan(long.length)
    expect(call.result!.endsWith('x'.repeat(10))).toBe(true)
  })
})
