// RecentDirectoriesChat.vue 回归测试。
//
// 守三条契约（都是"错了不会报错、只会静默做错事"的那种）：
//   1. 这一轮必须**固定用内置 g ai**：用户在智能体视图里选了 claude/codex，
//      不该在这块地方静默生效（权限档与续聊口径完全不同）。engine 漏了就会走 currentEngine。
//   2. 每轮都要把**眼前这份目录状态**与服务端对得上：dirStatus 漏了，模型就只能凭目录名瞎猜；
//      dirSummary 传了半截/空的原文，模型会对着"还没说完的一句话"回答"那第二个呢"。
//   3. 关弹窗（组件卸载）要停掉还在跑的那一轮 —— 否则服务端跑完落盘，用户回来时
//      那条会话已经躺在智能体视图里，而他记得自己明明关掉了。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const agent = vi.hoisted(() => ({
  sendMessage: null as any,
  stop: null as any,
}))

vi.mock('@/lang/static', () => ({ $t: (key: string) => key }))

vi.mock('@/composables/useThemeObserver', async () => {
  const { ref } = await import('vue')
  return { useThemeObserver: () => ({ theme: ref('light') }) }
})

vi.mock('@/composables/useAgentChat', async () => {
  const { ref } = await import('vue')
  agent.sendMessage = vi.fn().mockResolvedValue(undefined)
  agent.stop = vi.fn()
  return {
    useAgentChat: () => ({
      messages: ref([]),
      isStreaming: ref(false),
      pendingQuestion: ref(null),
      answeringQuestion: ref(false),
      sendMessage: agent.sendMessage,
      answerQuestion: vi.fn(),
      stop: agent.stop,
    }),
  }
})

// 只留一个能收 send 事件的壳：这个用例测的是"往外发什么"，不是组件库怎么渲染
vi.mock('zen-ai-chat-ui', () => ({
  ChatContainer: {
    name: 'ChatContainer',
    props: ['messages', 'uploadConfig', 'presetQuestions', 'placeholder'],
    template: '<div class="chat-stub" />',
  },
}))

import RecentDirectoriesChat from './RecentDirectoriesChat.vue'

const ITEMS = [
  { path: 'C:\\ws\\a', exists: true, git: { isGitRepo: true, branch: 'main', upstream: 'origin/main', changed: 0, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 3 } },
]

function mountChat(props: Record<string, unknown> = {}) {
  return mount(RecentDirectoriesChat, {
    props: { dirStatus: ITEMS, summary: '这 1 个目录里有 1 个需要处理。', ...props } as any,
  })
}

async function send(wrapper: ReturnType<typeof mountChat>, text = '先处理哪个?') {
  wrapper.findComponent({ name: 'ChatContainer' }).vm.$emit('send', { text, files: [] })
  await flushPromises()
}

describe('RecentDirectoriesChat.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('RDC-01: 固定用内置 g ai，且把眼前这份目录状态与解读原文一起带上', async () => {
    const wrapper = mountChat()
    await send(wrapper)

    expect(agent.sendMessage).toHaveBeenCalledTimes(1)
    const [text, files, options] = agent.sendMessage.mock.calls[0]
    expect(text).toBe('先处理哪个?')
    expect(files).toEqual([])
    expect(options.engine).toBe('gai')
    expect(options.dirStatus).toEqual(ITEMS)
    expect(options.dirSummary).toBe('这 1 个目录里有 1 个需要处理。')
    wrapper.unmount()
  })

  test('RDC-02: 没有解读原文时不带 dirSummary（别给模型一段空的"用户看到的解读"）', async () => {
    const wrapper = mountChat({ summary: '' })
    await send(wrapper)

    const options = agent.sendMessage.mock.calls[0][2]
    expect(options.dirSummary).toBe('')
    expect(options.dirStatus).toEqual(ITEMS)
    wrapper.unmount()
  })

  test('RDC-03: 卸载（关弹窗）时停掉还在跑的那一轮', () => {
    const wrapper = mountChat()
    expect(agent.stop).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(agent.stop).toHaveBeenCalledTimes(1)
  })
})
