// g ai 会话 → 组件库 ConversationList 的映射。
// 「对话」Tab 的侧栏与文件空间里的对话面板共用同一份：
// 两处的标题兜底、时间格式、生成中徽标、来源角标与文案保持一致，不会各自漂移。
import { $t } from '@/lang/static'
import type { ConversationItem, ConversationListLabels } from 'zen-ai-chat-ui'
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