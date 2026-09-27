// AgentView 窄屏折行的回归测试。
//
// 这个视图有两套完全不同的骨架：
//   · 宽屏 —— 左侧 aside 会话列表 + 右侧对话区，两栏并排；
//   · 窄屏 —— 上面那栏收进 body，变成「会话列表页 ↔ 对话页」两个整页轮换。
// 最容易踩的坑是宽屏那套 aside 在窄屏"忘了删"（于是又出现并排），
// 以及窄屏点会话 / 新建之后没有真的翻到对话页（点了像没反应）。
//
// 窄屏开关由 useNarrowPane 决定，它依赖 ResizeObserver —— jsdom 里那是空实现，
// 永远量不到宽度、恒为宽屏。所以这里把 useNarrowPane 整体替成手动开关，
// 只测组件自己的折行逻辑；阈值与观察行为由 useNarrowPane.test.ts 单独守。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mountWithSetup } from '@/test-utils/mount'

const pane = vi.hoisted(() => ({ refs: [] as { value: boolean }[] }))
const agent = vi.hoisted(() => ({
  loadSession: null as any,
  newSession: null as any,
  loadSessions: null as any,
}))

vi.mock('@/composables/useNarrowPane', async () => {
  const { ref } = await import('vue')
  return {
    // 与 useNarrowPane 的真实默认值保持一致（用例靠手动开关 narrow，这里只是别写歪）
    PANE_SPLIT_MIN_WIDTH: 680,
    useNarrowPane: () => {
      const narrow = ref(false)
      pane.refs.push(narrow as unknown as { value: boolean })
      return { width: ref(1000), narrow }
    },
  }
})

vi.mock('@/composables/useAgentChat', async () => {
  const { ref } = await import('vue')
  agent.loadSession = vi.fn().mockResolvedValue(undefined)
  agent.newSession = vi.fn()
  agent.loadSessions = vi.fn().mockResolvedValue(undefined)
  return {
    AGENT_UPLOAD_ACCEPT: 'image/*',
    useAgentChat: () => ({
      sessions: ref([
        { sessionId: 's1', title: '问候交流', updatedAt: '2026-09-27T10:00:00.000Z', messageCount: 2 },
      ]),
      sessionsLoading: ref(false),
      currentSessionId: ref('s1'),
      messages: ref([]),
      isStreaming: ref(false),
      sessionLoading: ref(false),
      pendingQuestion: ref(null),
      answeringQuestion: ref(false),
      isSessionGenerating: () => false,
      loadSessions: agent.loadSessions,
      loadSession: agent.loadSession,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      newSession: agent.newSession,
      sendMessage: vi.fn(),
      answerQuestion: vi.fn(),
      stop: vi.fn(),
    }),
  }
})

// 组件库与广场都只关心"在不在"，给个能查的壳就够
vi.mock('zen-ai-chat-ui', () => ({
  ChatContainer: {
    name: 'ChatContainer',
    template: '<div class="stub-chat" />',
    methods: { scrollToBottom() {} },
  },
  ConversationList: {
    name: 'ConversationList',
    props: ['items', 'activeId', 'loading', 'labels', 'compact', 'showSearch'],
    template: '<div class="stub-conv" />',
  },
}))

vi.mock('@/components/MarketplacePanel.vue', () => ({
  default: { name: 'MarketplacePanel', template: '<div class="stub-marketplace" />' },
}))

vi.mock('@stores/configStore', () => ({
  useConfigStore: () => ({ theme: 'light', currentDirectory: '/tmp/proj' }),
}))

import AgentView from './AgentView.vue'

function mountView() {
  pane.refs.length = 0
  return mountWithSetup(AgentView, {
    global: { stubs: { 'el-icon': { template: '<i><slot /></i>' } } },
  })
}

/** 把当前挂载实例的窄屏开关拨到指定值 */
async function setNarrow(value: boolean) {
  pane.refs.forEach(r => (r.value = value))
  await nextTick()
}

beforeEach(() => {
  pane.refs.length = 0
})

describe('AgentView 窄屏折行', () => {
  it('宽屏：左侧会话列表与对话区并排，不出现返回条', async () => {
    const w = mountView()
    await setNarrow(false)
    expect(w.find('.agent-sidebar').exists()).toBe(true)
    expect(w.find('.agent-sidebar .stub-conv').exists()).toBe(true)
    expect(w.find('.stub-chat').exists()).toBe(true)
    expect(w.find('.agent-page-bar').exists()).toBe(false)
    // body 里不该再多一份列表
    expect(w.find('.agent-list-page').exists()).toBe(false)
  })

  it('窄屏：默认落在对话页 —— 侧栏整块不渲染，只有返回条 + 对话', async () => {
    const w = mountView()
    await setNarrow(true)
    // 关键：宽屏那套并排骨架必须消失，否则又会挤成一团
    expect(w.find('.agent-sidebar').exists()).toBe(false)
    expect(w.find('.sidebar-resizer').exists()).toBe(false)

    expect(w.find('.agent-page-bar').exists()).toBe(true)
    // 返回条上显示当前会话的标题（取自会话列表那条，兜底规则一致）
    expect(w.find('.agent-page-title').text()).toBe('问候交流')
    expect(w.find('.stub-chat').exists()).toBe(true)
    expect(w.find('.agent-list-page').exists()).toBe(false)
  })

  it('窄屏：点返回箭头翻到会话列表页，对话整块让位', async () => {
    const w = mountView()
    await setNarrow(true)
    await w.find('.agent-page-back').trigger('click')

    expect(w.find('.agent-list-page').exists()).toBe(true)
    expect(w.find('.agent-list-page .stub-conv').exists()).toBe(true)
    expect(w.find('.stub-chat').exists()).toBe(false)
    expect(w.find('.agent-page-bar').exists()).toBe(false)
  })

  it('窄屏：列表页点会话 → 打开会话并翻回对话页', async () => {
    const w = mountView()
    await setNarrow(true)
    await w.find('.agent-page-back').trigger('click')
    expect(w.find('.agent-list-page').exists()).toBe(true)

    w.findComponent({ name: 'ConversationList' }).vm.$emit('select', 's1')
    await nextTick()

    expect(agent.loadSession).toHaveBeenCalledWith('s1')
    expect(w.find('.agent-list-page').exists()).toBe(false)
    expect(w.find('.stub-chat').exists()).toBe(true)
  })

  it('窄屏：列表页点新建 → 建完直接进对话页', async () => {
    const w = mountView()
    await setNarrow(true)
    await w.find('.agent-page-back').trigger('click')

    w.findComponent({ name: 'ConversationList' }).vm.$emit('new')
    await nextTick()

    expect(agent.newSession).toHaveBeenCalled()
    expect(w.find('.stub-chat').exists()).toBe(true)
    expect(w.find('.agent-list-page').exists()).toBe(false)
  })

  it('分屏拖宽后自动回到对话页，避免下次变窄"一进来就是列表"', async () => {
    const w = mountView()
    await setNarrow(true)
    await w.find('.agent-page-back').trigger('click')
    expect(w.find('.agent-list-page').exists()).toBe(true)

    await setNarrow(false)
    await setNarrow(true)
    expect(w.find('.agent-list-page').exists()).toBe(false)
    expect(w.find('.stub-chat').exists()).toBe(true)
  })

  it('窄屏停在列表页时切到广场，广场照常渲染（列表页状态不外溢）', async () => {
    const w = mountView()
    await setNarrow(true)
    await w.find('.agent-page-back').trigger('click')
    expect(w.find('.agent-list-page').exists()).toBe(true)

    // 第二个 Tab = Skill 广场
    await w.findAll('.agent-tab')[1].trigger('click')
    expect(w.find('.stub-marketplace').exists()).toBe(true)
    expect(w.find('.agent-list-page').exists()).toBe(false)
    expect(w.find('.agent-page-bar').exists()).toBe(false)
  })
})
