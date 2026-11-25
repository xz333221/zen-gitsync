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
// 任务对话流（执行流）里「工具调用」这条接线的回归测试。
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
    simpleOverride: '',
    projectPath: 'C:\\proj',
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

describe('useWorkbenchSimpleConversation 的思考段计时', () => {
  test('job 的计时字段 → ChatMessage 的 reasoningStartedAt / reasoningEndedAt', () => {
    const messages = setup([
      makeJob({
        status: 'done',
        thinking: '想过',
        output: '做完了',
        thinkingStartedAt: '2026-10-08T01:00:00.000Z',
        thinkingEndedAt: '2026-10-08T01:00:04.200Z'
      })
    ]).value

    const assistant = messages.find(m => m.role === 'assistant')!
    expect(assistant.reasoningStartedAt).toBe(Date.parse('2026-10-08T01:00:00.000Z'))
    expect(assistant.reasoningEndedAt).toBe(Date.parse('2026-10-08T01:00:04.200Z'))
  })

  test('老 job 没有计时字段 → 两个字段都不给（库那边不显示占位）', () => {
    const assistant = setup([
      makeJob({ status: 'done', thinking: '想过', output: '做完了' })
    ]).value.find(m => m.role === 'assistant')!
    expect(assistant.reasoningStartedAt).toBeUndefined()
    expect(assistant.reasoningEndedAt).toBeUndefined()
  })
})

describe('思考块的耗时真的画出来了', () => {
  // 与「工具块真的画出来了」同一套路：只断言 messages 数组的话，
  // 「组件库到底认不认这两个字段」没人管 —— 而它恰恰是"改完前端还是没数字"的落点。
  const proto = Element.prototype as unknown as { scrollTo?: () => void }
  if (!proto.scrollTo) proto.scrollTo = () => {}

  test('折叠态标题右侧显示耗时数字', async () => {
    const messages = setup([
      makeJob({
        status: 'done',
        thinking: '想了一会',
        output: '做完了',
        thinkingStartedAt: '2026-10-08T01:00:00.000Z',
        thinkingEndedAt: '2026-10-08T01:00:04.200Z'
      })
    ])

    const wrapper = mount(ChatContainer, {
      props: { messages: messages.value },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    const el = wrapper.find('.acu-thinking-duration')
    expect(el.exists()).toBe(true)
    // formatDuration（组件库）：<10s 保留一位小数
    expect(el.text()).toBe('4.2s')
    // 耗时在折叠态也看得见 —— 这正是这个数字的用处。
    // v-show 的折叠一律断言 inline style（jsdom 的 getComputedStyle 会假绿）
    const body = wrapper.find('.acu-thinking-body')
    expect(body.exists()).toBe(true)
    expect((body.element as HTMLElement).style.display).toBe('none')
  })

  test('拿不到计时的 job 一个数都不渲染（不是 0s / —）', async () => {
    const messages = setup([makeJob({ status: 'done', thinking: '想了一会', output: '做完了' })])

    const wrapper = mount(ChatContainer, {
      props: { messages: messages.value },
      global: { mocks: { $t: (k: string) => k } }
    })
    await new Promise(r => setTimeout(r, 0))

    expect(wrapper.find('.acu-thinking').exists()).toBe(true)
    expect(wrapper.find('.acu-thinking-duration').exists()).toBe(false)
  })
})

describe('正文里嵌的本机图片真的画成了 <img>', () => {
  // 这条链路是三段拼起来的：模型在正文里写 `![](c:\…\a.png)` → 这里把它重写成
  // 后端端点 → 组件库的 markdown 渲染出 <img>。只断言第一步的话，"改完前端还是
  // 裂图"（比如组件库禁了原始 HTML、或把 image 规则挡掉了）没人发现，所以这里
  // 把真实的 ChatContainer 挂出来，直接找 DOM 里的那个 img。
  const proto = Element.prototype as unknown as { scrollTo?: () => void }
  if (!proto.scrollTo) proto.scrollTo = () => {}

  test('markdown 图片的 src 指向后端端点，而不是本机路径', async () => {
    const local = 'c:\\proj\\docs\\screenshots\\a.png'
    const messages = setup([makeJob({ status: 'done', output: `看这张：\n\n![截图](${local})` })])

    const assistant = messages.value.find(m => m.role === 'assistant')!
    expect(assistant.content).toContain('/api/workbench/jobs/j1/image?path=')
    expect(assistant.content).not.toContain(local)

    const wrapper = mount(ChatContainer, {
      props: { messages: messages.value },
      global: { mocks: { $t: (k: string) => k } }
    })
    // MarkdownRenderer 用 rAF 节流渲染，等一帧再找
    await new Promise(r => setTimeout(r, 80))

    const img = wrapper.find('img.acu-md-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(`/api/workbench/jobs/j1/image?path=${encodeURIComponent(local)}`)
    // ⚠️ 这里**故意不**断言 alt：组件库 useMarkdown.ts 覆盖了 markdown-it 的 image
    // 规则（加 class / loading），但没有像默认规则那样调 renderInlineAsText 回填 alt，
    // 于是所有 markdown 图片渲染出来 alt 都是空的（实测：markdown-it 单独跑是 `截图`，
    // 走组件库就是 `""`）。那是 zen-ai-chat-ui 那边的一行修复，改完再回来补这条断言。
  })
})

// 2026-11-25 实测：blog 任务第一轮 spawn claude.exe ENOENT（服务端当时没写时间戳），
// 之后重发成功 —— 界面却把**更早**那次失败钉在对话流最底部，看着像"报错常驻"。
// 这里钉两件事：
//   1. 老记录只有 id 时也能排回正确位置（id 首段是 Date.now().toString(36)）；
//   2. 非最后一轮的零产出失败不再画空气泡；最后一轮照旧给 error（重试按钮在那条上）；
//      有产出的失败（跑到一半炸）不吞。
describe('失败轮在对话流里的位置', () => {
  test('老记录没有时间戳：按 id 里的时间排到成功轮之前，不再垫底', () => {
    const messages = setup([
      // 先发生的那条：真实时刻 2026-11-25T13:34:53Z，records 里两个时间戳都是空的
      makeJob({
        id: 'mww614vt-rgga1p',
        subId: 't1__simple',
        status: 'error',
        prompt: '第一句',
        output: '',
        startedAt: undefined,
        endedAt: undefined,
        error: 'spawn claude.exe ENOENT'
      }),
      // 后成功的那条：13:39:45Z
      makeJob({
        id: 'mww67eje-88xu2u',
        subId: 't1__simple',
        status: 'done',
        prompt: '第二句',
        output: '好了',
        startedAt: '2026-11-25T13:39:45.706Z',
        endedAt: '2026-11-25T13:40:05.307Z'
      })
    ]).value

    // 顺序 = 先失败（只剩用户气泡）→ 后成功（用户气泡 + 正文）
    expect(messages.map(m => m.content)).toEqual(['第一句', '第二句', '好了'])
    expect(messages[messages.length - 1].status).toBe('done')
  })

  test('最后一轮失败仍然给 error 状态和原因（重试按钮挂在这条上）', () => {
    const messages = setup([
      makeJob({ id: 'j1', status: 'done', prompt: '先跑这个', output: '好' }),
      makeJob({
        id: 'mww6aaaa-zzzzzz',
        status: 'error',
        prompt: '再跑这个',
        output: '',
        startedAt: undefined,
        endedAt: undefined,
        error: 'spawn claude.exe ENOENT'
      })
    ]).value

    const last = messages[messages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.status).toBe('error')
    expect(last.error).toBe('spawn claude.exe ENOENT')
  })

  test('非最后一轮、但**有产出**的失败不吞掉（正文照旧留在流里）', () => {
    const messages = setup([
      makeJob({
        id: 'mww61000-aaaaaa',
        status: 'error',
        prompt: '问一句',
        output: '干到一半炸了',
        startedAt: '2026-11-25T13:00:00.000Z',
        endedAt: '2026-11-25T13:00:30.000Z'
      }),
      makeJob({
        id: 'mww62000-bbbbbb',
        status: 'done',
        prompt: '再问',
        output: '好',
        startedAt: '2026-11-25T13:10:00.000Z',
        endedAt: '2026-11-25T13:10:10.000Z'
      })
    ]).value

    expect(messages.map(m => m.content)).toContain('干到一半炸了')
  })
})

