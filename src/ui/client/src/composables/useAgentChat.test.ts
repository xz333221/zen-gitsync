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
import { ElMessage } from 'element-plus'
import { useConfigStore } from '@/stores/configStore'
import { useAgentActivityStore } from '@/stores/agentActivity'
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

// jsdom 的 FileReader 回调时机不可靠（附件要先转 dataURL 才发请求，早了就会读不到流），
// 这里换成确定性的假实现：内容不重要，只要 result 是合法的 dataURL 即可。
class FakeFileReader {
  result: string | null = null
  error: unknown = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(file: Blob) {
    const type = (file as unknown as { type?: string }).type || 'application/octet-stream'
    this.result = `data:${type};base64,eA==` // 'x' 的 base64
    Promise.resolve().then(() => this.onload?.())
  }
}

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
    vi.stubGlobal('FileReader', FakeFileReader)

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

  // 回归：停止 = 服务端仍会落盘，但 writeSession 往往晚于停止后立刻发起的这次列表刷新。
  // 之前的实现直接以服务端列表覆盖，左栏这一条就消失了（用户报的"一停止任务就没了"）。
  test('停止后服务端列表还没这条会话时，左栏条目要保留', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()

    // 新会话首轮：meta 事件才带回真实 sessionId
    const sendPromise = chat.sendMessage('请列出当前项目的目录结构')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'N1', title: '请列出当前项目的目录结构' })
    chatStreams[0].send({ type: 'content', delta: '正在看目录' })
    await flush()
    expect(chat.sessions.value.map((s) => s.sessionId)).toEqual(['N1', 'A', 'B'])

    chat.stop()
    chatStreams[0].error(new DOMException('aborted', 'AbortError'))
    await sendPromise
    await flush()

    // beforeEach 的列表桩里没有 N1：这次刷新拿不到它，但条目不能被吞掉
    const kept = chat.sessions.value.find((s) => s.sessionId === 'N1')
    expect(kept).toBeTruthy()
    expect(kept?.isGenerating).toBe(false)
    expect(kept?.title).toBe('请列出当前项目的目录结构')

    // 服务端落盘后再刷新：同一条 sessionId 只有一条，且完全以服务端数据为准
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/agent/sessions?')) {
        return json({ success: true, sessions: [sessionMeta('N1', '服务端标题'), sessionMeta('A', '会话 A')] })
      }
      return json({ success: true })
    }))
    await chat.loadSessions()
    const n1 = chat.sessions.value.filter((s) => s.sessionId === 'N1')
    expect(n1).toHaveLength(1)
    expect(n1[0].title).toBe('服务端标题')
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

  // 提问面板：ask_user 带 multiple 时，提交给服务端的 answer 是数组
  // （多选序列化成 JSON 数组字符串、拼进 tool 结果是服务端的事）
  test('ask_user 多选：提交数组给 /api/agent/respond', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('问我几个问题')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({
      type: 'ask_user',
      interactionId: 'q1',
      question: '要改哪几个文件？',
      options: ['A.ts', 'B.ts', 'C.ts'],
      allowFreeText: true,
      multiple: true
    })
    await flush()

    expect(chat.pendingQuestion.value?.multiple).toBe(true)
    expect(chat.pendingQuestion.value?.options).toEqual(['A.ts', 'B.ts', 'C.ts'])

    await chat.answerQuestion(['A.ts', 'C.ts'])
    expect(chat.pendingQuestion.value).toBeNull()

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/respond')
    expect(call).toBeTruthy()
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      sessionId: 'A',
      interactionId: 'q1',
      answer: ['A.ts', 'C.ts']
    })

    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise
  })

  // 文件空间对话：把"当前打开的文档"随请求带给服务端（服务端只在请求副本里注入上下文）
  test('sendMessage 的 openFilePath 选项会进请求体', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('这个文件是干嘛的', [], { openFilePath: 'src/ui/client/src/App.vue' })
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    expect(call).toBeTruthy()
    expect(JSON.parse(String((call![1] as RequestInit).body)).openFilePath).toBe('src/ui/client/src/App.vue')
  })

  // 常用目录对话（「切换工作目录」弹窗里的追问区）：
  //   · dirStatus / dirSummary 随请求带给服务端（它只进请求副本的 system 提示）
  //   · engine 覆盖：那个入口固定用内置 g ai，不该被用户在别处选的 claude/codex 带走
  test('sendMessage 的 dirStatus / dirSummary / engine 选项会进请求体', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const dirStatus = [{ path: 'C:\\ws\\a', exists: true, git: { isGitRepo: true, behind: 3 } }]
    const sendPromise = chat.sendMessage('先处理哪个', [], {
      engine: 'gai',
      dirStatus,
      dirSummary: '这 1 个目录里有 1 个需要处理。'
    })
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.engine).toBe('gai')
    expect(body.dirStatus).toEqual(dirStatus)
    expect(body.dirSummary).toBe('这 1 个目录里有 1 个需要处理。')
  })

  test('没传 dirStatus / dirSummary 时请求体里没有这两个字段（老调用点不受影响）', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('随便问问', [])
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect('dirStatus' in body).toBe(false)
    expect('dirSummary' in body).toBe(false)
    // engine 不传时仍按"当前选择"走（这里的 fixture 默认是 'gai'）
    expect(body.engine).toBe('gai')
  })

  // ── 附件：图片走多模态，非图片走"落盘 + 只给路径" ──────────────
  // 口径见 useAgentChat 顶部注释与 server/utils/agentAttachments.js：
  // images[] 里是 dataURL（模型直接看），attachments[] 里是 { name, dataUrl }（服务端落盘后
  // 只把绝对路径写进请求副本的 system 提示），两者可以同轮共存。
  const pickedFile = (name: string, type: string, id = name) =>
    ({ id, file: new File(['x'], name, { type }) }) as any

  test('图片进 images[]、非图片进 attachments[]，两者同轮共存', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('看下这两个', [
      pickedFile('shot.png', 'image/png'),
      pickedFile('错误日志.log', 'text/plain')
    ])
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.images).toHaveLength(1)
    expect(body.images[0]).toMatch(/^data:image\/png;base64,/)
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].name).toBe('错误日志.log')
    expect(body.attachments[0].dataUrl).toMatch(/^data:/)
  })

  test('只有附件、没有文字也能发出', async () => {
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const sendPromise = chat.sendMessage('', [pickedFile('a.md', 'text/markdown')])
    await flush()
    // 纯附件消息不该被"内容不能为空"挡下
    expect(chatStreams).toHaveLength(1)
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    expect(JSON.parse(String((call![1] as RequestInit).body)).attachments).toHaveLength(1)
  })

  test('超过单文件上限的附件被忽略并提示，其余照常发送', async () => {
    const warn = vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({} as any))
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const oversize = { id: 'big', file: { name: 'big.bin', type: 'application/octet-stream', size: 11 * 1024 * 1024 } } as any
    const sendPromise = chat.sendMessage('看下', [oversize, pickedFile('small.log', 'text/plain')])
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await sendPromise

    const call = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === '/api/agent/chat')
    const body = JSON.parse(String((call![1] as RequestInit).body))
    expect(body.attachments.map((a: any) => a.name)).toEqual(['small.log'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('big.bin')
    warn.mockRestore()
  })

  // ── 全局活动计数（左侧机器人图标徽标的数据源）────────────────────
  // 口径：此刻真的在流式输出的轮数，**跨实例**累计。切走视图后后台还在跑的那几轮
  // 也算数 —— 那正是从别的视图切回时唯一能看见"它还忙"的信号。
  test('起流登记、结束销号；后台轮次与别的实例都各算一份', async () => {
    const activity = useAgentActivityStore()
    expect(activity.runningCount).toBe(0)

    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const p1 = chat.sendMessage('第一个问题')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    await flush()
    expect(activity.runningCount).toBe(1)

    // 切到 B 再起一轮：A 在后台继续跑 → 两条
    await chat.loadSession('B')
    const p2 = chat.sendMessage('第二个问题')
    await flush()
    chatStreams[1].send({ type: 'meta', sessionId: 'B', title: '会话 B' })
    await flush()
    expect(activity.runningCount).toBe(2)

    // 另一个 useAgentChat 实例（另一个入口）再起一轮 → 三条
    const other = useAgentChat()
    const p3 = other.sendMessage('第三个问题')
    await flush()
    chatStreams[2].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    await flush()
    expect(activity.runningCount).toBe(3)

    // 逐条收尾，每条只减自己那一个
    chatStreams[0].send({ type: 'done', content: '好' })
    chatStreams[0].close()
    await p1
    await flush()
    expect(activity.runningCount).toBe(2)

    chatStreams[1].send({ type: 'done', content: '好' })
    chatStreams[1].close()
    await p2
    await flush()
    expect(activity.runningCount).toBe(1)

    chatStreams[2].send({ type: 'done', content: '好' })
    chatStreams[2].close()
    await p3
    await flush()
    expect(activity.runningCount).toBe(0)
  })

  test('被中止的轮次也要销号（不能留下永久幽灵计数）', async () => {
    const activity = useAgentActivityStore()
    const chat = useAgentChat()
    await chat.loadSessions()
    await chat.loadSession('A')

    const p = chat.sendMessage('停下来')
    await flush()
    chatStreams[0].send({ type: 'meta', sessionId: 'A', title: '会话 A' })
    await flush()
    expect(activity.runningCount).toBe(1)

    chat.stop()
    chatStreams[0].error(new DOMException('aborted', 'AbortError'))
    await p
    await flush()
    expect(activity.runningCount).toBe(0)
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
