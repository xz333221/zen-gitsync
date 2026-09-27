// EditorAgentPanel「恒两页」的回归测试。
//
// 这块面板挂在文件空间里跟 Monaco 分宽度，**天生就窄**。原先的形态是
// 「列表压在上面（38% 高）+ 对话在下面」—— 列表一展开就只剩两三行对话，
// 现在恒定拆成两个整页：会话列表页 ↔ 对话页，头部按钮来回翻。
//
// 这里不 mock useNarrowPane，因为面板已经不再依赖它 —— 如果哪天有人把
// 宽度判断加回来，这些用例会立刻红（恒两页是**不依赖宽度**的语义）。
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
}))

vi.mock('@/composables/useThemeObserver', async () => {
  const { ref } = await import('vue')
  return { useThemeObserver: () => ({ theme: ref('light') }) }
})

vi.mock('@/composables/useAgentChat', async () => {
  const { ref } = await import('vue')
  agent.loadSession = vi.fn().mockResolvedValue(undefined)
  agent.newSession = vi.fn()
  agent.sendMessage = vi.fn().mockResolvedValue(undefined)
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
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadSession: agent.loadSession,
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      newSession: agent.newSession,
      sendMessage: agent.sendMessage,
      answerQuestion: vi.fn(),
      stop: vi.fn(),
    }),
  }
})

vi.mock('zen-ai-chat-ui', () => ({
  ChatContainer: {
    // 带上 .acu-input-wrap：面板要把"当前文档"锚点插进这个容器里，
    // 假组件没有它就等于把这条机制从单测里摘掉了。
    name: 'ChatContainer',
    template: '<div class="stub-chat"><div class="acu-input-wrap"></div></div>',
    methods: { scrollToBottom() {} },
  },
  ConversationList: {
    name: 'ConversationList',
    props: ['items', 'activeId', 'loading', 'labels', 'compact', 'showSearch'],
    template: '<div class="stub-conv" />',
  },
}))

import EditorAgentPanel from './EditorAgentPanel.vue'

// 读源码原文用（jsdom 里量不出宽度，只能从"有没有引入宽度判断"这个角度守）
const PANEL_SRC = Object.values(
  import.meta.glob('./EditorAgentPanel.vue', { query: '?raw', import: 'default', eager: true })
)[0] as string

function mountPanel() {
  return mountWithSetup(EditorAgentPanel, {
    props: { activeFilePath: 'src/a.md', activeFileName: 'a.md', active: true },
  })
}

/** 两个整页谁在台面上 —— v-show 的真相就是 inline style */
function shown(w: VueWrapper<any>, sel: string): boolean {
  return (w.find(sel).element as HTMLElement).style.display !== 'none'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('EditorAgentPanel 恒两页', () => {
  it('默认落在对话页：列表让位，头部是「g ai 对话」+ 列表按钮', async () => {
    const w = mountPanel()
    await nextTick()

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
    expect(w.find('.agent-panel-title').text()).toBe('@EDITOR:g ai 对话')
    // 返回箭头是列表页才有的
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
    expect(w.find('.agent-panel-list-btn').exists()).toBe(true)
  })

  it('不再有 is-narrow：恒两页与面板宽度无关', async () => {
    const w = mountPanel()
    await nextTick()
    expect(w.find('.editor-agent-panel').classes()).not.toContain('is-narrow')
    // 源码里也不该再有宽度判断：这层"恒两页"的语义一旦被宽度分支取代，
    // 宽面板又会退回到"列表压上面"，而 jsdom 量不出宽度、行为用例抓不到。
    expect(PANEL_SRC).not.toContain('useNarrowPane')
    expect(PANEL_SRC).not.toContain('is-narrow')
  })

  it('点头部按钮翻到会话列表页，头部让给「返回对话 + 会话列表」', async () => {
    const w = mountPanel()
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')

    expect(shown(w, '.agent-panel-convs')).toBe(true)
    expect(shown(w, '.agent-panel-chat')).toBe(false)
    expect(w.find('.agent-panel-back-btn').exists()).toBe(true)
    expect(w.find('.agent-panel-title').text()).toBe('@EDITOR:会话列表')
    // 列表按钮自己也要退场（否则同一页上出现两个方向相反的按钮）
    expect(w.find('.agent-panel-list-btn').exists()).toBe(false)
  })

  it('列表页点 ← 返回对话 → 回到对话页', async () => {
    const w = mountPanel()
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')
    await w.find('.agent-panel-back-btn').trigger('click')

    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
    expect(w.find('.agent-panel-back-btn').exists()).toBe(false)
  })

  it('列表页点会话 → 打开会话并翻回对话页', async () => {
    const w = mountPanel()
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')

    w.findComponent({ name: 'ConversationList' }).vm.$emit('select', 's1')
    await nextTick()

    expect(agent.loadSession).toHaveBeenCalledWith('s1')
    expect(shown(w, '.agent-panel-chat')).toBe(true)
    expect(shown(w, '.agent-panel-convs')).toBe(false)
  })

  it('列表页点新建 → 建完直接进对话页', async () => {
    const w = mountPanel()
    await nextTick()
    await w.find('.agent-panel-list-btn').trigger('click')

    w.findComponent({ name: 'ConversationList' }).vm.$emit('new')
    await nextTick()

    expect(agent.newSession).toHaveBeenCalled()
    expect(shown(w, '.agent-panel-chat')).toBe(true)
  })

  it('列表是整页：带搜索框、行高正常（没理由再挤）', async () => {
    const w = mountPanel()
    await nextTick()
    // :show-search 传的是字面量 true
    expect(w.findComponent({ name: 'ConversationList' }).props('showSearch')).toBe(true)
    // 不再传 compact → 组件默认 false = 正常行高
    expect(w.findComponent({ name: 'ConversationList' }).props('compact')).toBeFalsy()
  })

  it('面板重新打开时回到对话页（关掉时停在列表页也不该"点开就是列表"）', async () => {
    // 面板在 EditorView 里是「懒挂载 + v-show」，挂载状态会被复用 ——
    // 所以重开时必须主动把 page 拉回对话页。
    const w = mountPanel()
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

  it('当前文档做成附件卡片：锚点插在库的输入框容器里，不在标题栏', async () => {
    const w = mountPanel()
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
    const w = mountPanel()
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
    const w = mountPanel()
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
    const w = mountPanel()
    await nextTick()
    await nextTick()

    await w.find('.agent-context-att-remove').trigger('click')
    await nextTick()

    w.findComponent({ name: 'ChatContainer' }).vm.$emit('send', { text: 'hi', files: [] })
    await nextTick()
    await nextTick()

    expect(agent.sendMessage).toHaveBeenCalledTimes(1)
    expect(agent.sendMessage.mock.calls[0][2]).toEqual({ openFilePath: undefined })
  })

  it('没点 ✕ 时照旧把当前文档带上去', async () => {
    const w = mountPanel()
    await nextTick()
    await nextTick()

    w.findComponent({ name: 'ChatContainer' }).vm.$emit('send', { text: 'hi', files: [] })
    await nextTick()
    await nextTick()

    expect(agent.sendMessage.mock.calls[0][2]).toEqual({ openFilePath: 'src/a.md' })
  })

  it('换了个打开的文档 → 之前的 ✕ 作废，新文档重新带上', async () => {
    const w = mountPanel()
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
    const w = mountWithSetup(EditorAgentPanel, {
      props: { activeFilePath: null, activeFileName: '', active: true },
    })
    await nextTick()
    await nextTick()
    expect(w.find('.agent-context-att').exists()).toBe(false)
    expect((w.find('.acu-input-wrap').element as HTMLElement).querySelector('.agent-context-slot'))
      .toBeNull()
  })
})
