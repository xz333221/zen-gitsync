<!--
  「复制会话」按钮：把当前这条 g ai 会话拼成可粘贴的 Markdown 放进剪贴板。

  为什么是"拼"而不是"选"：对话区是 v-for 渲染的，用户在中间划一段再点复制的话，
  "复制了半截"比"复制了全部"更难发现 —— 与工作台的「复制执行内容」同一条理由，
  见 utils/agentSessionExport.ts 头部。

  两种范围（右侧小箭头展开菜单），口径沿用那个已落地的功能：
    · 精简（默认，**直接点主按钮就是这个**）：只留对话正文 —— 常用形态；
    · 全量：追加思考与工具调用。一条长会话动辄上百次工具调用，粘给另一个 AI 时基本都是噪音，
      所以不做默认，但也不能不给（有时就是要留档）。

  三个 g ai 对话容器（智能体页 / 主 Agent 控制台 / 文件空间面板）共用这一份 ——
  与 MESSAGE_RAIL_CONFIG、agentQueueLabels 同一个套路：各自抄一遍的后果不是"样式不一样"，
  而是**漏一处就那一页没有按钮**。做成图标按钮是为了塞进那三种高矮不一的头部条。

  「最近项目」面板的追问区（RecentDirectoriesChat）刻意**不接**：那条会话每次开弹窗都是新的、
  没有标题也没有历史列表，它旁边的工具条只放得下「新建对话」。
-->

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { ChatMessage } from 'zen-ai-chat-ui'
import { $t } from '@/lang/static'
import { AGENT_ASSISTANT_NAME } from '@/utils/agentConversations'
import { buildAgentSessionText, type AgentSessionScope } from '@/utils/agentSessionExport'

const props = defineProps<{
  /** 当前会话的消息（useAgentChat 的 messages） */
  messages: ChatMessage[]
  /** 会话标题（左栏列表里那条）。空则导出成「无标题」 */
  title?: string
  /** 这条会话跑在哪个引擎上（内置 g ai / claude / codex …） */
  engine?: string
}>()

/** 刚复制完的标志（图标换成对勾 1.5s）——与工作台那个按钮同一副反馈 */
const flash = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

/**
 * 剪贴板：优先 Clipboard API，失败（非安全上下文 / 权限被拒）退到 textarea + execCommand。
 * 与 JobLogDetails / WorkbenchView 里那两份同源 —— 局域网 IP 访问时页面不是安全上下文，
 * 只有前者会静默失败。
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 权限拒绝 / 非安全上下文 → 走 textarea 兜底 */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

async function doCopy(scope: AgentSessionScope) {
  const text = buildAgentSessionText(
    props.messages || [],
    { title: props.title, engine: props.engine, assistantName: AGENT_ASSISTANT_NAME },
    { scope }
  )
  // 空串 = 这条会话一条有内容的消息都没有（刚新建 / 还没跑过）：
  // 提示一句，不把空串写进剪贴板 —— 那样用户粘出来是空白，还以为复制成功了。
  if (!text) {
    ElMessage.warning($t('@AGENT:暂无会话内容可复制'))
    return
  }
  const ok = await copyToClipboard(text)
  if (!ok) {
    ElMessage.error($t('@AGENT:复制失败'))
    return
  }
  flash.value = true
  ElMessage.success($t('@AGENT:已复制会话'))
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    flash.value = false
    timer = null
  }, 1500)
}

/** 下拉菜单选了某个范围（命令值就是 `AgentSessionScope`） */
function onCommand(cmd: string | number | object) {
  doCopy(cmd === 'full' ? 'full' : 'brief')
}
</script>

<template>
  <div class="csb">
    <button
      type="button"
      class="csb__btn"
      :class="{ 'is-flash': flash }"
      :title="$t('@AGENT:复制本会话的对话内容（默认精简：仅对话正文）')"
      :aria-label="$t('@AGENT:复制会话')"
      @click="doCopy('brief')"
    >
      <svg v-if="flash" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
    <el-dropdown trigger="click" placement="bottom-end" @command="onCommand">
      <button
        type="button"
        class="csb__btn csb__caret"
        :title="$t('@AGENT:选择复制范围')"
        :aria-label="$t('@AGENT:选择复制范围')"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="brief">{{ $t('@AGENT:精简：对话正文') }}</el-dropdown-item>
          <el-dropdown-item command="full">{{ $t('@AGENT:全量：对话正文 + 思考 + 工具调用') }}</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped>
/* 两个 22px 的图标按钮连成一组：主按钮（复制）+ 小箭头（选范围），
   与工作台那个「复制执行内容 + 箭头」同构，只是收成了纯图标 —— 三种头部条都只有 22~32px 高。 */
.csb {
  display: inline-flex;
  align-items: center;
  flex: none;
}
.csb__btn {
  width: 22px;
  height: 22px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-meta);
  cursor: pointer;
  transition: var(--transition-ui-fast);
}
.csb__btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.csb__btn.is-flash {
  color: var(--color-success);
}
/* 箭头比主按钮窄一点：它只是主按钮的附属，等宽会显得是两个并列动作 */
.csb__caret {
  width: 15px;
}
</style>
