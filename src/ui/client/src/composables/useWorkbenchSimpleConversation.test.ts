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
// 简单任务对话流（执行流）里「工具调用」这条接线的回归测试。
//
// 背景（2026-09-22）：任务执行流以前只显示「思考 + 正文」，模型闷头调工具的几分钟
// 完全看不出它在干什么。服务端已经采集 job.toolCalls，这里守的是前端这一段：
//   1. job.toolCalls → ChatMessage.toolCalls（映射 + 终态归一）
//   2. 一句话不说、只调工具的 job 也要出现 assistant 气泡（hasContent 判定）
//   3. 老 job（没有 toolCalls 字段）不受影响
//
// 为什么要把真实的 ChatContainer 也挂出来：只断言 messages 数组就够的话，
// 「组件库到底认不认这个字段」这件事没人管 —— 而它恰恰是"改了服务端、界面上还是空的"
// 这类问题的落点。真实渲染要跑 shiki/markdown，所以这里只锁"工具块出现在 DOM 里"。

import { describe, expect, test } from 'vitest'
import { computed, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { ChatContainer } from 'zen-ai-chat-ui'
import type { Job, Task } from '@/types/workbench'
import { useWorkbenchSimpleConversation } from './useWorkbenchSimpleConversation'

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '任务',
    desc: '描述',
    promptId: null,
    type: 'simple',
    simpleOverride: '',
    projectPath: 'C:\\proj',
    subtasks: [],
    status: 'todo',
    ...patch
  } as Task
}

function makeJob(patch: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    taskId: 't1',
    subId: 't1__simple',
    title: '任务',
    status: 'running',
    prompt: '看下目录',
    output: '',
    pid: null,
    startedAt: '2026-09-22T08:00:00.000Z',
    endedAt: null,
    exitCode: null,
    error: null,
    ...patch
  }
}

function setup(jobs: Job[]) {
  const jobsRef = ref<Job[]>(jobs)
  const taskRef = computed<Task | null>(() => makeTask())
  const { simpleConversationMessages } = useWorkbenchSimpleConversation(jobsRef, taskRef)
  return simpleConversationMessages
}

describe('useWorkbenchSimpleConversation 的工具调用', () => {
  test('job.toolCalls → ChatMessage.toolCalls，字段与状态一起过去', () => {
    const messages = setup([
      makeJob({
        status: 'done',
        output: '看完了',
        toolCalls: [
          { id: 'toolu_a', name: 'Bash', argsPreview: 'ls -la', result: 'a.js', status: 'done' },
          { id: 'toolu_b', name: 'Read', argsPreview: 'src/a.js', status: 'error', error: 'File does not exist.' }
        ]
      })
    ]).value

    const assistant = messages.find(m => m.role === 'assistant')!
    expect(assistant.toolCalls).toHaveLength(2)
    expect(assistant.toolCalls![0]).toMatchObject({
      id: 'toolu_a',
      name: 'Bash',
      argsPreview: 'ls -la',
      result: 'a.js',
      status: 'done'
    })
    expect(assistant.toolCalls![1]).toMatchObject({ name: 'Read', status: 'error', error: 'File does not exist.' })
  })

  test('只调工具、一句话不说的 job 也要出现 assistant 气泡', () => {
    const messages = setup([
      makeJob({
        status: 'running',
        output: '',
        thinking: '',
        toolCalls: [{ id: 'toolu_a', name: 'Bash', argsPreview: 'npm test', status: 'running' }]
      })
    ]).value

    const assistant = messages.find(m => m.role === 'assistant')!
    expect(assistant).toBeTruthy()
    expect(assistant.content).toBe('')
    expect(assistant.toolCalls).toHaveLength(1)
    // 有内容 → 走 streaming（气泡上有活动感），而不是 pending 打字点
    expect(assistant.status).toBe('streaming')
  })

  test('老 job 没有 toolCalls 字段时行为不变（不产生空数组字段）', () => {
    const messages = setup([makeJob({ status: 'done', output: '只是说了句话' })]).value
    const assistant = messages.find(m => m.role === 'assistant')!
    expect(assistant.toolCalls).toBeUndefined()
    expect(assistant.content).toBe('只是说了句话')
  })

  test('job 已结束但调用还挂 running → 归一成 done（不让工具块一直转圈）', () => {
    const messages = setup([
      makeJob({
        status: 'done',
        output: '结束',
        toolCalls: [{ id: 'toolu_a', name: 'Bash', status: 'running' }]
      })
    ]).value
    expect(messages.find(m => m.role === 'assistant')!.toolCalls![0].status).toBe('done')
  })
})

describe('执行流的工具块真的画出来了', () => {
  // jsdom 没实现 Element.scrollTo，而 ChatContainer 挂载时会自动贴底（scrollToBottom），
  // 不补这一下就是 "o.scrollTo is not a function" —— 与本次改动无关的环境缺口。
  const proto = Element.prototype as unknown as { scrollTo?: () => void }
  if (!proto.scrollTo) proto.scrollTo = () => {}

  test('ChatContainer 渲染出工具调用块', async () => {
    const messages = setup([
      makeJob({
        status: 'done',
        output: '看完了',
        toolCalls: [
          { id: 'toolu_a', name: 'Bash', argsPreview: 'ls -la', result: 'a.js', status: 'done' },
          { id: 'toolu_b', name: 'Read', argsPreview: 'src/a.js', status: 'done', result: '内容' }
        ]
      })
    ])

    const wrapper = mount(ChatContainer, {
      props: {
        messages: messages.value,
        // 平铺展示：折叠成组时只渲染最新一条，断言会跟着库的默认值走
        toolCallsConfig: { group: false }
      },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    expect(wrapper.findAll('.acu-toolcall').length).toBe(2)
    expect(wrapper.html()).toContain('ls -la')
    expect(wrapper.html()).toContain('src/a.js')
  })

  test('默认配置下多个调用折叠成一组（界面上只占一行）', async () => {
    const messages = setup([
      makeJob({
        status: 'done',
        output: '',
        toolCalls: [
          { id: 'toolu_a', name: 'Bash', argsPreview: 'ls -la', status: 'done' },
          { id: 'toolu_b', name: 'Read', argsPreview: 'src/a.js', status: 'done' }
        ]
      })
    ])

    const wrapper = mount(ChatContainer, {
      props: { messages: messages.value },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    expect(wrapper.find('.acu-toolgroup').exists()).toBe(true)
  })
})
