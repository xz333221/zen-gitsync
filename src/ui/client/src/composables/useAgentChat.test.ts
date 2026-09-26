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
// useAgentChat 多会话并行回归：切换会话不再打断后台流，后台流写入自己的会话。
//
// 背景：早期实现把 messages / isStreaming / abortController 做成全局单例，
// 切换会话会先把流 abort 掉（UI 上弹「请先停止当前生成」）。改成按会话隔离的
// runs Map 后，这里守的就是「切走再切回，后台流仍在跑且内容连续」这条线。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useConfigStore } from '@/stores/configStore'
import { convertSessionToMessages, useAgentChat } from './useAgentChat'

interface SseStream {
  stream: ReadableStream<Uint8Array>
  send: (obj: Record<string, unknown>) => void
  close: () => void
  error: (err: unknown) => void
}

function makeSseStream(): SseStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c }
  })
  const encoder = new TextEncoder()
  return {
    stream,
    send: (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)),
    close: () => controller.close(),
    error: (err) => controller.error(err)
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const flush = () => new Promise((r) => setTimeout(r, 0))

function sessionMeta(sessionId: string, title: string) {
  return {
    sessionId,
    title,
    source: 'web',
    cwd: 'C:/proj',
    model: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    messageCount: 1,
    size: 0
  }
}

describe('useAgentChat parallel sessions', () => {
  let chatStreams: SseStream[]

  beforeEach(() => {
    chatStreams = []
    setActivePinia(createPinia())
    const store = useConfigStore()
    store.setCurrentDirectory('C:/proj')

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/agent/sessions?')) {
        return json({ success: true, sessions: [sessionMeta('A', '会话 A'), sessionMeta('B', '会话 B')] })
      }
      if (url === '/api/agent/sessions/A') {
        return json({ success: true, session: { ...sessionMeta('A', '会话 A'), version: 1, messages: [] } })
      }
      if (url === '/api/agent/sessions/B') {
        return json({ success: true, session: { ...sessionMeta('B', '会话 B'), version: 1, messages: [] } })
      }
      if (url === '/api/agent/chat') {
        const s = makeSseStream()
        chatStreams.push(s)
        return new Response(s.stream as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        })
      }
      return json({ success: true })
    }))
  })

  test('切换会话不打断后台流，切回能看到连续内容', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    expect(chat.sessions.value.map((s) => s.sessionId)).toEqual(['A', 'B'])

    await chat.loadSession('A')
    expect(chat.currentSessionId.value).toBe('A')

    const sendPromise = chat.sendMessage('第一个问题')
    await flush()
    expect(chatStreams).toHaveLength(1)

    // 服务端推 meta：会话 A 开始流式
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'content', delta: '你好' })
    await flush()

    expect(chat.isStreaming.value).toBe(true)
    expect(chat.isSessionGenerating('A')).toBe(true)
    expect(chat.messages.value[chat.messages.value.length - 1]?.content).toBe('你好')

    // 切到 B：A 的流必须继续，B 自己不是流式状态
    await chat.loadSession('B')
    expect(chat.currentSessionId.value).toBe('B')
    expect(chat.isStreaming.value).toBe(false)
    expect(chat.isSessionGenerating('A')).toBe(true)

    // 切走后 A 的服务端仍在推内容
    chatStreams[0].send({ type: 'content', delta: '，世界' })
    await flush()

    // 切回 A：命中后台实时缓冲，内容连续（没有被 abort 掉）
    await chat.loadSession('A')
    expect(chat.currentSessionId.value).toBe('A')
    expect(chat.isStreaming.value).toBe(true)
    expect(chat.messages.value[chat.messages.value.length - 1]?.content).toBe('你好，世界')

    chatStreams[0].send({ type: 'done', content: '你好，世界' })
    chatStreams[0].close()
    await sendPromise
    await flush()

    expect(chat.isStreaming.value).toBe(false)
    expect(chat.isSessionGenerating('A')).toBe(false)
  })

  test('stop 只中止当前激活会话的流', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('停下来')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'content', delta: '处理中' })
    await flush()
    expect(chat.isStreaming.value).toBe(true)

    chat.stop()
    chatStreams[0].error(new DOMException('aborted', 'AbortError'))
    await sendPromise
    await flush()

    expect(chat.isStreaming.value).toBe(false)
    const last = chat.messages.value[chat.messages.value.length - 1]
    expect(last?.content).toContain('处理中')
    expect(last?.status).toBe('done')
  })

  // 复用同一套 fetch/SSE mock:命令执行中的 tool_output 要能在运行期间看到,
  // 结束时被 tool_result(带 exit code 的最终结果)整体覆盖
  test('命令实时输出：tool_output 执行中累加，tool_result 到达后覆盖', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('跑个安装')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'tool_call_start', toolCallId: 't1', name: 'run_command', argsPreview: 'npm install' })
    chatStreams[0].send({ type: 'tool_output', toolCallId: 't1', chunk: 'added 10 packages\n' })
    await flush()

    const running = chat.messages.value[chat.messages.value.length - 1]
    expect(running.toolCalls?.[0].status).toBe('running')
    expect(running.toolCalls?.[0].result).toBe('added 10 packages\n')

    chatStreams[0].send({ type: 'tool_output', toolCallId: 't1', chunk: 'added 20 packages\n' })
    await flush()
    expect(running.toolCalls?.[0].result).toBe('added 10 packages\nadded 20 packages\n')

    chatStreams[0].send({ type: 'tool_result', toolCallId: 't1', name: 'run_command', result: '$ npm install\n(exit 0)\nadded 20 packages' })
    await flush()
    expect(running.toolCalls?.[0].status).toBe('done')
    expect(running.toolCalls?.[0].result).toContain('(exit 0)')
    expect(running.toolCalls?.[0].result).not.toContain('added 10 packages')

    chatStreams[0].send({ type: 'done', content: '装好了' })
    chatStreams[0].close()
    await sendPromise
  })
})

// 历史回放：一次 AI 回合（工具循环多轮）在服务端是多条 assistant + tool 记录，
// 转换时必须合并成一条 ChatMessage —— 否则每个工具调用会渲染成独立气泡，
// 与实时流式（所有轮次累加在同一条占位消息上）的观感不一致。
describe('convertSessionToMessages 合并一次 AI 回合', () => {
  const toSession = (messages: unknown[]) =>
    ({ messages } as unknown as Parameters<typeof convertSessionToMessages>[0])

  test('多轮 assistant + tool 记录合并为一条消息', () => {
    const msgs = convertSessionToMessages(toSession([
      { role: 'user', content: '帮我改一下卡片样式' },
      {
        role: 'assistant',
        content: '先找相关代码',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search_text', arguments: '{"pattern":"repo-card"}' } },
          { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.vue"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', name: 'search_text', content: '命中 2 处' },
      { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: 'a.vue 内容' },
      {
        role: 'assistant',
        content: '找到了，开始修改',
        tool_calls: [
          { id: 'c3', type: 'function', function: { name: 'edit_file', arguments: '{"path":"a.vue"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c3', name: 'edit_file', content: '已修改' },
      { role: 'assistant', content: '改好了' },
      { role: 'user', content: '再调整一下' },
      { role: 'assistant', content: '好的' }
    ]))

    // 两条 user 各自之后的 assistant 记录被合并成一条
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])

    const merged = msgs[1]
    expect(merged.content).toBe('先找相关代码找到了，开始修改改好了')
    expect(merged.toolCalls?.map(t => t.name)).toEqual(['search_text', 'read_file', 'edit_file'])
    expect(merged.toolCalls?.map(t => t.result)).toEqual(['命中 2 处', 'a.vue 内容', '已修改'])

    // 下一个 user 之后的 assistant 单独成条
    expect(msgs[3].content).toBe('好的')
    expect(msgs[3].toolCalls).toBeUndefined()
  })
})
