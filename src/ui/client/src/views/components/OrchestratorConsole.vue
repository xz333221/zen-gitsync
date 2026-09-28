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
  多项目编排台 · 右栏：主 Agent 控制台。

  这里没有"Token 速率 / 预估成本 / 实时响应"这类指标 —— 本地执行引擎
  （claude CLI + jobStore）根本没有采集 token 与费用，编三个漂亮数字出来
  只会让人在排障时被误导。取而代之的是能真算出来的量：活跃执行数、
  今日完成轮次、项目/任务总数，以及每个项目的真实 Git 状态。

  指令模式下这块原来是一条「活动日志」（谁派发了、谁完成了）——
  那些事实看板本身就能看出来，于是换成了**进度报告**：让主 Agent 隔一会儿
  读一次正在跑的 job（工具调用 + 最近输出），写一段"现在到哪一步了"。
  报告由服务端生成（间隔可设、可手动点），前端只渲染，见 composables/useOrchestrator.ts。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { $t } from '@/lang/static'
import { Paperclip, Promotion, Expand, Fold, Setting, Refresh } from '@element-plus/icons-vue'
import type {
  Attachment,
  ProgressReport,
  ProjectPromptEntry,
  ProjectSummary,
} from '@/types/workbench'
import { clockFromIso, formatDurationMs, relativeTimeFromIso } from '@/utils/relativeTime'
import {
  REPORT_INTERVAL_OPTIONS_MS,
  reportErrorKey,
  reportIntervalLabelKey,
  reportIntervalLabelParams,
} from '@/utils/progressReport'
import AttachmentZone from '@/components/AttachmentZone.vue'
import AgentChatSurface from '@/components/AgentChatSurface.vue'
import TaskExecutorPicker from '@/components/TaskExecutorPicker.vue'
import { useWorkbenchAttachments, type AttachmentTarget } from '@/composables/useWorkbenchAttachments'
import { getSelectedTaskExecutor, type TaskExecutorId } from '@/utils/taskExecutor'

const props = defineProps<{
  active: boolean
  runningCount: number
  selectedProject: ProjectSummary | null
  dispatching: boolean
  togglingSchedule: boolean
  /** 今日已完成的执行轮次，由看板统一算好后传入（两处各算一遍必然对不上） */
  todayDone: number
  /**
   * 折叠态：只剩一条竖排收纳条，点它展开。
   * 由看板传进来，**并且看板已经把"竖排（≤860）时不算折叠"算掉了** ——
   * 这里只认这一个布尔值，不再叠一层媒体查询判断，免得两边规则打架。
   */
  collapsed?: boolean
  /** 全局默认提示词（'' = 没设置） */
  defaultPrompt?: string
  /** 各项目的默认提示词，键为归一化项目路径（与 ProjectSummary.key 同口径） */
  projectPrompts?: Record<string, ProjectPromptEntry>
  /** 进度报告历史，新的在前（服务端只回最近 20 份，前端不再裁） */
  reports?: ProgressReport[]
  /** 自动报告间隔（毫秒，0 = 关闭自动报告）。值以服务端为准 */
  reportIntervalMs?: number
  /** 正在生成一份报告（手动触发期间） */
  generatingReport?: boolean
}>()

const emit = defineEmits<{
  'toggle-schedule': [next: boolean]
  /** 点折叠条 / 头部折叠按钮：翻转让看板去决定折叠还是展开 */
  'toggle-collapse': []
  /** 打开「默认提示词」设置弹窗（弹窗由看板持有 —— 它才拿得到项目清单） */
  'open-prompt-settings': []
  /** 点「立即报告」：让主 Agent 现在汇报一次 */
  'generate-report': []
  /** 改自动报告间隔（毫秒，0 = 关闭自动报告）。落盘在服务端，由看板转发 */
  'set-report-interval': [ms: number]
  dispatch: [payload: {
    text: string
    autoRun: boolean
    attachments: Attachment[]
    /**
     * 目标项目路径。选中具体项目时显式带上；选中「全部项目」时**留空**，
     * 由服务端 targetResolver 按指令内容判断落点（指令里点名 > 主 Agent 判断
     * > 默认项目）。前端不做任何猜测 —— 猜出来的落点和服务端算出来的对不上时，
     * 吃亏的是用户。
     */
    projectPath: string
    /** false = 本次派发不附加默认提示词 */
    useDefaultPrompt: boolean
    /** 本次派发用的执行器（claude | opencode），覆盖设置里的默认值 */
    executor: TaskExecutorId
  }]
}>()

const draft = ref('')
const autoRun = ref(true)
/**
 * 本次派发是否附加默认提示词。
 *
 * 默认勾上，留一个"这一次不带"的口子：全局提示词若没法单次关掉，偶尔发一条
 * 纯指令就得先去设置里把它删掉、发完再粘回来。
 */
const useDefaultPrompt = ref(true)

// ── 执行器（claude | opencode | codex）─────────────────────────────────
// 选择的 UI（未安装置灰 / 选中打勾 / 值不可用时回落）全部收口在 TaskExecutorPicker ——
// 它在两处出现：指令模式的派发栏，与对话模式下"g ai 派出去的活由谁跑"。
// 这里只持"当前值"，派发 / 对话时随 payload 交给服务端。
// 与工作台执行按钮共用同一份临时选择（localStorage），两边切了互相跟手。
const selectedExecutor = ref<TaskExecutorId>(getSelectedTaskExecutor())

// ── 工作方式：对话（g ai 派活）/ 指令（人敲一句话派一条）──────────────────
// 两种方式落到的都是同一条派发链路与同一条指令流水，差别只在"谁决定派什么"：
// 对话是 g ai 边聊边派（可多轮、可反问），指令是你自己写好一句话。
// 选择记在 localStorage：控制台是常驻栏，刷新一次就跳回默认值会很烦。
// key 升到 v2：默认方式改成「指令」后，旧的 v1 存着 'chat' 会让新默认不生效。
const MODE_KEY = 'wb.ocMode.v2'
const mode = ref<'chat' | 'command'>((() => {
  try {
    return localStorage.getItem(MODE_KEY) === 'chat' ? 'chat' : 'command'
  } catch {
    // 隐私模式：不记偏好而已，不影响用
    return 'command'
  }
})())
function setMode(next: 'chat' | 'command') {
  mode.value = next
  try { localStorage.setItem(MODE_KEY, next) } catch { /* 同上 */ }
}

// ── 附件 ────────────────────────────────────────────────────────────────
// 派发这一刻任务还不存在，没有 task/sub 可挂 → 先落服务端的暂存区
// （`~/.zen-gitsync/workbench-images/_dispatch/`），派发成功才搬进 `_task-{id}/`。
const draftAttachments = ref<Attachment[]>([])
/** 草稿阶段附件还在服务端暂存区，缩略图/预览必须走暂存端点，不能走任务侧 */
const DRAFT_RAW_BASE = '/api/workbench/orchestrator/attachments'
const attachTarget = computed<AttachmentTarget>(() => ({
  kind: 'draft',
  list: draftAttachments.value,
  // 必须换成新数组：uploadAttachment 是"先 push 再回写"，
  // 若这里赋回同一个引用，Vue 收不到变更、缩略图不会出现。
  replace: (next) => { draftAttachments.value = next },
}))
const {
  isUploading,
  isImageAttachment,
  humanSize,
  onAttachmentPaste,
  onAttachmentDrop,
  removeAttachment,
  pickAttachmentFile,
} = useWorkbenchAttachments()

const attachBusy = computed(() => isUploading('draft'))
const attachDragging = ref(false)

/**
 * 粘贴统一入口。
 *
 * `@paste` 在三个层级上都挂了（textarea / AttachmentZone / .oc__compose），
 * 而 paste 事件**会冒泡** —— 不在第一次处理后就地截断，粘一张图会一路上浮、
 * 被处理两到三次，变成好几份重复附件（去重逻辑挡不住：上传是异步的，
 * 第二次进来看列表还是空的）。所以处理完立刻 stopPropagation，保证"恰好一次"。
 * 不粘贴文件时也只是截断冒泡，不 interfere 文本粘贴的默认行为。
 */
function onPaste(e: ClipboardEvent) {
  e.stopPropagation()
  onAttachmentPaste(e, attachTarget.value)
}
function onDrop(e: DragEvent) {
  attachDragging.value = false
  onAttachmentDrop(e, attachTarget.value)
}
function onPickAttachment() { pickAttachmentFile(attachTarget.value) }
function onRemoveAttachment(att: Attachment) { removeAttachment(attachTarget.value, att) }

/**
 * 清空草稿附件。**由父组件在派发成功后调用** —— 不在这里跟着 draft 一起清：
 * 派发失败（项目目录不存在等）时暂存文件还在，清掉只会让用户重贴一遍。
 */
function clearAttachments() { draftAttachments.value = [] }
defineExpose({ clearAttachments })

// ── 默认提示词：这里只负责"显示会带上什么"与"这次带不带" ──────────────
// 提示词正文一律由服务端在派发时解析后写进任务（resolveDispatchPrompt），
// 前端不自己拼一份 —— 两边各拼一次，迟早会有一边先改了规则。
const projectKey = computed(() => props.selectedProject?.key || '')
const globalPromptText = computed(() => (props.defaultPrompt || '').trim())
const projectPromptText = computed(() => {
  const k = projectKey.value
  return k ? ((props.projectPrompts?.[k]?.prompt) || '').trim() : ''
})
/** 有没有任何一个项目设过提示词（选中「全部项目」时落点未定，只能这么判断） */
const anyProjectPrompt = computed(() =>
  Object.values(props.projectPrompts || {}).some(e => (e?.prompt || '').trim().length > 0)
)
/** 有提示词可附加 —— 决定"附加默认提示词"这个开关值不值得出现 */
const anyPromptConfigured = computed(() => !!globalPromptText.value || anyProjectPrompt.value)

/**
 * 当前会带上的提示词来自哪一级。
 *
 * 「全部项目」时落点还没定（由服务端判断），所以只说**落点项目**而不说某个项目名：
 * 显示的必须是"能保证的事"，而不是替服务端猜一个项目出来。
 */
const promptStateLabel = computed(() => {
  const hasGlobal = !!globalPromptText.value
  const scope = projectKey.value
    ? (projectPromptText.value ? 'project' : 'none')
    : (anyProjectPrompt.value ? 'target' : 'none')
  if (hasGlobal && scope === 'project') return $t('@WORKBENCH:全局 + 本项目')
  if (hasGlobal && scope === 'target') return $t('@WORKBENCH:全局 + 落点项目')
  if (hasGlobal) return $t('@WORKBENCH:全局')
  if (scope === 'project') return $t('@WORKBENCH:本项目')
  if (scope === 'target') return $t('@WORKBENCH:落点项目')
  return $t('@WORKBENCH:未设置')
})

// 落点由服务端判断，前端不为"能不能派发"前置任何目标检查 ——
// 判断不出目标时服务端会退到默认项目，真没有可用项目才回 400 并给出说明
const canSend = computed(
  () => draft.value.trim().length > 0 && !props.dispatching && !attachBusy.value
)
function send() {
  if (!canSend.value) return
  emit('dispatch', {
    text: draft.value.trim(),
    autoRun: autoRun.value,
    attachments: draftAttachments.value,
    // 选中具体项目 = 显式指定；「全部项目」留空，让服务端按指令内容判断落点
    projectPath: props.selectedProject ? props.selectedProject.path : '',
    useDefaultPrompt: useDefaultPrompt.value,
    executor: selectedExecutor.value,
  })
  draft.value = ''
}

/**
 * Enter 直接派发，Shift+Enter 换行。
 *
 * 指令正文基本都是中文，全靠输入法敲 —— IME 组合期间的回车是"选词确认"，
 * 不拦掉的话每选一次词就误发一条指令出去（和「储藏更改」弹窗同一套判断）。
 * Ctrl/Cmd+Enter 是老习惯，一起认，不专门拦。
 */
function onInputKeydown(e: KeyboardEvent) {
  if ((e as any).isComposing || (e as any).keyCode === 229) return
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  send()
}

// ── 输入框高度：手拖过就记住 ────────────────────────────────────────────
// 这块是"主要用来添加任务"的入口，一条指令常常十几行；默认那几行写起来得
// 一边写一边往上滚。textarea 自带的 resize: vertical 能拖，但高度**只活在
// 当前这个 DOM 节点上** —— 刷新页面就回到 rows 给的行数，第二天又得拖一遍。
// 所以把用户拖出来的高度落进 localStorage（和看板的分隔条布局同一个套路）。
//
// 为什么用 ResizeObserver 而不是监听 mouseup：原生拖拽的 mouseup 落在哪儿由
// 浏览器决定，`@mouseup` 未必收到；而高度变了一定会被观察到。
//
// 写盘的两个条件（满足其一即可），各自挡一类脏数据：
//   · inputDragging  —— mousedown 落在右下角那个 grip 上，说明用户正在拖高度，
//     这时量到的一定是他的选择；包括"拖到上限被 max-height 夹住"的情况 ——
//     那也是一次真实的拖拽，该记住。
//   · 没被 max-height 夹住 —— 兜底：万一浏览器没把 mousedown 派给 textarea，
//     只要高度不是被夹出来的，就还是有效值。
// 反过来，**既没在拖、又被夹住**时绝不写盘：那是窗口变矮时 CSS 强加的高度，
// 记下去就把用户真正想要的高度永久覆盖成小的了（窗口小一次，偏好就没了）。
// 夹住的判据是 offsetHeight == max-height（全局 `* { box-sizing: border-box }`，
// 两者同口径，可直接比）。
const INPUT_H_KEY = 'wb.ocInputHeight.v1'
/** 与 CSS 里的 min-height 同值：低于它的量值一律当成"没拖过" */
const OC_INPUT_MIN_H = 76

function readInputH(): number | null {
  try {
    const raw = localStorage.getItem(INPUT_H_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n >= OC_INPUT_MIN_H ? Math.round(n) : null
  } catch {
    // 隐私模式：不记住高度而已，不影响输入
    return null
  }
}

const inputRef = ref<HTMLTextAreaElement | null>(null)
const inputH = ref<number | null>(readInputH())
/** 没拖过时不写内联高度，让它整个交给 CSS（rows + min/max-height） */
const inputStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = {}
  if (inputH.value) s.height = `${inputH.value}px`
  return s
})

let inputRO: ResizeObserver | null = null
let inputDragging = false
let inputROFirst = true

/**
 * 只有落在右下角 grip 上的 mousedown 才算"开始拖高度"。
 * 不判断坐标的话，随便点一下输入框（放下光标）也会把标志位置起来 ——
 * 之后任何一次因窗口变化触发的高度改动都会被当成用户的选择写盘。
 * grip 的实际命中区在浏览器里是十几个像素，这里留 20px 足够宽。
 */
const INPUT_GRIP_PX = 20
function onInputMouseDown(e: MouseEvent) {
  const el = inputRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  inputDragging = r.right - e.clientX <= INPUT_GRIP_PX && r.bottom - e.clientY <= INPUT_GRIP_PX
}
/** 解绑挂在 window 上：拖到元素外面松手也要能收尾（否则标志位会一直留着） */
function onWindowMouseUp() { inputDragging = false }

function commitInputH(el: HTMLTextAreaElement) {
  const next = Math.round(el.offsetHeight)
  if (next < OC_INPUT_MIN_H || next === inputH.value) return
  inputH.value = next
  try { localStorage.setItem(INPUT_H_KEY, String(next)) } catch { /* quota 不该阻塞输入 */ }
}

onMounted(() => {
  const el = inputRef.value
  if (!el) return
  window.addEventListener('mouseup', onWindowMouseUp)
  if (typeof ResizeObserver === 'undefined') return
  inputRO = new ResizeObserver(() => {
    // 首次回调是 observe() 那一刻的初始观测 —— 量到的就是刚渲染出来的高度
    // （可能来自 localStorage，也可能是 CSS 默认），不是用户这一下改的，跳过。
    if (inputROFirst) { inputROFirst = false; return }
    const maxH = parseFloat(getComputedStyle(el).maxHeight)
    const clamped = Number.isFinite(maxH) && el.offsetHeight >= maxH - 1
    if (!inputDragging && clamped) return
    commitInputH(el)
  })
  inputRO.observe(el)
})
onBeforeUnmount(() => {
  window.removeEventListener('mouseup', onWindowMouseUp)
  inputRO?.disconnect()
  inputRO = null
})

// ── 进度报告 ────────────────────────────────────────────────────────────
// 报告正文是服务端模型写的，这里只渲染；能被前端改写的只有两类东西：
//   1. 事实快照（任务标题 / 项目 / 时长 / 工具调用 / 最后一行输出）；
//   2. 失败原因码（errorCode）→ 一句人话（见 utils/progressReport.ts）。
// 服务端**不给**面向界面的句子，否则英文界面会漏出中文。

/** 当前展示的是哪一份。null = 跟着最新走（新报告落地后自动换上来） */
const selectedReportId = ref<string | null>(null)

/**
 * 正在展示的那份报告。
 *
 * selectedId 指向的那份被历史淘汰（上限 20 份）时自动退回最新一份 ——
 * 用的是「找不到就取第一份」而不是「找不到就显示空」，免得面板莫名其妙变白。
 */
const currentReport = computed<ProgressReport | null>(() => {
  const list = props.reports || []
  if (!list.length) return null
  return list.find(r => r.id === selectedReportId.value) || list[0]
})

function pickReport(r: ProgressReport) { selectedReportId.value = r.id }

/** 历史列表里那一行摘要：有正文就取开头，没有就说清为什么没有 */
function reportBrief(r: ProgressReport): string {
  const text = String(r.text || '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > 42 ? text.slice(0, 42) + '…' : text
  if (r.errorCode) return $t(reportErrorKey(r.errorCode))
  return $t('@WORKBENCH:当时没有任务在执行')
}

/**
 * 没有正文时卡片上那句说明。
 * 三种情况的实话各不相同，不能都写成"暂无"：没任务 / 模型挂了 / 正文为空。
 */
function reportNotice(r: ProgressReport): string {
  if (r.errorCode) return $t(reportErrorKey(r.errorCode))
  if (!r.tasks.length) return $t('@WORKBENCH:生成这份报告时没有任务在执行')
  return $t('@WORKBENCH:模型没有返回内容')
}

function onIntervalChange(e: Event) {
  const el = e.target as HTMLSelectElement
  const ms = Number(el.value)
  if (!REPORT_INTERVAL_OPTIONS_MS.includes(ms)) return
  emit('set-report-interval', ms)
}

const gitSummary = computed(() => {
  const p = props.selectedProject
  if (!p) return []
  const out: { label: string; value: string; tone: string }[] = []
  if (p.exists === false) {
    out.push({ label: $t('@WORKBENCH:工作区'), value: $t('@WORKBENCH:目录不存在'), tone: 'danger' })
    return out
  }
  const g = p.git
  if (!g || g.isGitRepo === null) {
    out.push({ label: $t('@WORKBENCH:Git 状态'), value: $t('@WORKBENCH:未知'), tone: '' })
    return out
  }
  if (!g.isGitRepo) {
    out.push({ label: $t('@WORKBENCH:Git 状态'), value: $t('@WORKBENCH:不是 Git 仓库'), tone: '' })
    return out
  }
  out.push({
    label: $t('@WORKBENCH:分支'),
    value: g.detached ? $t('@WORKBENCH:游离 HEAD') : (g.branch || $t('@WORKBENCH:未知')),
    tone: '',
  })
  out.push({
    label: $t('@WORKBENCH:工作区'),
    value: g.changed > 0 ? $t('@WORKBENCH:未提交 {n} 项', { n: g.changed }) : $t('@WORKBENCH:干净'),
    tone: g.changed > 0 ? 'warn' : '',
  })
  if (g.hasUpstream && (g.ahead > 0 || g.behind > 0)) {
    out.push({
      label: $t('@WORKBENCH:与上游'),
      value: $t('@WORKBENCH:领先 {ahead} / 落后 {behind}', { ahead: g.ahead, behind: g.behind }),
      tone: g.behind > 0 ? 'warn' : '',
    })
  }
  return out
})
</script>

<template>
  <aside class="oc" :class="{ 'is-collapsed': collapsed }">
    <!-- 折叠后的收纳条：只剩一枚展开按钮 + 竖排标题，宽度收到 32px。
         折叠不是"把宽度压成 0"—— 那样就再没有能点回来的地方了。 -->
    <button
      v-if="collapsed"
      type="button"
      class="oc__rail"
      :title="$t('@WORKBENCH:展开主 Agent 控制台')"
      :aria-label="$t('@WORKBENCH:展开主 Agent 控制台')"
      :aria-expanded="false"
      @click="emit('toggle-collapse')"
    >
      <el-icon class="oc__rail-icon"><Fold /></el-icon>
      <span class="oc__rail-live" :class="{ 'is-off': !active }" aria-hidden="true" />
      <span class="oc__rail-text">{{ $t('@WORKBENCH:主 Agent 控制台') }}</span>
    </button>

    <!-- 折叠时这几块整体隐藏而不是销毁（v-show 而不是 v-if）：
         草稿指令和已贴的附件都还留着，展开回来能接着发 -->
    <header v-show="!collapsed" class="oc__head">
      <span class="oc__live" :class="{ 'is-off': !active }" aria-hidden="true" />
      <h3 class="oc__title">{{ $t('@WORKBENCH:主 Agent 控制台') }}</h3>
      <button
        type="button"
        class="oc__toggle"
        :disabled="togglingSchedule"
        :title="active ? $t('@WORKBENCH:暂停后派发只建任务，不会自动执行') : $t('@WORKBENCH:恢复后派发会自动执行')"
        @click="emit('toggle-schedule', !active)"
      >{{ active ? $t('@WORKBENCH:暂停调度') : $t('@WORKBENCH:恢复调度') }}</button>
      <button
        type="button"
        class="oc__collapse"
        :title="$t('@WORKBENCH:收起主 Agent 控制台')"
        :aria-label="$t('@WORKBENCH:收起主 Agent 控制台')"
        :aria-expanded="true"
        @click="emit('toggle-collapse')"
      >
        <el-icon><Expand /></el-icon>
      </button>
    </header>

    <div v-show="!collapsed" class="oc__state" :class="{ 'is-paused': !active }">
      <span class="oc__state-label">{{ $t('@WORKBENCH:调度状态') }}</span>
      <span class="oc__state-value">
        {{ active ? $t('@WORKBENCH:调度中') : $t('@WORKBENCH:已暂停') }}
      </span>
      <span class="oc__state-meta">{{ $t('@WORKBENCH:{n} 个执行中', { n: runningCount }) }}</span>
    </div>

    <!-- 工作方式：对话 = g ai 边聊边派（可以多轮、可以反问你）；指令 = 你自己敲一句话派一条。
         两种方式落到的是**同一条派发链路、同一条指令流水**，变的只是"谁决定派什么"。 -->
    <div
      v-show="!collapsed"
      class="oc__mode"
      role="tablist"
      :aria-label="$t('@WORKBENCH:切换主 Agent 控制台的工作方式')"
    >
      <button
        type="button"
        role="tab"
        class="oc__mode-btn"
        :class="{ 'is-active': mode === 'chat' }"
        :aria-selected="mode === 'chat'"
        @click="setMode('chat')"
      >{{ $t('@WORKBENCH:对话') }}</button>
      <button
        type="button"
        role="tab"
        class="oc__mode-btn"
        :class="{ 'is-active': mode === 'command' }"
        :aria-selected="mode === 'command'"
        @click="setMode('command')"
      >{{ $t('@WORKBENCH:指令') }}</button>
    </div>

    <AgentChatSurface
      v-show="!collapsed && mode === 'chat'"
      v-model:dispatch-executor="selectedExecutor"
      class="oc__chat"
      :active="!collapsed && mode === 'chat'"
      allow-dispatch
      :dispatch-use-default-prompt="useDefaultPrompt"
      :title="$t('@WORKBENCH:g ai 对话')"
    />

    <!-- 进度报告：主 Agent 隔一会儿读一遍正在跑的 job，写一段"现在到哪一步了"。
         报告由服务端生成（自动那份由服务端定时器产生），这里只渲染 + 两个入口：
         改间隔、立即报告。 -->
    <div v-show="!collapsed && mode === 'command'" class="oc__report">
      <div class="oc__report-head">
        <p class="oc__panel-title">{{ $t('@WORKBENCH:进度报告') }}</p>
        <!-- 间隔设置。做成下拉而不是输入框：这个值直接决定每多久烧一次模型额度，
             自由填一个 5（分钟写成了秒）会让额度很快见底，而用户不会立刻意识到 -->
        <select
          class="oc__interval"
          :value="String(reportIntervalMs ?? 0)"
          :title="$t('@WORKBENCH:自动报告的间隔（关掉后仍可随时点「立即报告」）')"
          :aria-label="$t('@WORKBENCH:自动报告间隔')"
          @change="onIntervalChange"
        >
          <option v-for="ms in REPORT_INTERVAL_OPTIONS_MS" :key="ms" :value="String(ms)">
            {{ $t(reportIntervalLabelKey(ms), reportIntervalLabelParams(ms)) }}
          </option>
        </select>
        <button
          type="button"
          class="oc__report-run"
          :disabled="generatingReport"
          :title="$t('@WORKBENCH:让主 Agent 现在汇报一次正在执行的任务进度')"
          @click="emit('generate-report')"
        >
          <el-icon class="oc__report-run-icon" :class="{ 'is-spin': generatingReport }"><Refresh /></el-icon>
          <span>{{ generatingReport ? $t('@WORKBENCH:生成中…') : $t('@WORKBENCH:立即报告') }}</span>
        </button>
      </div>

      <ul class="oc__report-list">
        <li v-if="currentReport" class="rp">
          <div class="rp__head">
            <span class="rp__trigger" :class="{ 'is-auto': currentReport.trigger === 'auto' }">
              {{ currentReport.trigger === 'auto' ? $t('@WORKBENCH:自动') : $t('@WORKBENCH:手动') }}
            </span>
            <span class="rp__count">
              {{ $t('@WORKBENCH:{n} 个任务进行中', { n: currentReport.tasks.length }) }}
            </span>
            <span class="rp__time">{{ clockFromIso(currentReport.at) }}</span>
          </div>

          <p v-if="currentReport.text" class="rp__text">{{ currentReport.text }}</p>
          <!-- 没有正文时给的是**实话**：没任务 / 没配模型 / 模型没返回内容，
               三种情况的处理办法完全不同，一律写"暂无"会让人白等 -->
          <p v-else class="rp__notice" :title="currentReport.errorDetail">{{ reportNotice(currentReport) }}</p>

          <ul v-if="currentReport.tasks.length" class="rp__tasks">
            <li v-for="(t, i) in currentReport.tasks" :key="t.taskId || i" class="rpt">
              <p class="rpt__title">{{ t.taskTitle || $t('@WORKBENCH:未命名任务') }}</p>
              <p class="rpt__meta">
                <span v-if="t.projectName" class="rpt__project">{{ t.projectName }}</span>
                <span>{{ $t('@WORKBENCH:已运行 {elapsed}', { elapsed: formatDurationMs(t.elapsedMs) }) }}</span>
                <span v-if="t.agent" class="rpt__agent">{{ t.agent }}</span>
                <span v-if="t.toolCallCount">{{ $t('@WORKBENCH:工具 {n} 次', { n: t.toolCallCount }) }}</span>
              </p>
              <!-- 先给工具调用，再给最后一行输出：前者是"正在做什么"（更准），
                   后者是"最近说了什么"（可能已经过去一会儿了） -->
              <p v-if="t.lastTool" class="rpt__line" :title="t.lastTool">{{ t.lastTool }}</p>
              <p v-else-if="t.lastLine" class="rpt__line" :title="t.lastLine">{{ t.lastLine }}</p>
            </li>
          </ul>
        </li>
        <li v-else class="oc-empty">
          {{ $t('@WORKBENCH:暂无进度报告') }}
        </li>
      </ul>

      <!-- 历史：一行一份，点一条就把它换到上面看。只在有两份以上时出现 ——
           只有一份时这个列表纯粹是噪音 -->
      <div v-if="(reports || []).length > 1" class="oc__history">
        <p class="oc__history-title">{{ $t('@WORKBENCH:历史报告') }}</p>
        <ul class="oc__history-list">
          <li v-for="r in reports" :key="r.id">
            <button
              type="button"
              class="oc__history-item"
              :class="{ 'is-active': r.id === currentReport?.id }"
              @click="pickReport(r)"
            >
              <span class="oc__history-time">{{ clockFromIso(r.at) }}</span>
              <span class="oc__history-sum">{{ reportBrief(r) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div v-show="!collapsed && mode === 'command'" class="oc__git">
      <p class="oc__panel-title">
        {{ $t('@WORKBENCH:项目概览') }}
        <!-- 无选中项目即「全部项目」：显式标出来，否则底下只剩「今日完成」一行，看着像数据没加载出来 -->
        <span class="oc__git-name">{{ selectedProject ? selectedProject.name : $t('@WORKBENCH:全部项目') }}</span>
      </p>
      <dl class="oc__git-list">
        <template v-for="row in gitSummary" :key="row.label">
          <dt class="oc__git-label">{{ row.label }}</dt>
          <dd class="oc__git-value" :class="{ 'is-warn': row.tone === 'warn', 'is-danger': row.tone === 'danger' }">
            {{ row.value }}
          </dd>
        </template>
        <dt class="oc__git-label">{{ $t('@WORKBENCH:今日完成') }}</dt>
        <dd class="oc__git-value">{{ todayDone }}</dd>
        <dt class="oc__git-label">{{ $t('@WORKBENCH:最后活跃') }}</dt>
        <dd class="oc__git-value">
          {{ selectedProject ? relativeTimeFromIso(selectedProject.stats.lastActiveAt) || '—' : '—' }}
        </dd>
      </dl>
    </div>

    <div
      v-show="!collapsed && mode === 'command'"
      class="oc__compose"
      @paste="onPaste"
      @drop.prevent="onDrop"
      @dragover.prevent="attachDragging = true"
      @dragleave="attachDragging = false"
    >
      <!-- 粘贴事件必须同时挂在 textarea 上：在输入框里按 Ctrl+V 时事件只到 textarea，
           不会冒泡经过下面的附件区 -->
      <textarea
        ref="inputRef"
        class="oc__input"
        v-model="draft"
        :style="inputStyle"
        rows="4"
        :placeholder="$t('@WORKBENCH:给主 Agent 下一条指令，例如：把登录模块的错误处理重构一遍')"
        @keydown="onInputKeydown"
        @paste="onPaste"
        @mousedown="onInputMouseDown"
      />
      <AttachmentZone
        v-if="draftAttachments.length > 0 || attachBusy"
        :attachments="draftAttachments"
        :is-image="isImageAttachment"
        :human-size="humanSize"
        :is-uploading="attachBusy"
        :is-paste-hover="attachDragging"
        :max-count="9"
        :on-pick="onPickAttachment"
        :on-remove="onRemoveAttachment"
        :raw-base="DRAFT_RAW_BASE"
        @paste="onPaste"
        @drop="onDrop"
        @dragover.prevent="attachDragging = true"
        @dragenter.prevent="attachDragging = true"
        @dragleave="attachDragging = false"
      />
      <div class="oc__compose-foot">
        <button
          type="button"
          class="oc__attach"
          :disabled="attachBusy || draftAttachments.length >= 9"
          :title="$t('@WORKBENCH:添加附件（也可直接粘贴或拖入文件）')"
          :aria-label="$t('@WORKBENCH:添加附件')"
          @click="onPickAttachment"
        >
          <el-icon><Paperclip /></el-icon>
        </button>
        <!-- 默认提示词设置入口：图标按钮按项目惯例不加底色，
             有没有设过看右侧"附加默认提示词"那个勾选（它是真实生效状态，这个只是入口） -->
        <button
          type="button"
          class="oc__attach"
          :class="{ 'is-on': anyPromptConfigured }"
          :title="$t('@WORKBENCH:设置派发时自动附加的默认提示词（全局 / 各项目）')"
          :aria-label="$t('@WORKBENCH:默认提示词设置')"
          @click="emit('open-prompt-settings')"
        >
          <el-icon><Setting /></el-icon>
        </button>
        <label class="oc__autorn" :title="$t('@WORKBENCH:取消勾选则只建任务草稿，不自动执行')">
          <input type="checkbox" v-model="autoRun" />
          <span>{{ $t('@WORKBENCH:立即执行') }}</span>
        </label>
        <!-- 一条都没设过时不出现：一个永远勾着、点了也没区别的开关只会占地方 -->
        <label
          v-if="anyPromptConfigured"
          class="oc__autorn"
          :title="$t('@WORKBENCH:取消勾选则本次派发的任务不带默认提示词（设置本身不受影响）')"
        >
          <input type="checkbox" v-model="useDefaultPrompt" />
          <span>{{ $t('@WORKBENCH:默认提示词（{state}）', { state: promptStateLabel }) }}</span>
        </label>
        <!-- 执行器：与执行按钮共用同一份临时选择，派发时覆盖设置里的默认值。
             下拉本体收口在 TaskExecutorPicker（对话模式底下那个也是它） -->
        <TaskExecutorPicker
          v-model="selectedExecutor"
          :title="$t('@WORKBENCH:本次派发使用的执行器（与执行按钮的临时切换共用）')"
        />
        <button type="button" class="oc__send" :disabled="!canSend" @click="send">
          <el-icon class="oc__send-icon"><Promotion /></el-icon>
          <span>{{ dispatching ? $t('@WORKBENCH:派发中…') : $t('@WORKBENCH:派发') }}</span>
        </button>
      </div>
      <p class="oc__hint">
        <template v-if="selectedProject">
          {{ $t('@WORKBENCH:指令会在「{name}」下新建一个任务；Enter 派发，Shift+Enter 换行', { name: selectedProject.name }) }}
        </template>
        <template v-else>
          {{ $t('@WORKBENCH:指令落到哪个项目由主 Agent 判断；Enter 派发，Shift+Enter 换行') }}
        </template>
      </p>
    </div>
  </aside>
</template>

<style scoped>
.oc {
  display: flex;
  flex-direction: column;
  /* 宽度由工作台给（--wb-right-w）：窄屏要收窄、手机宽度要铺满，
     写死 300px 的话父级只能靠 :deep 进来压，规则散在两处。
     默认值 300px 是给它单独用（不在工作台里）时的兜底。 */
  width: var(--wb-right-w, 300px);
  flex-shrink: 0;
  min-height: 0;
  border-left: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  /* 折叠/展开的收放动画。拖动分隔条时由工作台在 .board__cols 上挂 is-resizing
     把过渡关掉 —— 否则宽度会慢半拍地追鼠标，拖起来像拽橡皮筋。
     （.board__cols 是祖先元素的选择器，scoped 只给末段的 .oc 加作用域属性，
       所以这条能正常命中，不需要 :deep()） */
  transition: width var(--transition-base) var(--ease-custom);
}
.board__cols.is-resizing .oc { transition: none; }

/* 折叠态：只剩收纳条。宽度 = 收纳条宽度，别用 0 ——
   压成 0 就再没有能点回来的地方了。 */
.oc.is-collapsed { width: 32px; }

/* 收纳条：展开按钮 + 呼吸灯 + 竖排标题，整条都能点 */
.oc__rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  padding: 10px 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.oc__rail:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.oc__rail:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }
.oc__rail-icon { font-size: var(--font-size-base); flex-shrink: 0; }
.oc__rail-live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-success);
  box-shadow: var(--dot-glow-success);
  animation: oc-pulse 1.6s ease-in-out infinite;
}
.oc__rail-live.is-off { background: var(--color-warning); box-shadow: var(--dot-glow-warning); animation: none; }
/* writing-mode 竖排：标题横着放不进 32px */
.oc__rail-text {
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  user-select: none;
}
.oc__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color-light);
  flex-shrink: 0;
}
.oc__live {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-success);
  box-shadow: var(--dot-glow-success);
  animation: oc-pulse 1.6s ease-in-out infinite;
}
.oc__live.is-off { background: var(--color-warning); box-shadow: var(--dot-glow-warning); animation: none; }
@keyframes oc-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.35); }
}
.oc__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.oc__toggle {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  padding: 2px 6px;
  border-radius: var(--radius-base);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.oc__toggle:hover:not(:disabled) { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 10%, transparent); }
.oc__toggle:disabled { opacity: 0.5; cursor: default; }
.oc__toggle:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

/* 折叠按钮：和 .oc__toggle 同款无底色图标按钮，只是换成图标 */
.oc__collapse {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-base);
  font-size: var(--font-size-mid);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.oc__collapse:hover { color: var(--color-primary); }
.oc__collapse:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.oc__state {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  background-image: var(--gradient-accent-soft);
  flex-shrink: 0;
}
.oc__state.is-paused { color: var(--color-warning); }
.oc__state-label { color: var(--text-tertiary); }
.oc__state-value { font-weight: 500; }
.oc__state-meta { margin-left: auto; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

/* 工作方式切换：一个两段式拨片。
   为什么不做成两个独立按钮：它们互斥且只有两档，拨片能一眼看出"现在是哪一档"，
   而两个按钮在窄栏里看起来像"两个动作"（尤其旁边就有一个真的动作按钮「暂停调度」）。 */
.oc__mode {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  margin: 8px 12px 0;
  padding: 2px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color-light);
}
.oc__mode-btn {
  flex: 1;
  height: 22px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: var(--transition-ui-fast);
}
.oc__mode-btn:hover { color: var(--text-secondary); }
.oc__mode-btn.is-active {
  background: var(--bg-panel);
  color: var(--color-primary);
  font-weight: 500;
  box-shadow: var(--shadow-xs, 0 1px 2px rgba(0, 0, 0, 0.06));
}
.oc__mode-btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

/* 对话模式：整块对话面吃满"活动流 + 项目概览 + 派发栏"让出来的那块高度 */
.oc__chat { min-height: 0; }

/* 进度报告：整块吃掉"项目概览 + 派发栏"让出来的高度，内部两段各自滚 ——
   上面是正在看的那一份（可长可短），下面是历史（固定一截，够点就行） */
.oc__report {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 0 0;
}
.oc__panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 6px;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}
/* 标题在报告头部里要让位给右边两个控件：占满剩余宽度把「间隔 + 立即报告」顶到行尾 */
.oc__report-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 6px;
  flex-shrink: 0;
}
.oc__report-head .oc__panel-title { margin: 0; flex: 1; min-width: 0; }

/* 间隔下拉。原生 <select>：弹出层在深色主题下的可读性由 common.scss 的
   `select option` 规则兜着（见 scripts/verify-native-select-popup.cjs） */
.oc__interval {
  flex-shrink: 0;
  height: 22px;
  max-width: 116px;
  padding: 0 2px 0 6px;
  font-size: var(--font-size-xs);
  font-family: inherit;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-pill);
  cursor: pointer;
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.oc__interval:hover { color: var(--text-primary); border-color: var(--border-color); }
.oc__interval:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.oc__report-run {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-pill);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom);
}
.oc__report-run:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
.oc__report-run:disabled { opacity: 0.55; cursor: default; }
.oc__report-run:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.oc__report-run-icon { font-size: var(--font-size-xs); }
/* 生成中：转起来。它可能等上十几秒（一次模型往返），没动静会让人以为按钮没生效 */
.oc__report-run-icon.is-spin { animation: oc-spin 1s linear infinite; }
@keyframes oc-spin {
  to { transform: rotate(360deg); }
}

.oc__report-list {
  list-style: none;
  margin: 0;
  padding: 0 10px 10px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* ── 报告卡片 ─────────────────────────────────────────── */
.rp {
  padding: 8px 9px;
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color-light);
}
.rp__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: var(--font-size-xs);
}
.rp__trigger { color: var(--color-primary); font-weight: 500; }
/* 自动那份是"系统自己说的"，手动那份才是"你刚才要的" —— 颜色分得开，
   回看历史时一眼能认出哪几份是自己点出来的 */
.rp__trigger.is-auto { color: var(--text-tertiary); font-weight: 400; }
.rp__count { color: var(--text-tertiary); }
.rp__time {
  margin-left: auto;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.rp__text {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
}
.rp__notice {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.55;
  color: var(--text-tertiary);
}
/* 事实块：正文写的是"到哪一步了"，这里列的是**凭什么这么说**（哪个任务、跑了多久、
   在调什么工具）。两者对不上时，用户至少能看出是模型在编 */
.rp__tasks {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0 0;
  padding: 8px 0 0;
  border-top: 1px dashed var(--border-color-light);
}
.rpt__title {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rpt__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 1px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.rpt__project { color: var(--text-secondary); }
.rpt__line {
  margin: 2px 0 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

/* ── 历史报告 ─────────────────────────────────────────── */
.oc__history {
  flex-shrink: 0;
  max-height: 132px;
  overflow-y: auto;
  padding: 6px 10px 8px;
  border-top: 1px solid var(--border-color-light);
}
.oc__history-title {
  margin: 0 2px 4px;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
}
.oc__history-list { list-style: none; margin: 0; padding: 0; }
.oc__history-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 3px 6px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom),
              color var(--transition-fast) var(--ease-custom);
}
.oc__history-item:hover { background: var(--bg-subtle); color: var(--text-secondary); }
.oc__history-item.is-active {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--text-primary);
}
.oc__history-item:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }
.oc__history-time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.oc__history-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.oc-empty {
  padding: 20px 10px;
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
  list-style: none;
}

.oc__git {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color-light);
  flex-shrink: 0;
}
.oc__git-name {
  color: var(--text-secondary);
  font-weight: 500;
}
.oc__git-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: var(--font-size-xs);
}
.oc__git-label { color: var(--text-tertiary); }
.oc__git-value {
  margin: 0;
  text-align: right;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc__git-value.is-warn { color: var(--color-warning); }
.oc__git-value.is-danger { color: var(--color-danger-light); }

.oc__compose {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color-light);
  flex-shrink: 0;
}
.oc__input {
  width: 100%;
  /* 右下手拖调高。上限用 min(px, vh) 而不是写死 px：
     这块栏高度是满屏的，固定 380 在小窗口上会把上面的活动流压成一条，
     甚至把输入区自己顶出容器。45vh 保证"上下都能看见"，380px 是宽屏下的实际手拖上限。
     （拖动后的高度由组件记进 localStorage，见 script 里的 INPUT_H_KEY） */
  resize: vertical;
  min-height: 76px;
  max-height: min(380px, 45vh);
  padding: 7px 8px;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--input-bg);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom),
              box-shadow var(--transition-fast) var(--ease-custom);
}
.oc__input:focus {
  border-color: var(--input-border-focus);
  box-shadow: var(--input-shadow-focus);
}
.oc__input::placeholder { color: var(--text-tertiary); }
.oc__compose-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 窄栏（最小 260px）下这一行放不下"附件 + 设置 + 两个勾选 + 派发"，
     换行比把某一项压扁成省略号好读 —— 派发按钮靠 margin-left:auto 仍钉在行尾 */
  flex-wrap: wrap;
  row-gap: 6px;
  margin-top: 6px;
}
/* 回形针：按项目惯例 —— 图标按钮不加底色/边框，只变图标色 */
.oc__attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.oc__attach:hover:not(:disabled) { color: var(--color-primary); }
/* 已设过默认提示词：入口点亮，一次远程状态在图标上就能看出来 */
.oc__attach.is-on { color: var(--color-primary); }
.oc__attach:disabled { opacity: 0.4; cursor: default; }
.oc__attach:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.oc__autorn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.oc__autorn input { cursor: pointer; }
/* 执行器下拉的样式随组件走（TaskExecutorPicker 自带），这里不再留一份 —— 
   同一个下拉在对话模式底下还有一个，样式留在这儿对它无效，只会变成"改了没反应"的死规则 */
.oc__send {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--gradient-accent);
  box-shadow: var(--btn-shadow);
  color: #fff;
  font-size: var(--font-size-sm);
  line-height: 24px;
  padding: 0 12px;
  cursor: pointer;
  transition: box-shadow var(--transition-fast) var(--ease-custom),
              opacity var(--transition-fast) var(--ease-custom);
}
.oc__send:hover:not(:disabled) {
  background: var(--gradient-accent-hover);
  box-shadow: var(--btn-shadow-hover);
}
.oc__send:disabled { opacity: 0.45; cursor: default; }
.oc__send:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.oc__send-icon { font-size: var(--font-size-sm); }
.oc__hint {
  margin: 6px 0 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-tertiary);
}

/* ── 窄屏 ──────────────────────────────────────────── */
/* 手机宽度下工作台改成上下排列（见 WorkbenchBoard 的 .board__cols），
   这条栏从"右侧一条"变成"看板下面一整块"：
   · 左边框换成上边框（分隔线要跟着方向走）
   · --wb-right-w 此时是 100%，所以宽度铺满，不用在这儿改
   · 给一个最小高度，否则内部那条 flex 高度链（feed 滚动 / 输入区钉底）没有参照，
     输入区会被压扁到只剩一行 */
@media (max-width: 860px) {
  .oc {
    border-left: none;
    border-top: 1px solid var(--border-color);
    min-height: 72vh;
  }
  /* 竖排时右栏是一整块铺满，没有"收边"这个方向可收 —— 折叠按钮收起来，
     免得点了没反应（看板那边也把 collapsed 强制成 false，两边一致） */
  .oc__collapse { display: none; }
}
</style>
