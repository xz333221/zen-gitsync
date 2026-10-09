// g ai 会话 → 组件库 ConversationList 的映射。
// 「对话」Tab 的侧栏与文件空间里的对话面板共用同一份：
// 两处的标题兜底、时间格式、生成中徽标、来源角标与文案保持一致，不会各自漂移。
import { $t } from '@/lang/static'
import type { ConversationItem, ConversationListLabels, MessageMetaConfig, MessageRailConfig } from 'zen-ai-chat-ui'
import gAiAvatar from '@/assets/icons/svg/g-ai.svg'

/** 侧栏 / 面板里那份会话（字段来自服务端 SessionMeta，允许本地乐观标记） */
export interface AgentSessionLike {
  sessionId: string
  title?: string
  updatedAt?: string
  messageCount?: number
  /** 本地乐观标记：本轮 SSE 还在跑（服务端尚未落盘） */
  isGenerating?: boolean
  source?: string
  model?: string
}

/** 会话时间：同一天只显示时间，7 天内显示"N 天前"，更早显示日期 */
export function formatSessionDate(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    const now = new Date()
    const diff = now.getTime() - d.getTime()
    const pad = (n: number) => String(n).padStart(2, '0')
    if (d.toDateString() === now.toDateString()) {
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    if (diff < 7 * 24 * 60 * 60 * 1000) {
      const days = Math.floor(diff / (24 * 60 * 60 * 1000))
      return days === 0 ? $t('@AGENT:今天') : `${days}${$t('@AGENT:天前')}`
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  } catch {
    return iso
  }
}

/** 会话列表数据：搜索/新建/重命名/删除的交互都在组件里，这里只映射字段 */
export function buildConversationItems(
  sessions: AgentSessionLike[],
  isSessionGenerating: (sessionId: string) => boolean
): ConversationItem[] {
  return sessions.map(s => ({
    id: s.sessionId,
    title: s.title || $t('@AGENT:无标题'),
    meta: `${formatSessionDate(s.updatedAt)} · ${s.messageCount ?? 0} ${$t('@AGENT:条')}`,
    generatingText:
      s.isGenerating || isSessionGenerating(s.sessionId) ? $t('@AGENT:正在生成中...') : '',
    badge: s.source === 'cli' ? 'CLI' : '',
    searchText: s.model,
  }))
}

/** 会话列表文案（走 app 的 i18n） */
export function agentConversationLabels(): Partial<ConversationListLabels> {
  return {
    newConversation: $t('@AGENT:新建会话'),
    searchPlaceholder: $t('@AGENT:搜索会话...'),
    empty: $t('@AGENT:暂无会话'),
    emptyHint: $t('@AGENT:点击上方按钮开始对话'),
    noResult: $t('@AGENT:未找到匹配的会话'),
    loading: $t('@AGENT:加载会话中...'),
    rename: $t('@AGENT:重命名'),
    delete: $t('@AGENT:删除'),
    untitled: $t('@AGENT:无标题'),
  }
}

/** g ai 品牌名（两处对话容器统一用它） */
export const AGENT_ASSISTANT_NAME = 'g ai'

/**
 * g ai 品牌头像 —— 复用仓库自有的产品标识（assets/icons/svg/g-ai.svg，
 * 与顶栏"用 g ai 打开当前目录"按钮、引擎下拉里的内置引擎图标同一张）。
 * 与 AGENT_ASSISTANT_NAME 同源，传给 zen-ai-chat-ui 的 :assistant-avatar；
 * 不传时组件库会回落成默认的闪光小图标。
 */
export const AGENT_ASSISTANT_AVATAR = gAiAvatar

/**
 * 消息侧边条（zen-ai-chat-ui 的 MessageRail）：对话流左边缘一列短横条，
 * **一轮问答一根**，条宽反映这一轮的篇幅；悬停浮出「提问 + 回答摘要」、点击跳到该轮提问。
 *
 * 库默认**关闭**（会话不长时它只是视觉噪音，要接入方显式打开）。这里统一打开：
 * g ai 的会话动辄几十轮、工作台一条任务也会攒出十几轮，正是它有用的场景。
 *
 * 五个对话容器（智能体页 / 主 Agent 控制台 / 编辑器 g ai 面板 / 常用目录弹窗 /
 * 工作台任务对话流）共用这一份 —— 各自写一份的后果不是"参数不一样"，而是**漏一处
 * 就那一页没有**（用户在截图里挨个指出来的就是这么回事）。
 * 只有 1 轮的对话库自己会隐藏（`bars.length > 1`），所以单轮场景无需另做判断。
 */
export const MESSAGE_RAIL_CONFIG: MessageRailConfig = { enable: true }

/**
 * 消息元信息行（zen-ai-chat-ui 的 MessageMeta）：回答气泡下方那行「本轮用时」。
 *
 * 库默认**关闭**（它是新增的可见元素，默认打开会让既有布局多出一行）。这里统一打开：
 * 一轮 g ai 对话动辄跑几分钟（工具循环 + 长思考），"这轮跑了多久"是用户会盯着看的
 * 那个数 —— 流式期间由库按消息的 createdAt 实时跳，跑完用服务端给的 durationMs 定格
 * （见 useAgentChat 的 turn_done 分支）。
 *
 * 两个刻意的选择：
 *   · `visibility: 'always'` —— 库默认跟操作栏一样"悬停才淡入"。可我们要的正是
 *     "等得心焦时抬眼就能看到"，藏起来等于没有；触摸设备上库本来也会退化成常显。
 *   · `items: ['duration']` —— 只留用时。`tokens` 项要 provider 报的真实 usage，
 *     组件库明确拒绝估算（估出来的数字看着像真的、比不显示更糟），而 g ai 目前只在
 *     输入框的上下文占用环上用 usage，没有逐条落盘。
 *
 * 与 MESSAGE_RAIL_CONFIG 同一条约束：四个 g ai 对话容器（智能体页·对话 Tab / 主 Agent
 * 控制台 / 编辑器 g ai 面板 / 常用目录弹窗）共用这一份，漏一处就那一页没有。
 * 拿不到用时的消息（老会话、没落盘的轮次）库那边什么都不显示，不会出现占位符。
 */
export const MESSAGE_META_CONFIG: MessageMetaConfig = {
  enable: true,
  items: ['duration'],
  visibility: 'always',
}

/** 提问面板文案（走 app 的 i18n） */
export function agentQuestionLabels() {
  return {
    title: $t('@AGENT:等待你的回答'),
    placeholder: $t('@AGENT:输入回答'),
    submit: $t('@AGENT:提交回答'),
  }
}

/**
 * 排队条带文案（走 app 的 i18n）。
 *
 * 与上面两份同一套路：四个 g ai 入口（智能体页 / 主 Agent 控制台 / 文件空间面板 /
 * 常用目录弹窗）共用这一份 —— 同一件事在四个地方显示成四种说法，比文案本身不好更要命。
 * 库的默认值是中文，这里逐字段覆盖成当前的界面语言。
 */
export function agentQueueLabels() {
  return {
    title: $t('@AGENT:排队中'),
    hint: $t('@AGENT:本轮结束后依次发送'),
    pausedHint: $t('@AGENT:已暂停，点「立即发送」继续'),
    send: $t('@AGENT:加入队列'),
    flush: $t('@AGENT:立即发送'),
    remove: $t('@AGENT:移出队列'),
  }
}