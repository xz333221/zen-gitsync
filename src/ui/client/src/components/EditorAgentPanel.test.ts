// EditorAgentPanel 版面的回归测试。
//
// 这块面板挂在文件空间里跟 Monaco 分宽度：够宽就「左列表 + 右对话」并排 ——
// 会话历史直接摆在旁边，不用先点按钮；不够宽折成两页（判据见 useNarrowPane）。
// **两种形态都不堆叠**：「列表压在上面 + 对话在下面」会把对话挤到只剩两三行，
// 这条底线由"并排 or 分页"保证，别哪天又冒出个堆叠分支。
//
// 输入框常驻底部（ChatContainer 传 show-input=false，输入框拆出来自己摆）：
// 两种形态、两个页面都在，所以这里也要钉住"它没有跟着翻页消失/重建"。
//
// ⚠️ 可见性一律用 `shown()`（读 inline style）断言，**不要用 VueWrapper.isVisible()**：
// v-show 的真身是 `style.display`，而 jsdom 的 getComputedStyle 对**动态切换过**的
// display 会返回错的（实测：元素先可见、再被 v-show 隐藏后，computed 仍是 'block'），
// isVisible() 因此会假绿 —— 恰好在"切过去再切回来"这类边界用例上失灵。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import type { VueWrapper } from '@vue/test-utils'
import { mountWithSetup } from '@/test-utils/mount'

const agent = vi.hoisted(() => ({
  loadSession: null as any,
  newSession: null as any,
  sendMessage: null as any,
  // 排队（2026-10-07）：条带上的移除 / 立即发送要真的转到 composable 上
  removeQueuedMessage: null as any,
  flushQueued: null as any,
  // 引擎选择：面板头部那个执行器下拉（与「智能体」视图同一个 AgentEngineSelector）
  currentEngine: null as any,
  pendingEngine: null as any,
  isEngineLocked: null as any,
  pickEngine: null as any,
}))

// jsdom 里量不出宽度（ResizeObserver 是空实现），宽度判断只能由测试直接给定。
// 默认 false（宽屏）：与 useNarrowPane 的约定一致 —— 量不到宽度时按宽屏处理。
const pane = vi.hoisted(() => ({ narrow: null as any }))

vi.mock('@/composables/useNarrowPane', async () => {
  const { ref, computed } = await import('vue')
  pane.narrow = ref(false)
  return {
    PANE_SPLIT_MIN_WIDTH: 680,
    // width 必须 > 0：常驻输入框是 v-if="width > 0" 挂载的（等量到宽度再挂，
    // 免得库的 ChatInput 在错误的列宽里量一次 scrollHeight 就再也纠不回来）
    useNarrowPane: () => ({ width: computed(() => (pane.narrow.value ? 400 : 800)), narrow: pane.narrow }),
  }
})

vi.mock('@/composables/useThemeObserver', async () => {
  const { ref } = await import('vue')
  return { useThemeObserver: () => ({ theme: ref('light') }) }
})

vi.mock('@/composables/useAgentChat', async () => {
  const { ref } = await import('vue')
  agent.loadSession = vi.fn().mockResolvedValue(undefined)
  agent.newSession = vi.fn()
  agent.sendMessage = vi.fn().mockResolvedValue(undefined)
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
      pendingQuestion: ref(null),
      answeringQuestion: ref(false),
      isSessionGenerating: () => false,
      currentEngine: agent.currentEngine,
      pendingEngine: agent.pendingEngine,
      isEngineLocked: agent.isEngineLocked,
      pickEngine: agent.pickEngine,
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadSession: agent.loadSession,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      newSession: agent.newSession,
      sendMessage: agent.sendMessage,
      answerQuestion: vi.fn(),
      stop: vi.fn(),
      queuedMessages: ref([]),
      queuePaused: ref(false),
      removeQueuedMessage: agent.removeQueuedMessage,
      flushQueued: agent.flushQueued,
    }),
  }
})

vi.mock('zen-ai-chat-ui', () => ({
  // 面板给 ChatContainer 传 show-input=false：输入框不在它里面了，
  // 所以这个桩**不带** .acu-input-wrap —— 桩要和现实一个形状，否则
  // "锚点插错地方"这类用例会被一个假的输入框容器骗过去。
  ChatContainer: {
    name: 'ChatContainer',
    props: ['showInput', 'placeholder', 'disabled', 'generating'],
    template: '<div class="stub-chat"><div class="acu-chat-body"></div></div>',
    methods: { scrollToBottom() {} },
  },
  // 常驻的那条输入框。它的根节点就是库里的 .acu-input-wrap，
  // "当前文档"卡片要作为锚点插进这里。
  // 排队那几个 prop 也要声明：桩不声明就只当普通 attribute 落下去，
  // props() 读不到，「传没传」这条断言会变成永远 undefined 的假绿。
  ChatInput: {
    name: 'ChatInput',
    props: ['placeholder', 'disabled', 'generating', 'uploadConfig', 'allowQueue', 'queued', 'queuePaused', 'queueLabels'],
    template: '<div class="acu-input-wrap"><textarea class="acu-input-textarea" /></div>',
  },
  ConversationList: {
    name: 'ConversationList',
    props: ['items', 'activeId', 'loading', 'labels', 'compact', 'showSearch'],
    template: '<div class="stub-conv" />',
  },
}))

import EditorAgentPanel from './EditorAgentPanel.vue'
import AgentEngineSelector from './AgentEngineSelector.vue'

// el-icon 必须 stub：面板头部的引擎下拉里有 <el-icon>，而 jsdom 下真实的 ElIcon
// 会被 ElDropdown 的更新循环反复触发，报 "Maximum recursive updates"（与 AgentView.test
// 同一个原因、同一条处置）。
const EL_ICON_STUB = { 'el-icon': { template: '<i><slot /></i>' } }

function mountPanel(narrow = false) {
  pane.narrow.value = narrow
  return mountWithSetup(EditorAgentPanel, {
    props: { activeFilePath: 'src/a.md', activeFileName: 'a.md', active: true },
    global: { stubs: EL_ICON_STUB },
  })
}

/** 某一块是不是在台面上 —— v-show 的真相就是 inline style */
function shown(w: VueWrapper<any>, sel: string): boolean {
  return (w.find(sel).element as HTMLElement).style.display !== 'none'
}

beforeEach(() => {
  vi.clearAllMocks()
  pane.narrow.value = false
  agent.currentEngine.value = 'gai'
  agent.pendingEngine.value = 'gai'
  agent.isEngineLocked.value = false
})

describe('EditorAgentPanel 版面：够宽并排，不够宽分页', () => {
  it('宽屏：会话历史直接摆在左边，和对话、输入框同屏', async () => {
    const w = mountPanel(false)
    await nextTick()

    expect(shown(w, '.agent-panel-convs')).toBe(true)
    expect(shown(w, '.agent-panel-chat')).toBe(true)
    // 输入框常驻：宽屏也一样在
    expect(shown(w, '.agent-panel-composer')).toBe(true)
    expect(w.find('.agent-panel-title').text()).toBe('@EDITOR:g ai 对话')
    // 两个翻页按钮都是"窄屏专属"，宽屏一个都不该有（列表就在旁边）
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
    expect(w.find('.agent-panel-list-btn').exists()).toBe(false)
  })

  it('宽屏走 is-wide 版式类（两列 grid，输入框只落在对话那一列）', async () => {
    const w = mountPanel(false)
    await nextTick()
    expect(w.find('.agent-panel-body').classes()).toContain('is-wide')

    const narrowW = mountPanel(true)
    await nextTick()
    expect(narrowW.find('.agent-panel-body').classes()).not.toContain('is-wide')
  })

  it('窄屏：默认落在对话页，列表让位，头部有列表按钮', async () => {
    const w = mountPanel(true)
    await nextTick()

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
    expect(w.find('.agent-panel-title').text()).toBe('@EDITOR:g ai 对话')
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
    expect(w.find('.agent-panel-list-btn').exists()).toBe(true)
  })

  it('窄屏点头部按钮翻到会话列表页，头部让给「返回对话 + 会话列表」', async () => {
    const w = mountPanel(true)
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')

    expect(shown(w, '.agent-panel-convs')).toBe(true)
    expect(shown(w, '.agent-panel-chat')).toBe(false)
    expect(w.find('.agent-panel-back-btn').exists()).toBe(true)
    expect(w.find('.agent-panel-title').text()).toBe('@EDITOR:会话列表')
    // 列表按钮自己也要退场（否则同一页上出现两个方向相反的按钮）
    expect(w.find('.agent-panel-list-btn').exists()).toBe(false)
  })

  it('窄屏列表页点 ← 返回对话 → 回到对话页', async () => {
    const w = mountPanel(true)
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')
    await w.find('.agent-panel-back-btn').trigger('click')

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
  })

  it('变宽后回到对话页（并排时列表就在旁边，没必要停在列表页）', async () => {
    const w = mountPanel(true)
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')
    expect(shown(w, '.agent-panel-convs')).toBe(true)

    pane.narrow.value = false
    await nextTick()

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(true)
  })

  it('面板重新打开时回到对话页（关掉时停在列表页也不该"点开就是列表"）', async () => {
    // 面板在 EditorView 里是「懒挂载 + v-show」，挂载状态会被复用 ——
    // 所以重开时必须主动把 page 拉回对话页。
    const w = mountPanel(true)
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')
    expect(shown(w, '.agent-panel-convs')).toBe(true)

    await w.setProps({ active: false })
    await w.setProps({ active: true })
    await nextTick()

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
  })

  it('列表行高正常、带搜索框（并排那一列和整页都不挤）', async () => {
    const w = mountPanel(false)
    await nextTick()
    // :show-search 传的是字面量 true
    expect(w.findComponent({ name: 'ConversationList' }).props('showSearch')).toBe(true)
    // 不传 compact → 组件默认 false = 正常行高
    expect(w.findComponent({ name: 'ConversationList' }).props('compact')).toBeFalsy()
  })
})

describe('EditorAgentPanel 常驻输入框', () => {
  it('宽屏、窄屏对话页、窄屏列表页 —— 三处都在，且是同一个实例', async () => {
    const w = mountPanel(true)
    await nextTick()
    // 窄屏对话页
    expect(shown(w, '.agent-panel-composer')).toBe(true)
    const afterMount = w.findComponent({ name: 'ChatInput' }).vm.$

    // 翻到列表页：输入框不能跟着消失（列表页也要能直接开聊）
    await w.find('.agent-panel-list-btn').trigger('click')
    expect(shown(w, '.agent-panel-composer')).toBe(true)
    // 同一个实例 —— v-show 保状态，草稿与待发附件在翻页时不会丢
    expect(w.findComponent({ name: 'ChatInput' }).vm.$).toBe(afterMount)

    // 变宽成并排：还在
    pane.narrow.value = false
    await nextTick()
    expect(shown(w, '.agent-panel-composer')).toBe(true)
    expect(w.findComponent({ name: 'ChatInput' }).vm.$).toBe(afterMount)
  })

  it('输入框归 ChatInput：placeholder / 排队 props 都传给它，不再传 ChatContainer', async () => {
    const w = mountPanel(false)
    await nextTick()

    const input = w.findComponent({ name: 'ChatInput' })
    expect(input.props('placeholder')).toBe('@AGENT:输入消息，Enter 发送')
    expect(input.props('generating')).toBe(false)
    // 2026-10-07 起：生成中**不再**把输入框 disable 掉 —— 打不了字就谈不上排队
    expect(input.props('disabled')).toBeUndefined()
    // 排队三件套都在这一层：放行发送 / 条带数据 / 条带文案
    expect(input.props('allowQueue')).toBe(true)
    expect(input.props('queued')).toEqual([])
    expect(input.props('queuePaused')).toBe(false)
    expect(input.props('queueLabels')?.title).toBe('@AGENT:排队中')

    const chat = w.findComponent({ name: 'ChatContainer' })
    expect(chat.props('showInput')).toBe(false)
    // 这几个 prop 已经不归 ChatContainer 了（拆出去后它读都不读）
    expect(chat.props('placeholder')).toBeUndefined()
    expect(chat.props('disabled')).toBeUndefined()
    expect(chat.props('generating')).toBeUndefined()
  })

  it('条带上的「移除 / 立即发送」照旧转给 useAgentChat', async () => {
    const w = mountPanel(false)
    await nextTick()

    const input = w.findComponent({ name: 'ChatInput' })
    input.vm.$emit('unqueue', 'q1')
    input.vm.$emit('flush-queued')
    await nextTick()

    expect(agent.removeQueuedMessage).toHaveBeenCalledWith('q1')
    expect(agent.flushQueued).toHaveBeenCalledTimes(1)
  })

  it('库里那条输入框得待在 .acu-root 里（盒模型重置的范围）', async () => {
    const w = mountPanel(false)
    await nextTick()
    // ChatInput 根节点是 div，缺了 acu-root 会退回 content-box、横着溢出面板
    expect(w.find('.agent-panel-composer').classes()).toContain('acu-root')
    expect(w.find('.agent-panel-composer').attributes('data-theme')).toBe('light')
  })

  it('发送 / 停止由 ChatInput 抛出，面板照旧转给 useAgentChat', async () => {
    const w = mountPanel(false)
    await nextTick()

    w.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] })
    await nextTick()
    await nextTick()
    expect(agent.sendMessage).toHaveBeenCalledTimes(1)
    expect(agent.sendMessage.mock.calls[0][0]).toBe('hi')
  })
})

describe('EditorAgentPanel 当前文档卡片', () => {
  it('锚点插在库的输入框容器里（那条常驻 ChatInput），不在标题栏', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()

    // ★ 关键机制：锚点被插进 .acu-input-wrap —— 也就是说卡片真的"在输入框里边"。
    const wrap = w.find('.acu-input-wrap').element as HTMLElement
    const anchor = wrap.querySelector('.agent-context-slot') as HTMLElement
    expect(anchor).toBeTruthy()
    expect(anchor.parentElement).toBe(wrap)

    // Teleport 在单测里被 stub（内容仍渲染），卡片本身由 Vue 渲染
    const card = w.find('.agent-context-att')
    expect(card.exists()).toBe(true)
    expect(card.text()).toBe('a.md')
    // 完整路径留在 title 上
    expect(card.attributes('title')).toBe('src/a.md')

    // 标题栏里一个都不该有
    expect(w.find('.agent-panel-header .agent-context-att').exists()).toBe(false)
    expect(w.find('.agent-panel-header .agent-context-bar').exists()).toBe(false)
  })

  it('有真附件时锚点住进附件行，和附件并排（不是自己单开一行）', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()

    const wrap = w.find('.acu-input-wrap').element as HTMLElement
    // 模拟库在有附件时渲染出的附件行（没附件时它根本不存在）
    const atts = document.createElement('div')
    atts.className = 'acu-input-attachments'
    wrap.insertBefore(atts, wrap.firstChild)

    // 等 MutationObserver 把锚点搬进去
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    const anchor = wrap.querySelector('.agent-context-slot') as HTMLElement
    expect(anchor.parentElement).toBe(atts)
    // 排在附件行第一个位置（附件跟在它后面）
    expect(atts.firstChild).toBe(anchor)

    // 附件全删了 → 附件行消失，锚点回到"自己当一行"，不能跟着一起没了
    atts.remove()
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
    const survivor = wrap.querySelector('.agent-context-slot') as HTMLElement
    expect(survivor).toBeTruthy()
    expect(survivor.parentElement).toBe(wrap)
  })

  it('卡片上有 ✕：点掉后卡片消失、锚点也摘干净（不留一行空白）', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()

    const btn = w.find('.agent-context-att-remove')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('@EDITOR:不引用当前文档')

    await btn.trigger('click')
    await nextTick()
    await nextTick()

    expect(w.find('.agent-context-att').exists()).toBe(false)
    const wrap = w.find('.acu-input-wrap').element as HTMLElement
    expect(wrap.querySelector('.agent-context-slot')).toBeNull()
  })

  it('点掉 ✕ 之后发消息就不带 openFilePath', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()

    await w.find('.agent-context-att-remove').trigger('click')
    await nextTick()

    w.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] })
    await nextTick()
    await nextTick()

    expect(agent.sendMessage).toHaveBeenCalledTimes(1)
    expect(agent.sendMessage.mock.calls[0][2]).toEqual({ openFilePath: undefined })
  })

  it('没点 ✕ 时照旧把当前文档带上去', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()

    w.findComponent({ name: 'ChatInput' }).vm.$emit('send', { text: 'hi', files: [] })
    await nextTick()
    await nextTick()

    expect(agent.sendMessage.mock.calls[0][2]).toEqual({ openFilePath: 'src/a.md' })
  })

  it('换了个打开的文档 → 之前的 ✕ 作废，新文档重新带上', async () => {
    const w = mountPanel(false)
    await nextTick()
    await nextTick()
    await w.find('.agent-context-att-remove').trigger('click')
    await nextTick()
    expect(w.find('.agent-context-att').exists()).toBe(false)

    await w.setProps({ activeFilePath: 'src/b.md', activeFileName: 'b.md' })
    await nextTick()
    await nextTick()

    expect(w.find('.agent-context-att').exists()).toBe(true)
    expect(w.find('.agent-context-att').text()).toBe('b.md')
  })

  it('没有打开文档时不渲染卡片，也不留锚点占位', async () => {
    pane.narrow.value = false
    const w = mountWithSetup(EditorAgentPanel, {
      props: { activeFilePath: null, activeFileName: '', active: true },
      global: { stubs: EL_ICON_STUB },
    })
    await nextTick()
    await nextTick()
    expect(w.find('.agent-context-att').exists()).toBe(false)
    expect((w.find('.acu-input-wrap').element as HTMLElement).querySelector('.agent-context-slot'))
      .toBeNull()
  })
})

// ── 引擎切换（文件空间 g ai 面板）──────────────────────────────
// 用户反馈「文件空间里的 g ai 没有执行器的切换」—— 这里钉住：宽屏与窄屏的对话页常驻、
// 窄屏列表页不出现、选中的引擎传回 useAgentChat、会话锁死后置灰且显示会话自己的引擎。
describe('EditorAgentPanel 引擎选择器', () => {
  it('宽屏头部常驻引擎选择器，默认 g ai、未锁定', async () => {
    const w = mountPanel(false)
    await nextTick()

    const sel = w.findComponent(AgentEngineSelector)
    expect(sel.exists()).toBe(true)
    expect(sel.props('engine')).toBe('gai')
    expect(sel.props('locked')).toBe(false)
    // 真的渲染在下拉按钮里，不是个空壳
    expect(w.find('.agent-engine__name').text()).toBe('g ai')
  })

  it('窄屏切到会话列表页就不显示（列表页没有正在跑的对话）', async () => {
    const w = mountPanel(true)
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')
    await nextTick()

    expect(w.findComponent(AgentEngineSelector).exists()).toBe(false)
  })

  it('选中引擎 → 回传给 pickEngine', async () => {
    const w = mountPanel(false)
    await nextTick()

    w.findComponent(AgentEngineSelector).vm.$emit('select', 'claude')
    await nextTick()

    expect(agent.pickEngine).toHaveBeenCalledWith('claude')
  })

  it('会话已落盘（引擎锁死）→ 选择器置灰，且显示的是这条会话自己的引擎', async () => {
    agent.isEngineLocked.value = true
    agent.currentEngine.value = 'claude'
    // 故意让 pendingEngine 停在别的值：锁定时必须显示 currentEngine
    agent.pendingEngine.value = 'codex'
    const w = mountPanel(false)
    await nextTick()

    const sel = w.findComponent(AgentEngineSelector)
    expect(sel.props('locked')).toBe(true)
    expect(sel.props('engine')).toBe('claude')
    expect(w.find('.agent-engine__btn').attributes('disabled')).toBeDefined()
  })
})
