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
// buildJobReasoningTiming 的单测。
//
// 这层折算的失败方式很安静：ThinkingBlock 拿不到时间戳就什么都不显示
// （这正是期望行为），所以"映射写错了"与"这轮没思考过"在界面上长得一样。
// 锁四条边界：
//   1. 正常：ISO 字符串 → 毫秒时间戳，两个字段都给
//   2. 起点拿不到（老 job / 这轮没思考过 / 没思考完就被取消）→ 空对象，一个字段都不给
//   3. 值非法（空串 / 不是时间）→ 当作拿不到，不能让 ThinkingBlock 拿到 NaN
//   4. 只有起点没有终点（流式进行中）→ 只给起点，库那边靠它实时跳

import { describe, expect, test } from 'vitest'
import type { Job } from '@/types/workbench'
import { buildJobReasoningTiming } from './jobReasoningTiming'

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

describe('buildJobReasoningTiming', () => {
  test('正常：ISO 字符串折算成毫秒时间戳，两个字段都给', () => {
    const timing = buildJobReasoningTiming(makeJob({
      thinkingStartedAt: '2026-10-08T01:00:00.000Z',
      thinkingEndedAt: '2026-10-08T01:00:04.200Z'
    }))
    expect(timing.reasoningStartedAt).toBe(Date.parse('2026-10-08T01:00:00.000Z'))
    expect(timing.reasoningEndedAt).toBe(Date.parse('2026-10-08T01:00:04.200Z'))
  })

  test('只有起点（流式进行中）→ 只给起点：库那边靠它实时跳、不用终点', () => {
    const timing = buildJobReasoningTiming(makeJob({
      thinkingStartedAt: '2026-10-08T01:00:00.000Z',
      thinkingEndedAt: null
    }))
    expect(timing.reasoningStartedAt).toBe(Date.parse('2026-10-08T01:00:00.000Z'))
    expect(timing.reasoningEndedAt).toBeUndefined()
  })

  test('起点拿不到 → 空对象（老 job / 这轮没思考过，一个字段都不给）', () => {
    expect(buildJobReasoningTiming(makeJob())).toEqual({})
    expect(buildJobReasoningTiming(makeJob({ thinkingStartedAt: null, thinkingEndedAt: null }))).toEqual({})
    // 终点单独存在没有意义 —— 起点是硬前提
    expect(buildJobReasoningTiming(makeJob({ thinkingEndedAt: '2026-10-08T01:00:04.200Z' }))).toEqual({})
    expect(buildJobReasoningTiming(null)).toEqual({})
    expect(buildJobReasoningTiming(undefined)).toEqual({})
  })

  test('非法值当作拿不到（空串 / 不是时间），不能把 NaN 传给 ThinkingBlock', () => {
    expect(buildJobReasoningTiming(makeJob({ thinkingStartedAt: '' }))).toEqual({})
    expect(buildJobReasoningTiming(makeJob({ thinkingStartedAt: '不是时间' }))).toEqual({})
    const timing = buildJobReasoningTiming(makeJob({
      thinkingStartedAt: '2026-10-08T01:00:00.000Z',
      thinkingEndedAt: 'garbage'
    }))
    expect(timing.reasoningStartedAt).toBe(Date.parse('2026-10-08T01:00:00.000Z'))
    expect(timing.reasoningEndedAt).toBeUndefined()
  })
})
