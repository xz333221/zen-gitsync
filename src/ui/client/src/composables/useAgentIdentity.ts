// 本机 g ai 的身份：昵称 + 头像。**所有显示"这个智能体是谁"的地方都读这里**。
//
// 两个来源：
//   · 没设过头像 —— 用产品自带的 g ai 图标（assets/icons/svg/g-ai.svg，蓝色终端）
//   · 设过 —— 用 peers.json 里的 self.avatar（内置动物图 builtin:… 或上传的 data URL）
//
// 为什么要一个共享的 composable：这个身份出现在五个对话容器（智能体页 / 主 Agent
// 控制台 / 编辑器面板 / 常用目录弹窗 / 工作台任务对话流）、悬浮 dock、顶栏按钮上。
// 各自去 fetch 一次 peers.json 会得到五个可能不一致的副本（改完头像要刷新五次才全变），
// 所以这里只存一份 state，改完调 refreshAgentIdentity() 全站一起变。
import { computed, reactive } from 'vue'
import gAiAvatar from '@/assets/icons/svg/g-ai.svg'
import { resolveAvatar } from '@/utils/peerAvatar'

export const DEFAULT_AGENT_NAME = 'g ai'

interface AgentIdentityState {
  name: string
  avatar: string
  loaded: boolean
}

const state = reactive<AgentIdentityState>({
  name: DEFAULT_AGENT_NAME,
  avatar: '',
  loaded: false
})

let inflight: Promise<void> | null = null

/** 拉一次本机身份（幂等：并发调用共用同一个请求）。 */
export function loadAgentIdentity(): Promise<void> {
  if (state.loaded) return Promise.resolve()
  if (inflight) return inflight
  inflight = fetch('/api/agent-identity')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.success) {
        state.name = String(data.name || '').trim() || DEFAULT_AGENT_NAME
        state.avatar = String(data.avatar || '')
      }
      state.loaded = true
    })
    .catch(() => {
      // 老服务端没有这个端点：保持默认身份，不影响任何界面
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 改完昵称/头像后调用：下次读取拿到新值。 */
export async function refreshAgentIdentity() {
  state.loaded = false
  await loadAgentIdentity()
}

export function useAgentIdentity() {
  void loadAgentIdentity()

  /** 昵称：没设就是 "g ai"。 */
  const name = computed(() => state.name || DEFAULT_AGENT_NAME)

  /** 头像地址：没设（或值认不出）就回落到产品图标。 */
  const avatar = computed(() => {
    const resolved = resolveAvatar(state.avatar)
    return resolved.kind === 'image' ? resolved.src : gAiAvatar
  })

  /** 是否用了自定义头像（顶栏按钮据此决定用 svg 还是 <img>）。 */
  const hasCustomAvatar = computed(() => avatar.value !== gAiAvatar)

  return { name, avatar, hasCustomAvatar }
}
