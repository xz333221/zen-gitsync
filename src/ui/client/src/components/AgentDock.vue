<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->

<!--
  g ai 悬浮 dock：右下角卡通形象 + 点击展开的对话面板。

  由来：AI 对话入口原本散落五处（活动栏「智能体」tab、编辑器 / 思维导图面板、
  工作台右栏、Git 视图追问区）。2026-10 整合成这一个入口：mascot 常驻右下角，
  面板里挂的就是原「智能体」tab 的 AgentView（五个内部 tab 全保留）。
  思维导图面板（AI 导图草稿提取）与工作台控制台（任务派发）是功能集成面，刻意不并进来。

  几条口径：
  - 会话不丢：AgentView 首次打开才挂载（v-if=everOpened），之后关面板只是整个
    面板 v-show 隐藏，AgentView 常驻不卸载 —— 后台跑着的流继续跑、mascot 徽标
    继续计数，重开原样恢复（与旧 agent pane 的 v-show 常驻同语义）。
    开着面板切底层视图也不影响它（fixed 覆盖层）。
  - 外部发问：Git 视图「AI 项目状态解读」的追问 chips 经 agentDockBus 打开面板
    并把问题发给 AgentView.askQuestion（见 utils/agentDockBus.ts）。
  - 编辑器上下文：App.vue 判定 activeView==='editor' 时传入当前激活文件，
    发送时随消息注入（openFilePath，请求级、不落会话历史）。
  - 尺寸：随视口自适应 —— 宽 clamp(560px, 36vw, 1120px)，高 clamp(600px, 80vh, 1080px)
    （4K 屏上不再是固定 560 的小块）；头部「最大化」铺到活动栏右侧的近满屏
    （≥680 宽 → AgentView 宽屏两栏，就是旧 tab 的完整体验）。最大化态是 ref，开关面板不重置。
  - 关闭四条路：Esc / 再点 mascot / 头部 ✕ / 点击面板外部（活动栏与 EP 弹层豁免 ——
    点视图按钮切视图时对话必须还在右下角）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, defineAsyncComponent } from 'vue'
import { $t } from '@/lang/static'
import { ElTooltip } from 'element-plus'
import { useAgentActivityStore } from '@stores/agentActivity'
import { AGENT_ASSISTANT_AVATAR } from '@/utils/agentConversations'
import { refreshAiContext, ALL_AI_CONTEXT_SECTIONS } from '@/composables/useAiContextSync'
import { agentDockBus } from '@/utils/agentDockBus'
import ViewLoading from '@/components/ViewLoading.vue'

// 与旧 App.vue agent pane 同一套懒加载参数（骨架占位 + 200ms 延迟，秒加载不闪）
const AgentView = defineAsyncComponent({
  loader: () => import('@views/AgentView.vue'),
  loadingComponent: ViewLoading,
  delay: 200,
})

const props = defineProps<{
  /** 编辑器当前激活文件；仅 App.vue 判定 activeView==='editor' 时非空 */
  contextFile?: { path: string; name: string } | null
  /** 视图级补充上下文（思维导图视图的「你在导图视图 + 当前文件是哪个」）。
   *  随每轮请求的 docNote 注入 —— 导图多在项目根之外，openFilePath 会被服务端丢掉。
   *  编辑器视图不传：那边 openFilePath 就够了。 */
  contextNote?: string
  /**
   * 当前所在板块（App 的 activeView）。透传给 AgentView 挑一组贴题的欢迎页预设：
   * 在「系统运行状态」页问"哪些端口被占了"，比"查看项目结构"合理得多。
   * 切 Tab 时会跟着变（AgentView 常驻，靠 props 响应，不需要重开面板）。
   */
  view?: string
}>()

const agentStatus = useAgentActivityStore()
const opened = ref(false)
const maximized = ref(false)
/** 是否曾经打开过：首次打开才挂载 AgentView，之后关面板只是 v-show 隐藏 ——
 *  与旧 agent pane 同语义（常驻不失活），后台跑着的流继续跑、状态不丢 */
const everOpened = ref(false)
const mascotRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const agentViewRef = ref<InstanceType<typeof AgentView> | null>(null)

// ── 徽标与文案（口径从 ActivityBar 原样搬来）────────────────────
const runningText = computed(() => `${agentStatus.runningCount} ${$t('@ACTBAR:个对话正在生成')}`)
const runningBadge = computed(() => (agentStatus.runningCount > 99 ? '99+' : String(agentStatus.runningCount)))
const mascotLabel = computed(() =>
  agentStatus.hasRunning ? `${$t('@ACTBAR:智能体')} · ${runningText.value}` : $t('@ACTBAR:智能体'),
)

function open() {
  if (opened.value) return
  opened.value = true
  everOpened.value = true
  agentDockBus.open = true
  // 原「切到智能体视图 = 全刷 AI 上下文」的语义落在这里
  //（useAiContextSync 的 agent 条目已删，dock 接管）
  refreshAiContext(ALL_AI_CONTEXT_SECTIONS)
  nextTick(() => panelRef.value?.focus())
}

function close() {
  if (!opened.value) return
  opened.value = false
  agentDockBus.open = false
  nextTick(() => mascotRef.value?.focus())
}

function toggle() {
  opened.value ? close() : open()
}

// ── bus：外部「打开 dock 并提问」（Git 视图追问 chips）──────────
// open 只认 true（bus 从不请求关闭）；pending 消费后立刻清，先清后调防重入。
watch(() => agentDockBus.open, (want) => {
  if (want) open()
})

// vm 未就绪（首次打开正在下 chunk）时等 agentViewRef 变化再进
watch([() => agentDockBus.pending, agentViewRef], async ([pending, vm]) => {
  if (!pending || !vm) return
  agentDockBus.pending = null
  try {
    await vm.askQuestion(pending.text, pending)
  } catch {
    console.error('[agent-dock] askQuestion failed')
  }
})

// ── Esc 关闭（焦点归还 mascot）─────────────────────────────────
// 面板里可能开着 EP 弹窗（引擎安装对话框等）：那之际 Esc 归弹窗，不关面板。
// 判据必须是「可见的模态」：这个应用的对话框壳（.el-overlay.el-modal-dialog）
// 会被 KeepAlive 的视图一直留在 DOM 里（display:none），数存在性会恒真。
function isModalOpen(): boolean {
  return [...document.querySelectorAll('.el-overlay')].some((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && opened.value && !isModalOpen()) close()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

// ── 点击面板外部关闭 ─────────────────────────────────────────
// mousedown 先快照「事件开始前面板是否已开」：chips 点击会在同一事件里把面板打开
//（bus → watch → open），若不看快照，随后的 document click 会立刻把它关掉。
let wasOpenAtPress = false
function onPressCapture() {
  wasOpenAtPress = opened.value
}
function onDocClick(e: MouseEvent) {
  if (!wasOpenAtPress || !opened.value) return
  // 这一下是追问 chips 的「打开 dock 并发问」：pending 还没被 watch 消费掉，
  // 关掉就等于把用户刚点的回答藏起来 —— 不关
  if (agentDockBus.pending) return
  const t = e.target as HTMLElement | null
  if (!t) return
  // 目标可能在本次点击里被 Vue 重渲染摘掉（最大化/还原按钮换图标就是：
  // v-if/v-else 的两个 svg 在 click 处理函数里被替换）—— 断开节点问不出
  // 「在不在 dock 里」，保守起见不关（真·外部点击的目标不会被自家渲染摘掉）
  if (!t.isConnected) return
  // Teleport 到 body 的 EP 弹层（引擎下拉 / 对话框 / toast）不算「外部」；
  // 活动栏（切视图）也不算 —— 用户要求「切换视图时对话框仍在右下角」，
  // 左侧那排视图按钮是常驻 shell 的一部分，点它不该把对话面板收走。
  if (t.closest('.agent-dock, .activity-bar, .el-popper, .el-overlay, .el-dialog, .el-message, .el-notification, .el-message-box')) return
  close()
}
onMounted(() => {
  document.addEventListener('mousedown', onPressCapture, true)
  document.addEventListener('click', onDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onPressCapture, true)
  document.removeEventListener('click', onDocClick)
})
</script>

<template>
  <div class="agent-dock">
    <!-- mascot：常驻圆形按钮（无 border，遵守「不要圆角+单层 border 卡片」的偏好） -->
    <ElTooltip placement="left" :content="mascotLabel" :show-after="300">
      <button
        ref="mascotRef"
        type="button"
        class="agent-dock__mascot"
        :class="{ 'is-open': opened }"
        :aria-label="mascotLabel"
        :aria-pressed="opened ? 'true' : 'false'"
        @click="toggle"
      >
        <img class="agent-dock__avatar" :src="AGENT_ASSISTANT_AVATAR" alt="" width="30" height="30" />
        <!-- 正在生成的对话数：切走视图 / 关上面板后仍在跑的轮次，这是唯一可见的信号 -->
        <span
          v-if="agentStatus.hasRunning"
          class="agent-dock__badge"
          :title="runningText"
          aria-hidden="true"
        >{{ runningBadge }}</span>
      </button>
    </ElTooltip>

    <!-- 不用 <Transition> 包裹：v-show 检测到 transition 上下文会把显示控制交给它，
         而单测里 VTU 把 Transition 换成空实现的 TRANSITION-STUB，display 行为会整个反了
         （show 不显示、hide 不隐藏）。入场动画改用 CSS keyframe —— display 由 v-show 直接管，
         元素每次从 display:none 露出时动画自动重放，生产与测试同一副行为。 -->
    <section
      v-show="opened"
      ref="panelRef"
      class="agent-dock__panel"
      :class="{ 'is-maximized': maximized }"
      role="dialog"
      :aria-label="$t('@ACTBAR:智能体')"
      aria-modal="false"
      tabindex="-1"
    >
      <header class="agent-dock__head">
        <img class="agent-dock__head-avatar" :src="AGENT_ASSISTANT_AVATAR" alt="" width="20" height="20" />
        <span class="agent-dock__title">{{ $t('@ACTBAR:智能体') }}</span>
        <span v-if="agentStatus.hasRunning" class="agent-dock__running">{{ runningText }}</span>
        <span class="agent-dock__spacer" />
          <button
            type="button"
            class="agent-dock__icon-btn agent-dock__btn--max"
            :title="maximized ? $t('@ACTBAR:还原对话') : $t('@ACTBAR:最大化对话')"
            :aria-label="maximized ? $t('@ACTBAR:还原对话') : $t('@ACTBAR:最大化对话')"
            @click="maximized = !maximized"
          >
          <!-- 最大化：四角外扩 -->
          <svg v-if="!maximized" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          <!-- 还原：四角内收 -->
          <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
          <button
            type="button"
            class="agent-dock__icon-btn agent-dock__btn--close"
            :title="$t('@ACTBAR:关闭对话')"
            :aria-label="$t('@ACTBAR:关闭对话')"
            @click="close"
          >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>
      <div class="agent-dock__body">
        <!-- v-if 管首次懒挂载；之后关面板只是整个 section v-show 隐藏，
             AgentView 常驻不卸载 —— 流继续跑、会话/输入/滚动全保留 -->
        <AgentView
          v-if="everOpened"
          ref="agentViewRef"
          :context-file-path="props.contextFile?.path"
          :context-file-name="props.contextFile?.name"
          :context-note="props.contextNote"
          :view="props.view"
          :force-narrow="!maximized"
        />
      </div>
    </section>
  </div>
</template>

<style scoped lang="scss">
.agent-dock {
  position: fixed;
  right: var(--spacing-lg);
  /* footer 高 32px + 12px 间隙 */
  bottom: 44px;
  z-index: var(--z-agent-dock);
}

/* ── mascot：圆形头像按钮 ───────────────────────────────── */
.agent-dock__mascot {
  position: relative;
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  /* AI 角色淡底（--role-ai-surface 暗色已覆盖）+ 悬浮阴影，不用描边 */
  background: var(--role-ai-surface);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  transition: transform var(--transition-base) var(--ease-custom), box-shadow var(--transition-base) var(--ease-custom);

  &:hover {
    transform: scale(1.06);
    box-shadow: var(--shadow-hover);
  }

  &:active {
    transform: scale(0.98);
  }

  &.is-open {
    box-shadow: var(--shadow-hover);
  }
}

.agent-dock__avatar {
  display: block;
  pointer-events: none;
}

/* 徽标：几何与配色从 ActivityBar 的 .agent-running-badge 原样搬来
   （紫，避开 Git 蓝 / 终端青 / 工作台绿 / 编辑器橙四色） */
.agent-dock__badge {
  position: absolute;
  top: -2px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: color-mix(in srgb, var(--color-info-light) 55%, #000);
  border-radius: var(--radius-lg);
  box-shadow: 0 0 0 2px var(--bg-container);
  pointer-events: none;
  animation: agent-dock-badge-in var(--transition-base) var(--ease-spring);
  z-index: 1;
}

@keyframes agent-dock-badge-in {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

/* ── 面板 ───────────────────────────────────────────────── */
.agent-dock__panel {
  position: absolute;
  right: 0;
  /* 贴在 mascot 正上方，不随 mascot 尺寸漂移 */
  bottom: calc(100% + 12px);
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 默认 560×720；视口不够时按 calc 收缩 */
  /* 尺寸随屏幕自适应（用户在 4K 屏上反馈 560px 只剩一小块）：
     宽 = clamp(560, 36vw, 1120)，高 = clamp(600, 80vh, 1080)。
     - 1440 / 1600 宽的屏仍是 560-ish（不改变常规屏观感）
     - 2560（4K@150%）→ 922×1080；3840（4K@100%）→ 1120×1080
     - 小屏继续被 max-width / max-height 压住，不会顶穿
     宽度 ≥680 时 AgentView 自动进宽屏两栏（会话列表 | 对话），正好吃下这块尺寸 */
  width: clamp(560px, 36vw, 1120px);
  max-width: calc(100vw - 32px);
  height: clamp(600px, 80vh, 1080px);
  max-height: calc(100vh - 140px);
  background: var(--bg-container);
  border-radius: var(--radius-lg);
  /* 浮层阴影：三层叠加（近处 crisp + 中距 + 远处 ambient），
     暗色由 --shadow-float 覆盖成更厚的黑 + 极淡高光边，不靠 border 分界 */
  box-shadow: var(--shadow-float);
  overflow: hidden;

  /* 最大化：铺满整个窗口（含活动栏与顶栏），四边不留缝、不留圆角。
     2026-10-29 用户要求「全屏就做成整个的全屏」—— 原先是 calc(100vw - 72px)
     的"近满屏"，右侧留 dock 边距、左侧让出 48px 活动栏，看起来仍是一块浮窗。
     用 fixed + inset:0 脱离 dock 的右/下锚点，宽度由视口决定（还原按钮仍在右上角）。
     宽度远大于 680，AgentView 自动进宽屏两栏（会话列表 + 对话并排） */
  &.is-maximized {
    position: fixed;
    inset: 0;
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
    border-radius: 0;
    box-shadow: none;
  }

  &:focus {
    outline: none;
  }
}

.agent-dock__head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  height: 40px;
  padding: 0 var(--spacing-sm) 0 var(--spacing-md);
  border-bottom: 1px solid var(--border-color-light);
}

.agent-dock__head-avatar {
  display: block;
}

.agent-dock__title {
  font-size: var(--font-size-mid);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.agent-dock__running {
  font-size: var(--font-size-xs);
  color: var(--role-ai-ink);
  white-space: nowrap;
}

.agent-dock__spacer {
  flex: 1;
}

/* 头部图标按钮：平铺 + hover 底色（不用圆角+单 border 的卡片感） */
.agent-dock__icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom), color var(--transition-fast) var(--ease-custom);

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
}

.agent-dock__body {
  flex: 1;
  min-height: 0;
  display: flex;
  /* AgentView 根节点 height:100% 撑满 body；flex:1 + min-width:0 保证宽度也吃满
     （KeepAlive / 异步组件都不引入额外 DOM 层，> * 就是 .agent-view / .view-loading） */
}

.agent-dock__body > * {
  flex: 1;
  min-width: 0;
}

/* ── 入场动画 ───────────────────────────────────────────── */
/* 不用 <Transition>（见模板里的注释）：CSS keyframe 挂在面板上，元素每次从
   display:none 露出时自动重放，v-show 直接管 display，生产与测试同一副行为。 */
.agent-dock__panel {
  animation: agent-dock-pop var(--transition-base) var(--ease-custom);
}

@keyframes agent-dock-pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .agent-dock__mascot,
  .agent-dock__badge,
  .agent-dock__icon-btn {
    transition: none;
    animation: none;
  }
  .agent-dock__panel {
    animation: none;
  }
}
</style>
