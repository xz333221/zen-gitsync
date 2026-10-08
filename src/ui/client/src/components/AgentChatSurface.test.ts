// AgentChatSurface（主 Agent 控制台里那块对话面）· 生成中排队的**接线**测试。
//
// 为什么这组**不** mock 组件库：本用例要守的正是"排队条带真的长在输入框里、按钮真的还在
// —— 桩声明什么就能读什么，传错了线它也照样绿。所以这里拉起真库的 ChatInput 在 jsdom 里渲染。
// 「什么时候入队 / 接棒 / 暂停」那套判定在 composables/useAgentChat.test.ts 里，这里只管接线。
//
// ⚠️ $t 在测试里是 identity（vitest.setup.ts）：断言文案时写的是 **key**，不是中文。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mountWithSetup } from '@/test-utils/mount'

const agent = vi.hoisted(() => ({
  sendMessage: null as any,
  stop: null as any,
  removeQueuedMessage: null as any,
  flushQueued: null as any,
  // 这两个是响应式源：用例自己拨（生成中 / 队列 / 暂停）
  isStreaming: null as any,
  queued: null as any,
  queuePaused: null as any,
}))

vi.mock('@/composables/useNarrowPane', async () => {
  const { ref, computed } = await import('vue')
  return {
    PANE_SPLIT_MIN_WIDTH: 680,
    // 宽屏两栏 + 宽度已知：输入框是 v-if="width > 0" 挂上去的
    useNarrowPane: () => ({ width: computed(() => 900), narrow: ref(false) }),
  }
})

vi.mock('@/composables/useThemeObserver', async () => {
  const { ref } = await import('vue')
  return { useThemeObserver: () => ({ theme: ref('light') }) }
})

vi.mock('@/composables/useAgentChat', async () => {
  const { ref } = await import('vue')
  agent.sendMessage = vi.fn().mockResolvedValue(undefined)
  agent.stop = vi.fn()
  agent.removeQueuedMessage = vi.fn()
  agent.flushQueued = vi.fn()
  agent.isStreaming = ref(true) // 这一组的默认前提：正在生成
  agent.queued = ref([])
  agent.queuePaused = ref(false)
  return {
    AGENT_UPLOAD_ACCEPT: 'image/*',
    useAgentChat: () => ({
      sessions: ref([]),
      sessionsLoading: ref(false),
      currentSessionId: ref(null),
      messages: ref([]),
      isStreaming: agent.isStreaming,
      pendingQuestion: ref(null),
      answeringQuestion: ref(false),
      isSessionGenerating: () => agent.isStreaming.value,
      currentEngine: ref('gai'),
      pendingEngine: ref('gai'),
      isEngineLocked: ref(false),
      pickEngine: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      newSession: vi.fn(),
      sendMessage: agent.sendMessage,
      answerQuestion: vi.fn(),
      stop: agent.stop,
      inputContextUsage: ref(null),
      queuedMessages: agent.queued,
      queuePaused: agent.queuePaused,
      removeQueuedMessage: agent.removeQueuedMessage,
      flushQueued: agent.flushQueued,
    }),
  }
})

import AgentChatSurface from './AgentChatSurface.vue'

function mountSurface() {
  return mountWithSetup(AgentChatSurface, {
    props: { active: true, allowDispatch: false },
    // 引擎选择器是本组件之外的实现（有它自己的测试），这里只留位置
    global: { stubs: { AgentEngineSelector: true } },
  })
}

describe('AgentChatSurface 生成中排队', () => {
  beforeEach(() => {
    agent.sendMessage.mockClear()
    agent.stop.mockClear()
    agent.removeQueuedMessage.mockClear()
    agent.flushQueued.mockClear()
    agent.isStreaming.value = true
    agent.queued.value = []
    agent.queuePaused.value = false
  })

  it('生成中仍能打字，Enter 直接交给 useAgentChat（换行键不再被拦）', async () => {
    const w = mountSurface()
    await nextTick()

    const ta = w.find('.acu-input-textarea')
    expect(ta.exists()).toBe(true)
    // 关键：生成中**没有** disabled —— 打不了字就谈不上排队
    expect((ta.element as HTMLTextAreaElement).disabled).toBe(false)
    expect(ta.attributes('placeholder')).toBe('@AGENT:生成中，发送后会排队，等本轮跑完自动接上…')

    await ta.setValue('生成中再发一条')
    await ta.trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(agent.sendMessage).toHaveBeenCalledTimes(1)
    expect(agent.sendMessage.mock.calls[0][0]).toBe('生成中再发一条')
  })

  it('生成中右侧两颗按钮：排队（箭头）与停止各就各位，停止照旧转给 stop', async () => {
    const w = mountSurface()
    await nextTick()

    expect(w.find('.acu-input-send:not(.is-stop)').exists()).toBe(true)
    const stop = w.find('.acu-input-send.is-stop')
    expect(stop.exists()).toBe(true)

    await stop.trigger('click')
    expect(agent.stop).toHaveBeenCalledTimes(1)
    expect(agent.sendMessage).not.toHaveBeenCalled()
  })

  it('队列非空时条带长在输入框里：计数 / 正文 / 附件名齐全，且不显示「立即发送」', async () => {
    agent.queued.value = [
      { id: 'q1', text: '排队一', attachmentNames: [] },
      { id: 'q2', text: '排队二', attachmentNames: ['note.txt'] },
    ]
    const w = mountSurface()
    await nextTick()

    const wrap = w.find('.acs__composer .acu-input-wrap')
    expect(wrap.exists()).toBe(true)
    expect(wrap.find('.acu-input-queue').exists()).toBe(true)
    expect(wrap.findAll('.acu-input-queue-item')).toHaveLength(2)
    expect(wrap.findAll('.acu-input-queue-text').map((n) => n.text())).toEqual(['排队一', '排队二'])
    expect(wrap.find('.acu-input-queue-count').text()).toBe('2')
    expect(wrap.find('.acu-input-queue-atts').text()).toContain('note.txt')
    // 生成中的提示是"等本轮跑完"，此时不给手动接续按钮
    expect(wrap.find('.acu-input-queue-hint').text()).toBe('@AGENT:本轮结束后依次发送')
    expect(wrap.find('.acu-input-queue-btn').exists()).toBe(false)
  })

  it('暂停态：提示换掉、队首出「立即发送」，点了转给 flushQueued；✕ 转给 removeQueuedMessage', async () => {
    agent.isStreaming.value = false
    agent.queuePaused.value = true
    agent.queued.value = [{ id: 'q1', text: '排队一', attachmentNames: [] }]
    const w = mountSurface()
    await nextTick()

    const wrap = w.find('.acs__composer .acu-input-wrap')
    expect(wrap.find('.acu-input-queue-hint').text()).toBe('@AGENT:已暂停，点「立即发送」继续')

    const flush = wrap.find('.acu-input-queue-btn')
    expect(flush.exists()).toBe(true)
    expect(flush.text()).toBe('@AGENT:立即发送')
    await flush.trigger('click')
    expect(agent.flushQueued).toHaveBeenCalledTimes(1)

    await wrap.find('.acu-input-queue-remove').trigger('click')
    expect(agent.removeQueuedMessage).toHaveBeenCalledWith('q1')
  })

  it('没有队列时不渲染条带（空闲态与从前逐字一致）', async () => {
    agent.isStreaming.value = false
    const w = mountSurface()
    await nextTick()

    expect(w.find('.acs__composer .acu-input-wrap').exists()).toBe(true)
    expect(w.find('.acu-input-queue').exists()).toBe(false)
    expect(w.find('.acu-input-textarea').attributes('placeholder')).toBe('@AGENT:输入消息，Enter 发送')
  })
})
