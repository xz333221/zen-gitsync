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
  // 排队：条带上的移除 / 立即发送要真的转到 composable 上
  removeQueuedMessage: null as any,
  flushQueued: null as any,
  // 引擎选择：整块提到 hoisted 里，用例才能单独拨（默认 g ai / 未锁定）
  currentEngine: null as any,
  pendingEngine: null as any,
  isEngineLocked: null as any,
  pickEngine: null as any,
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
  agent.removeQueuedMessage = vi.fn()
  agent.flushQueued = vi.fn()
  agent.currentEngine = ref('gai')
  agent.pendingEngine = ref('gai')
  agent.isEngineLocked = ref(false)
  agent.pickEngine = vi.fn()
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
      currentEngine: agent.currentEngine,
      pendingEngine: agent.pendingEngine,
      isEngineLocked: agent.isEngineLocked,
      pickEngine: agent.pickEngine,
      loadSessions: agent.loadSessions,
      loadSession: agent.loadSession,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      newSession: agent.newSession,
      sendMessage: vi.fn(),
      answerQuestion: vi.fn(),
      stop: vi.fn(),
      inputContextUsage: ref(null),
      queuedMessages: ref([]),
      queuePaused: ref(false),
      removeQueuedMessage: agent.removeQueuedMessage,
      flushQueued: agent.flushQueued,
    }),
  }
})

// 组件库与广场都只关心"在不在"，给个能查的壳就够
// （排队的几个 prop 要声明出来 —— 桩不声明就只当普通 attribute 落下去，props() 读不到）
vi.mock('zen-ai-chat-ui', () => ({
  ChatContainer: {
    name: 'ChatContainer',
    props: ['messages', 'generating', 'disabled', 'allowQueue', 'queued', 'queuePaused', 'queueLabels', 'placeholder', 'theme', 'showInput', 'presetQuestions'],
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

// configStore 可变桩：预设提示词用例要按例切换 agentPresetPrompts。
// （computed 读的是普通对象字段，直接赋值不会触发响应式 —— 用例改完值重新 mount 即可。）
const configState = vi.hoisted(() => ({
  theme: 'light' as const,
  currentDirectory: '/tmp/proj',
  agentPresetPrompts: [] as { id: string; label: string; prompt: string }[],
}))

vi.mock('@stores/configStore', () => ({
  useConfigStore: () => configState,
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
  agent.currentEngine.value = 'gai'
  agent.pendingEngine.value = 'gai'
  agent.isEngineLocked.value = false
  agent.pickEngine.mockClear()
  configState.agentPresetPrompts = []
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

// ── 引擎选择器 ────────────────────────────────────────────
// 只钉"用户能看见的契约"：默认显示什么、什么时候置灰、什么时候不该出现。
// 下拉菜单本体是 el-dropdown 的 teleport 弹层，jsdom 里选不稳；可用性映射与
// 「未安装 → 安装弹窗」的判定逻辑由 utils/agentEngine.test.ts 覆盖。
describe('AgentView 引擎选择器', () => {
  it('对话 Tab 上常驻显示当前引擎（默认 g ai）', async () => {
    const w = mountView()
    await setNarrow(false)
    expect(w.find('.agent-engine').exists()).toBe(true)
    expect(w.find('.agent-engine__name').text()).toBe('g ai')
  })

  // 每个引擎都要显示自己的图标 —— 这条是一个真实回归：初版刻意让 g ai 留空格，
  // 用户看下来只觉得"图标没加载出来"（下面三家都有，只有它空着）。
  // 两种机制都钉住：内置走 sprite 的 <svg-icon>，外部三家走 TaskExecutorIcon 的 <img>。
  it('内置 g ai 显示 sprite 图标（不是空格子）', async () => {
    const w = mountView()
    await setNarrow(false)
    const btn = w.find('.agent-engine__btn')
    expect(btn.find('svg.svg-icon').exists()).toBe(true)
    expect(btn.find('img.task-executor-icon').exists()).toBe(false)
    // 不能是个空的 <svg>：sprite 的 icon-class 必须真的传到 <use> 上。
    // 不断言属性名（xlink:href / href 随 vue 版本与命名空间写法会变），只看目标 id。
    expect(btn.html()).toContain('icon-g-ai')
  })

  it('外部引擎显示各自的品牌图标，且不再是 sprite', async () => {
    agent.isEngineLocked.value = true
    agent.currentEngine.value = 'claude'
    const w = mountView()
    await setNarrow(false)
    await nextTick()
    const btn = w.find('.agent-engine__btn')
    expect(btn.find('img.task-executor-icon').exists()).toBe(true)
    expect(btn.find('svg.svg-icon').exists()).toBe(false)
  })

  it('引擎没锁定时可点：按钮不禁用', async () => {
    const w = mountView()
    await setNarrow(false)
    expect(w.find('.agent-engine__btn').attributes('disabled')).toBeUndefined()
  })

  it('会话已落盘（引擎锁死）→ 按钮禁用，且显示的是这条会话自己的引擎', async () => {
    agent.isEngineLocked.value = true
    agent.currentEngine.value = 'claude'
    // 故意让 pendingEngine 停在别的值：锁定时必须显示 currentEngine，不能显示"下次新建用的"
    agent.pendingEngine.value = 'codex'
    const w = mountView()
    await setNarrow(false)
    await nextTick()
    expect(w.find('.agent-engine__btn').attributes('disabled')).toBeDefined()
    expect(w.find('.agent-engine__name').text()).toBe('Claude Code')
  })

  it('未锁定（新建会话）→ 显示的是"下次新建会用哪个"', async () => {
    agent.isEngineLocked.value = false
    agent.currentEngine.value = 'claude'
    agent.pendingEngine.value = 'codex'
    const w = mountView()
    await setNarrow(false)
    await nextTick()
    expect(w.find('.agent-engine__name').text()).toBe('Codex')
  })

  it('非对话 Tab（广场）不显示引擎选择器 —— 那里没在跑智能体', async () => {
    const w = mountView()
    await setNarrow(false)
    await w.find('.agent-tab:nth-child(2)').trigger('click')
    await nextTick()
    expect(w.find('.agent-engine').exists()).toBe(false)
  })
})

describe('AgentView 生成中排队（接线）', () => {
  // 判定「什么时候入队 / 接棒 / 暂停」在 composables/useAgentChat.test.ts；
  // 「条带长什么样」在库里（playground 探针）。这里只守一件事：
  // 这几个 prop / 事件真的接到了库的 ChatContainer 上，别哪天接线掉了还没人发现。
  it('排队 props 传给库的 ChatContainer，生成中不再 disable 输入框', async () => {
    const w = mountView()
    await setNarrow(false)
    await nextTick()

    const chat = w.findComponent({ name: 'ChatContainer' })
    expect(chat.props('allowQueue')).toBe(true)
    expect(chat.props('queued')).toEqual([])
    expect(chat.props('queuePaused')).toBe(false)
    // 关键：生成中不再把输入框整个禁掉 —— 能打字才是排队的前提
    expect(chat.props('disabled')).toBeUndefined()
  })

  it('条带上的「移除 / 立即发送」转发给 useAgentChat（用真库接线那份形状）', async () => {
    const w = mountView()
    await setNarrow(false)
    await nextTick()

    const chat = w.findComponent({ name: 'ChatContainer' })
    chat.vm.$emit('unqueue', 'q1')
    chat.vm.$emit('flush-queued')
    await nextTick()

    expect(agent.removeQueuedMessage).toHaveBeenCalledWith('q1')
    expect(agent.flushQueued).toHaveBeenCalledTimes(1)
  })
})

describe('AgentView 预设提示词（可配置）', () => {
  // 卡片数据源已从视图内硬编码改为 utils/agentPresets 的共享模块：
  // 配置里有自定义用自定义，否则回落内置默认。这里只守"接线"：
  // store 的值真的到了库的 ChatContainer 的 preset-questions 上。
  function presetProps(w: ReturnType<typeof mountView>) {
    const chat = w.findComponent({ name: 'ChatContainer' })
    return chat.props('presetQuestions') as Array<{ id: string; label: string; prompt: string }>
  }

  it('配置为空时用内置默认（5 条，id = p1..p5）', async () => {
    const w = mountView()
    await nextTick()

    const qs = presetProps(w)
    expect(qs.length).toBe(5)
    expect(qs.map(q => q.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  })

  it('配置有自定义时原样用自定义（顺序与字段都不加工）', async () => {
    configState.agentPresetPrompts = [
      { id: 'u2', label: '第二条', prompt: '做点别的' },
      { id: 'u1', label: '第一条', prompt: '跑测试' },
    ]
    const w = mountView()
    await nextTick()

    expect(presetProps(w)).toEqual([
      { id: 'u2', label: '第二条', prompt: '做点别的' },
      { id: 'u1', label: '第一条', prompt: '跑测试' },
    ])
  })
})
