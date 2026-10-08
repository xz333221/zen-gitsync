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
// SSE 事件 → jobs 数组的合并口径（工具调用部分）。
//
// 执行流要"边跑边看到模型在调什么"，靠的就是 job:toolcalls 这条增量。
// 它跟 job:update 的分工必须钉死：
//   - job:toolcalls 是**增量**（按 id 覆盖式合并同一条调用）
//   - job:update    是**整条快照**（数组整体替换）
// 搞反了会同时踩两种坑：增量当快照会丢历史调用，快照当增量会把同一批调用叠成两份。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createTestPinia } from '@/test-utils/createTestPinia'

vi.mock('@/lang/static', () => ({ $t: (key: string) => key }))

import { useWorkbenchData } from './useWorkbenchData'

function makeJob(patch: Record<string, unknown> = {}) {
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

describe('applyJobEvent: job:toolcalls', () => {
  beforeEach(() => createTestPinia())

  test('按 id 覆盖式合并：同一条调用先 running 后 done，只有一条', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    wb.applyJobEvent('job:toolcalls', {
      id: 'j1',
      updates: [{ id: 'toolu_a', name: 'Bash', argsPreview: 'ls -la', status: 'running' }]
    })
    expect(wb.jobs.value[0].toolCalls).toHaveLength(1)
    expect(wb.jobs.value[0].toolCalls![0].status).toBe('running')

    wb.applyJobEvent('job:toolcalls', {
      id: 'j1',
      updates: [{ id: 'toolu_a', name: 'Bash', argsPreview: 'ls -la', status: 'done', result: 'a.js' }]
    })
    expect(wb.jobs.value[0].toolCalls).toHaveLength(1)
    expect(wb.jobs.value[0].toolCalls![0]).toMatchObject({ status: 'done', result: 'a.js' })
  })

  test('不同 id 依次追加，保持调用顺序', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    wb.applyJobEvent('job:toolcalls', {
      id: 'j1',
      updates: [
        { id: 'toolu_a', name: 'Bash', status: 'running' },
        { id: 'toolu_b', name: 'Read', status: 'running' }
      ]
    })
    expect(wb.jobs.value[0].toolCalls!.map(c => c.id)).toEqual(['toolu_a', 'toolu_b'])
  })

  test('增量批次收口：同一条调用可以在一个批次里先 running 后 done', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    wb.applyJobEvent('job:toolcalls', {
      id: 'j1',
      updates: [
        { id: 'toolu_a', name: 'Bash', status: 'running' },
        { id: 'toolu_a', name: 'Bash', status: 'done', result: 'a.js' }
      ]
    })
    expect(wb.jobs.value[0].toolCalls).toHaveLength(1)
    expect(wb.jobs.value[0].toolCalls![0].status).toBe('done')
  })

  test('job 不存在 / 批次为空 / 没带 id 时静默跳过（不能抛，SSE 里什么脏数据都可能有）', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    expect(() => wb.applyJobEvent('job:toolcalls', { id: 'nope', updates: [{ id: 'x', status: 'done' }] })).not.toThrow()
    expect(() => wb.applyJobEvent('job:toolcalls', { id: 'j1', updates: [] })).not.toThrow()
    expect(() => wb.applyJobEvent('job:toolcalls', { id: 'j1' })).not.toThrow()
    expect(() => wb.applyJobEvent('job:toolcalls', { id: 'j1', updates: [null, { name: 'no-id' }] })).not.toThrow()
    expect(wb.jobs.value[0].toolCalls).toBeUndefined()
  })

  test('job:update 是整条快照，直接替换（不跟旧数组合并）', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob({ toolCalls: [{ id: 'old', name: 'Bash', status: 'done' }] })] as never

    wb.applyJobEvent('job:update', makeJob({ status: 'done', toolCalls: [{ id: 'new', name: 'Read', status: 'done' }] }))
    expect(wb.jobs.value[0].toolCalls!.map(c => c.id)).toEqual(['new'])
  })

  test('hello（重连 / 首帧）带来的快照里也带 toolCalls', () => {
    const wb = useWorkbenchData()
    wb.applyJobEvent('hello', {
      jobs: [makeJob({ status: 'done', toolCalls: [{ id: 'toolu_a', name: 'Bash', status: 'done' }] })]
    })
    expect(wb.jobs.value[0].toolCalls).toHaveLength(1)
  })
})

describe('applyJobEvent: job:thinking-delta 的思考段计时打点', () => {
  // 服务端只在起跑 / 终态推整条 job:update，运行中的计时就得靠增量自己打点 ——
  // 不打点的话，折叠态的「思考 x 秒」要等这一轮跑完才出现（思考刚结束时一片空白）。
  beforeEach(() => createTestPinia())

  test('第一个增量记起点，后续增量把终点往前推（起点不再移动）', () => {
    vi.useFakeTimers()
    try {
      const wb = useWorkbenchData()
      wb.jobs.value = [makeJob()] as never

      vi.setSystemTime(new Date('2026-10-08T01:00:00.000Z'))
      wb.applyJobEvent('job:thinking-delta', { id: 'j1', delta: '第一段' })
      expect(wb.jobs.value[0].thinkingStartedAt).toBe('2026-10-08T01:00:00.000Z')
      expect(wb.jobs.value[0].thinkingEndedAt).toBe('2026-10-08T01:00:00.000Z')

      vi.setSystemTime(new Date('2026-10-08T01:00:03.000Z'))
      wb.applyJobEvent('job:thinking-delta', { id: 'j1', delta: '第二段' })
      expect(wb.jobs.value[0].thinkingStartedAt).toBe('2026-10-08T01:00:00.000Z')
      expect(wb.jobs.value[0].thinkingEndedAt).toBe('2026-10-08T01:00:03.000Z')
      expect(wb.jobs.value[0].thinking).toBe('第一段第二段')
    } finally {
      vi.useRealTimers()
    }
  })

  test('服务端已给过起点时不覆盖它，只把终点往前推', () => {
    vi.useFakeTimers()
    try {
      const wb = useWorkbenchData()
      wb.jobs.value = [makeJob({ thinkingStartedAt: '2026-10-08T00:59:00.000Z' })] as never

      vi.setSystemTime(new Date('2026-10-08T01:00:03.000Z'))
      wb.applyJobEvent('job:thinking-delta', { id: 'j1', delta: '想' })
      expect(wb.jobs.value[0].thinkingStartedAt).toBe('2026-10-08T00:59:00.000Z')
      expect(wb.jobs.value[0].thinkingEndedAt).toBe('2026-10-08T01:00:03.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  test('正文增量（job:output-delta）不打思考计时', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    wb.applyJobEvent('job:output-delta', { id: 'j1', delta: '正文' })
    expect(wb.jobs.value[0].output).toBe('正文')
    expect(wb.jobs.value[0].thinkingStartedAt).toBeUndefined()
    expect(wb.jobs.value[0].thinkingEndedAt).toBeUndefined()
  })

  test('job 不存在 / 空增量：静默跳过（不能抛，SSE 里什么脏数据都可能有）', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob()] as never

    expect(() => wb.applyJobEvent('job:thinking-delta', { id: 'nope', delta: 'x' })).not.toThrow()
    expect(() => wb.applyJobEvent('job:thinking-delta', { id: 'j1', delta: '' })).not.toThrow()
    expect(wb.jobs.value[0].thinkingStartedAt).toBeUndefined()
  })

  test('job:update 整条快照替换时，服务端没给的计时点保住本地攒下的', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob({
      thinkingStartedAt: '2026-10-08T01:00:00.000Z',
      thinkingEndedAt: '2026-10-08T01:00:03.000Z'
    })] as never

    // 起跑 / 老服务端推来的快照没有这两个字段 —— 不保的话数字会闪一下没了
    wb.applyJobEvent('job:update', makeJob({ status: 'done' }))
    expect(wb.jobs.value[0].thinkingStartedAt).toBe('2026-10-08T01:00:00.000Z')
    expect(wb.jobs.value[0].thinkingEndedAt).toBe('2026-10-08T01:00:03.000Z')
  })

  test('job:update 带服务端计时时以服务端为准（跨实例一致的口径）', () => {
    const wb = useWorkbenchData()
    wb.jobs.value = [makeJob({
      thinkingStartedAt: '2026-10-08T01:00:00.000Z',
      thinkingEndedAt: '2026-10-08T01:00:03.000Z'
    })] as never

    wb.applyJobEvent('job:update', makeJob({
      status: 'done',
      thinkingStartedAt: '2026-10-08T00:59:59.500Z',
      thinkingEndedAt: '2026-10-08T01:00:04.000Z'
    }))
    expect(wb.jobs.value[0].thinkingStartedAt).toBe('2026-10-08T00:59:59.500Z')
    expect(wb.jobs.value[0].thinkingEndedAt).toBe('2026-10-08T01:00:04.000Z')
  })
})
