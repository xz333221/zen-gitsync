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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { Paperclip, Promotion, Expand, Fold, Setting, Refresh, ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import type {
  Attachment,
  ProgressReport,
  ProjectPromptEntry,
  ProjectSummary,
  RunningAgent,
} from '@/types/workbench'
import { clockFromIso, formatDurationMs, relativeTimeFromIso } from '@/utils/relativeTime'
import {
  REPORT_INTERVAL_OPTIONS_MS,
  REPORT_PERCENT_HINT_KEY,
  REPORT_PERCENT_LABEL_KEY,
  reportErrorKey,
  reportIntervalLabelKey,
  reportIntervalLabelParams,
  reportPercent,
  reportSilentMs,
} from '@/utils/progressReport'
import AttachmentZone from '@/components/AttachmentZone.vue'
import AgentChatSurface from '@/components/AgentChatSurface.vue'
import TaskExecutorPicker from '@/components/TaskExecutorPicker.vue'
import { useWorkbenchAttachments, type AttachmentTarget } from '@/composables/useWorkbenchAttachments'
import { useTaskExecutorSelection } from '@/composables/useTaskExecutorSelection'
import type { TaskExecutorId } from '@/utils/taskExecutor'

const props = defineProps<{
  active: boolean
  /**
   * 正在执行的执行体（5s 轮询下发的 running 列表）。
   *
   * 传**列表**而不是只传一个数字：面板判"这份报告还算不算当前"要看的是
   * "它讲的那个 job 还在不在跑"（见 reportIsLive），光有个数字判不出来。
   * 「{n} 个执行中」那个数是这份列表长度的投影，面板里直接读 length，
   * 不再单独收第二个来源（两个来源必然对不上）。
   */
  running: RunningAgent[]
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
  /** 全局预设提示词（'' = 没设置） */
  defaultPrompt?: string
  /** 各项目的预设提示词，键为归一化项目路径（与 ProjectSummary.key 同口径） */
  projectPrompts?: Record<string, ProjectPromptEntry>
  /** 进度报告历史，新的在前（服务端只回最近 20 份，前端不再裁） */
  reports?: ProgressReport[]
  /** 自动报告间隔（毫秒，0 = 关闭自动报告）。值以服务端为准 */
  reportIntervalMs?: number
  /** 正在生成一份报告（手动触发期间） */
  generatingReport?: boolean
  /**
   * 指令正文上限（字符），**由父组件从服务端状态透传**。
   *
   * 为什么不在组件里写死：派发校验在服务端（dispatchInstruction.js），
   * 两边各写一份必然漂开，漂开的表现是"界面说还有余量、点下去服务端 400"。
   * 缺省值只在"父组件还没拿到状态"的那一瞬间起作用（DEFAULT 兜底由父组件给）。
   */
  maxInstructionChars?: number
}>()

const emit = defineEmits<{
  'toggle-schedule': [next: boolean]
  /** 点折叠条 / 头部折叠按钮：翻转让看板去决定折叠还是展开 */
  'toggle-collapse': []
  /** 打开「预设提示词」设置弹窗（弹窗由看板持有 —— 它才拿得到项目清单） */
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
    /** false = 本次派发不附加预设提示词 */
    useDefaultPrompt: boolean
    /** 本次派发用的执行器（claude | opencode），覆盖设置里的默认值 */
    executor: TaskExecutorId
  }]
}>()

// 指令正文草稿。**派发成功后才清**（见 clearDraft）—— 失败时留着让用户改一改再发。
const draft = ref('')
const autoRun = ref(true)
/**
 * 本次派发是否附加预设提示词。
 *
 * 默认勾上，留一个"这一次不带"的口子：全局提示词若没法单次关掉，偶尔发一条
 * 纯指令就得先去设置里把它删掉、发完再粘回来。
 */
const useDefaultPrompt = ref(true)

// ── 执行器（claude | opencode | codex）─────────────────────────────────
// 选择的 UI（未安装置灰 / 选中打勾 / 值不可用时回落）全部收口在 TaskExecutorPicker，
// 它在两处出现：指令模式的派发栏，与对话模式下"g ai 派出去的活由谁跑"。
// 这里只读当前值，派发 / 对话时随 payload 交给服务端。
// 与工作台执行按钮、看板卡片「执行」共用同一份选择（config.json 的 ui.lastTaskExecutor），
// 任何一处切了另外两处立刻跟手 —— 连"换个端口重开还在"也一起做到了（见 composable 头注释）。
const { active: selectedExecutor } = useTaskExecutorSelection()

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

/**
 * 清空指令正文草稿。**由父组件在派发成功后调用**，与 clearAttachments 同一口径。
 *
 * 为什么不在 send() 里顺手清：失败时（超长 / 目录不存在 / 落点判不出）正文必须留着
 * 让用户改一改再发。清空是"成功"的一部分，不是"点了按钮"的一部分。
 */
function clearDraft() { draft.value = '' }

defineExpose({ clearAttachments, clearDraft })

// ── 预设提示词：这里只负责"显示会带上什么"与"这次带不带" ──────────────
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
/** 有提示词可附加 —— 决定"附加预设提示词"这个开关值不值得出现 */
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

// ── 字数：上限以服务端为准，本地只做提前提醒 ──────────────────────────
//
// 为什么不在这里直接拦：上限归服务端定（派发校验在 dispatchInstruction.js），
// 前端再写一份数字必然漂开，漂开的表现是"界面显示还有余量、点下去服务端 400"。
// 所以这里只用它做**视觉提醒 + 禁用按钮**，真正的闸门始终在服务端。
const draftChars = computed(() => draft.value.trim().length)
// 兜底上限：父组件还没把服务端状态传下来时（首帧）用它，别让计数器显示成 0。
// 与 useOrchestrator 的 DEFAULT_MAX_INSTRUCTION_CHARS 同值 —— 服务端一下发就被覆盖。
const charLimit = computed(() => props.maxInstructionChars || 100000)
// 超过上限：按钮禁用 + 计数器转红。差一点点（≥90%）也转黄，给个"快满了"的信号。
const overLimit = computed(() => draftChars.value > charLimit.value)
const nearLimit = computed(
  () => !overLimit.value && draftChars.value >= charLimit.value * 0.9
)

// 落点由服务端判断，前端不为"能不能派发"前置任何目标检查 ——
// 判断不出目标时服务端会退到默认项目，真没有可用项目才回 400 并给出说明
const canSend = computed(
  () => draft.value.trim().length > 0 && !props.dispatching && !attachBusy.value && !overLimit.value
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
  // ⚠️ 这里**不清空** draft。
  //
  // 2026-09-29 修：原来 emit 之后立刻 draft.value = ''，于是服务端 400
  // （超长 / 目录不存在 / 落点判不出）时正文已经被抹掉了 —— 用户粘了一大段，
  // 点一下全没了，还得重新粘一遍，而超长恰恰是最容易失败的那一类。
  //
  // 现在改成"派发成功才清"，与草稿附件同一套口径（clearAttachments 也是由父组件
  // 在拿到结果后调用）。代价是失败时草稿留在框里，这正是想要的：改一改还能再发。
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

/** 「{n} 个执行中」那个数。唯一的出处是 props.running 的长度（见 props 上的注释） */
const runningCount = computed(() => (props.running || []).length)

/**
 * 正在跑的 job / 任务两套 id。
 *
 * 两边同源：报告事实（progressReport.buildRunningFacts）与在跑列表
 * （index.js 的 buildRunningAgents）读的是同一份合并后的执行记录，所以 id 能直接比。
 */
const runningIds = computed(() => {
  const list = props.running || []
  return {
    job: new Set(list.map(j => j.jobId).filter(Boolean)),
    task: new Set(list.map(j => j.taskId).filter(Boolean)),
  }
})

/**
 * 这份报告讲的活**现在还在不在跑**。
 *
 * 报告是"生成那一刻"的事实快照：任务跑完之后它描述的一切都已经过期，
 * 而卡片头上那句「{n} 个任务进行中」会变成一句谎话
 * （用户 2026-10-03 反馈："我任务完成的时候还显示之前的进度报告"）。
 *
 * 判据用 jobId：同一个任务重跑一轮会换一个 job，只比 taskId 会把上一轮的报告
 * 认成当前的。老记录没有 jobId，退回比 taskId；两个都没有就当它过期。
 */
function reportIsLive(r: ProgressReport | null | undefined): boolean {
  if (!r) return false
  const ids = runningIds.value
  return (r.tasks || []).some(t =>
    (t.jobId && ids.job.has(t.jobId)) || (!t.jobId && !!t.taskId && ids.task.has(t.taskId))
  )
}

/**
 * 跟着最新走时该挂哪一份：**最新那份还"活着"的**报告。
 *
 * 只按"最新的"取会踩同一个坑：任务 A 跑完、任务 B 刚起，而最新那份讲的是 A，
 * 于是主位立刻又挂回上一轮的报告 —— 换个由头重复用户抱怨的那件事。
 * 从新的那批往回找，找不到就空着（面板会说实话，见 idleHint）。
 */
const liveReport = computed<ProgressReport | null>(() => {
  const list = props.reports || []
  return list.find(reportIsLive) || null
})

/**
 * 正在展示的那份报告。
 *
 * 优先级：用户从历史里点的那份 → 最新那份还活着的。
 * 点过的那份即便被历史淘汰（上限 20 份）找不到了，也只是退回"跟随活着的"，
 * 而不是凭空显示一份过期的（那正是这次要修掉的行为）。
 */
const currentReport = computed<ProgressReport | null>(() => {
  const list = props.reports || []
  if (!list.length) return null
  if (selectedReportId.value) {
    const picked = list.find(r => r.id === selectedReportId.value)
    if (picked) return picked
  }
  return liveReport.value
})

/** 主位上这份已经过期（只有用户主动点开历史时才会出现这种情况） */
const currentReportStale = computed(() => !!currentReport.value && !reportIsLive(currentReport.value))

/**
 * 主位空着时说的那句话 —— 两种"现在没有当前报告"的原因完全不是一回事：
 *   · 一份报告都没有 → 说"暂无"；
 *   · 有历史但最新的那份讲的任务都跑完了 → 说"当前没有正在执行的任务"
 *     （此刻确实还有新任务在跑，只是还没有覆盖到它们的那份 → 第三句）。
 * 一律写"暂无"会让人以为面板坏了，或者白等一份永远不会来的报告。
 */
const idleHint = computed(() => {
  if (!(props.reports || []).length) return $t('@WORKBENCH:暂无进度报告')
  return runningCount.value > 0
    ? $t('@WORKBENCH:这批任务还没有进度报告')
    : $t('@WORKBENCH:当前没有正在执行的任务')
})
/** 上面那句话的悬停说明：交代"上一份去哪了"，免得被当成加载失败 */
const idleHintTitle = computed(() =>
  (props.reports || []).length ? $t('@WORKBENCH:最新那份报告讲的任务已经跑完了，要回看可以从历史报告里点开') : ''
)

function pickReport(r: ProgressReport) { selectedReportId.value = r.id }

/**
 * 报告正文的折叠态（默认露 6 行）。
 *
 * 为什么折：右栏只有 ~300px 宽，模型那种"任务1…任务2…任务3…"连着几段的汇报
 * 不截一下会把下面三组任务事实整个顶出视口，而事实才是扫得动的那部分。
 *
 * 截没截断**不猜**：量真实高度（scrollHeight > clientHeight）。宽度是工作台给的
 * --wb-right-w，同一段文字在宽窄两栏下截断点不一样，所以用 ResizeObserver 跟着重算。
 *
 * ⚠️ 高度上限是**常驻**的（收起时才解开），不是"判定为超长才加"：反过来写就成了
 * "没截断 → 量出没截断 → 不截断"的死循环，按钮永远不出现（本仓库第一次实现就栽在这儿）。
 */
const textEl = ref<HTMLElement | null>(null)
const textExpanded = ref(false)
const textClamped = ref(false)

function measureText() {
  const el = textEl.value
  // 展开时不再量：解开上限后高度本就等于内容高度，一量就会把「收起」这个按钮自己收掉
  if (!el || textExpanded.value) return
  textClamped.value = el.scrollHeight - el.clientHeight > 2
}

function toggleText() {
  textExpanded.value = !textExpanded.value
  // 收回去之后上限重新生效，得重量一次才知道该不该继续显示渐隐
  if (!textExpanded.value) nextTick(measureText)
}

let textRO: ResizeObserver | null = null
// 元素本身带 v-if（没正文时不渲染），所以得在元素换人时重新 observe，
// 不是在 onMounted 里 observe 一次就完事
watch(textEl, (el) => {
  textRO?.disconnect()
  textRO = null
  if (!el) return
  textRO = new ResizeObserver(() => measureText())
  textRO.observe(el)
})
onBeforeUnmount(() => { textRO?.disconnect(); textRO = null })

// 换一份报告就重新收起来：上一份点开的「全文」不该跟着走到下一份上
watch(() => currentReport.value?.id, () => {
  textExpanded.value = false
  textClamped.value = false
  nextTick(measureText)
})

/**
 * 历史行里那一列文案：能画的就是 `62%`，没有进度的给空串 —— **空串不是"没有这一列"**，
 * 模板里那一格照样占位（min-width），否则没有进度的那几条摘要会整体左移，
 * 一整列时间/百分比扫下来忽左忽右。
 *
 * 归一放在这里而不是模板里：面板读的是盘上的历史报告，老版本服务端写的记录同样会流进来
 * （见 utils/progressReport.ts 的 reportPercent）。
 */
function historyPct(r: ProgressReport): string {
  const v = reportPercent(r.percent)
  return v === null ? '' : v + '%'
}

/**
 * 当前这份报告的整体进度。null = 主 Agent 没给 → 顶部那条进度条整行不渲染。
 * 绝不回落到 0：一条 0% 的实心条是在替模型说它没说过的话。
 */
const currentPercent = computed(() => reportPercent(currentReport.value?.percent))

/** 当前这份报告的任务事实 + 归一后的百分比与静默时长（模板里 v-for 用它，省掉每行四次函数调用） */
const currentTasks = computed(() => (currentReport.value?.tasks || []).map(t => ({
  ...t,
  pct: reportPercent(t.percent),
  // null = 不显示"静默 x 秒"，也不把卡片左侧竖线转成告警色（老数据里 0 会被当成"没静默"）
  silent: reportSilentMs(t.silentMs),
})))

/** 历史列表里那一行摘要：有正文就取开头，没有就说清为什么没有 */
function reportBrief(r: ProgressReport): string {
  const text = String(r.text || '').replace(/\s+/g, ' ').trim()
  if (text) return text.length > 42 ? text.slice(0, 42) + '…' : text
  if (r.errorCode) return $t(reportErrorKey(r.errorCode))
  // 服务端已经不再产生"当时没有任务在跑"的空报告了（runProgressReport 不生成、
  // readReports 过滤掉），这一句是渲染层的兜底：面板不认字段来源，脏数据也得有字，
  // 不能白成一行（与 orchestratorStore.normalizeReport 的口径一致）
  return $t('@WORKBENCH:当时没有任务在执行')
}

/**
 * 没有正文时卡片上那句说明。
 * 实话各不相同，不能都写成"暂无"：模型挂了 / 正文为空 /（老数据）当时没任务在跑。
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

// ── 下面那两个区块（历史报告 / 项目概览）默认收起 ────────────────────────────
/**
 * 这块面板的主角是**进度报告**，而列高是有限的：报告卡拿到的永远是"剩下的那点"。
 * 小屏笔记本（1366×768）实测列高只有 ~620px，而它下面这三块是固定高度 ——
 * 历史报告 132 + 项目概览 114 + 派发栏 213 —— 留给报告卡的只剩二三十像素，
 * 报告得缩在自己的小窗口里滚，看起来就是"报告的正文被截了一半"
 * （2026-10-02 用户反馈："项目概览和历史报告可以收起，不然小屏上基本看不到进度报告"）。
 *
 * 所以两个区块默认折成一行。折起来不是"藏起来"：标题行本身带着最该一眼看到的信息
 * （历史的份数 / 概览的分支 + 工作区），要全量内容再点开。
 * 选择记在 localStorage —— 控制台是常驻栏，每次刷新都跳回默认值会很烦
 * （与 MODE_KEY / INPUT_H_KEY 同一套做法，隐私模式下不记偏好但不影响用）。
 */
const SECT_KEY = { history: 'wb.ocHistoryOpen.v1', git: 'wb.ocGitOpen.v1' } as const

function readSectOpen(key: string): boolean {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

const historyOpen = ref(readSectOpen(SECT_KEY.history))
const gitOpen = ref(readSectOpen(SECT_KEY.git))

function toggleSect(which: 'history' | 'git') {
  const target = which === 'history' ? historyOpen : gitOpen
  target.value = !target.value
  try { localStorage.setItem(SECT_KEY[which], target.value ? '1' : '0') } catch { /* 同上 */ }
}

/**
 * 概览收起时标题行上剩下的那点内容：头两项（分支 / 工作区）。
 * 这两项是"这个仓库现在什么状态"的全部答案，其余（与上游 / 今日完成 / 最后活跃）
 * 都得点开看。非 Git 仓库、目录不存在、没选中项目时 gitSummary 会短于两项，
 * 有几项显示几项 —— 不要为了凑数去编一句"未知"。
 */
const gitBrief = computed(() => gitSummary.value.slice(0, 2).map(r => r.value).join(' · '))
</script>

<template>
  <aside
    class="oc"
    :class="{
      'is-collapsed': collapsed,
      'is-report-empty': mode === 'command' && !collapsed && !currentReport,
    }"
  >
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
        :class="{ 'is-off': !active }"
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
      class="oc__chat"
      :active="!collapsed && mode === 'chat'"
      allow-dispatch
      :dispatch-use-default-prompt="useDefaultPrompt"
      :title="$t('@WORKBENCH:g ai 对话')"
    />

    <!-- 进度报告：主 Agent 隔一会儿读一遍正在跑的 job，写一段"现在到哪一步了"。
         报告由服务端生成（自动那份由服务端定时器产生），这里只渲染 + 两个入口：
         改间隔、立即报告。 -->
    <div
      v-show="!collapsed && mode === 'command'"
      class="oc__report"
      :class="{ 'is-empty': !currentReport }"
    >
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
            <!-- 用户从历史里点开一份已经过期的报告时标一下：下面那句「N 个任务进行中」
                 是生成那一刻的事实，现在早就跑完了，不标会看着像还在跑 -->
            <span
              v-if="currentReportStale"
              class="rp__stale"
              :title="$t('@WORKBENCH:这份报告讲的任务已经跑完了，内容只反映生成那一刻的情况')"
            >{{ $t('@WORKBENCH:已结束') }}</span>
            <span class="rp__count">
              {{ $t('@WORKBENCH:{n} 个任务进行中', { n: currentReport.tasks.length }) }}
            </span>
            <span class="rp__time">{{ clockFromIso(currentReport.at) }}</span>
          </div>

          <!-- 进度条：主 Agent 自己给的百分比（不是我们拿时长算的 —— 跑多久跟还剩多少活
               没有固定关系）。它没给就不画这一行，见 currentPercent。
               形状与左栏项目列表的进度条同一套（4px / pill / --gradient-progress），
               两处的"进度"看起来得是一个东西 -->
          <div
            v-if="currentPercent !== null"
            class="rp__progress"
            :title="$t(REPORT_PERCENT_HINT_KEY)"
          >
            <span
              class="rp__bar"
              role="progressbar"
              :aria-valuenow="currentPercent"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-label="$t(REPORT_PERCENT_LABEL_KEY)"
            >
              <i class="rp__bar-fill" :style="{ width: currentPercent + '%' }" />
            </span>
            <!-- 「AI 估计」四个字不能省：这个数字是模型看着思考与工具调用估的，
                 光甩一个 62% 会被当成实测值 -->
            <span class="rp__percent">
              <span class="rp__percent-tag">{{ $t(REPORT_PERCENT_LABEL_KEY) }}</span>{{ currentPercent }}%
            </span>
          </div>

          <!-- 正文：主 Agent 写的**判断**。默认只露 6 行 —— 右栏只有 ~300px 宽，
               模型那种"任务1…任务2…任务3…"连着几段的汇报不截一下会把下面三组
               任务事实整个顶出视口，而事实才是扫得动的那部分。折起来时底下压一层
               渐隐（不是硬切），配一个「展开全文」，不用拖滚动条去找结尾。 -->
          <div v-if="currentReport.text" class="rp__body">
            <p
              ref="textEl"
              class="rp__text"
              :class="{ 'is-clamped': textClamped && !textExpanded, 'is-expanded': textExpanded }"
            >{{ currentReport.text }}</p>
            <button
              v-if="textClamped || textExpanded"
              type="button"
              class="rp__more"
              @click="toggleText"
            >
              {{ textExpanded ? $t('@WORKBENCH:收起') : $t('@WORKBENCH:展开全文') }}
            </button>
          </div>
          <!-- 没有正文时给的是**实话**：没任务 / 没配模型 / 模型没返回内容，
               三种情况的处理办法完全不同，一律写"暂无"会让人白等 -->
          <p v-else class="rp__notice" :title="currentReport.errorDetail">{{ reportNotice(currentReport) }}</p>

          <!-- 事实区：给一个区块标题是为了把"判断"与"依据"分开 —— 上面那段是模型说的，
               下面这几张卡是从正在跑的任务里抄出来的事实，两者对不上时用户得能一眼
               看出是模型在编（见服务端 progressReport.js 的 buildReportPrompt）。 -->
          <div v-if="currentTasks.length" class="rp__facts">
            <p
              class="rp__facts-cap"
              :title="$t('@WORKBENCH:上面是主 Agent 的判断，下面这些是从正在跑的任务里抄出来的事实')"
            >{{ $t('@WORKBENCH:任务事实') }}</p>
            <ul class="rp__tasks">
              <li
                v-for="(t, i) in currentTasks"
                :key="t.taskId || i"
                class="rpt"
                :class="{ 'is-silent': t.silent !== null }"
              >
                <p class="rpt__title">{{ t.taskTitle || $t('@WORKBENCH:未命名任务') }}</p>
                <p class="rpt__meta">
                  <span v-if="t.projectName" class="rpt__project">{{ t.projectName }}</span>
                  <span>{{ $t('@WORKBENCH:已运行 {elapsed}', { elapsed: formatDurationMs(t.elapsedMs) }) }}</span>
                  <span v-if="t.agent" class="rpt__agent">{{ t.agent }}</span>
                  <!-- 次数看总数，鼠标停上去看**分布** —— 119 次里 118 次都是 Bash
                       和"改了三处代码"，是完全不同的两件事，而一行放不下分布 -->
                  <span v-if="t.toolCallCount" :title="t.toolMix || ''">
                    {{ $t('@WORKBENCH:工具 {n} 次', { n: t.toolCallCount }) }}
                  </span>
                  <!-- 静默只在**显然静默**时才有值（服务端有阈值）；0 一律不画 ——
                       老版本落盘时把"没有静默"写成了 0，见 reportSilentMs 的注释 -->
                  <span v-if="t.silent !== null" class="rpt__silent">
                    {{ $t('@WORKBENCH:静默 {elapsed}', { elapsed: formatDurationMs(t.silent) }) }}
                  </span>
                </p>
                <!-- 每个任务自己的进度。整体那条说不清"是哪两个任务拖着的" —— 这一行就是
                     为它准备的。主 Agent 只给整体、没给单个时（老模型 / 判断不出来）整行不渲染 -->
                <p v-if="t.pct !== null" class="rpt__progress" :title="$t(REPORT_PERCENT_HINT_KEY)">
                  <span
                    class="rpt__bar"
                    role="progressbar"
                    :aria-valuenow="t.pct"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-label="t.taskTitle || $t('@WORKBENCH:未命名任务')"
                  >
                    <i class="rpt__bar-fill" :style="{ width: t.pct + '%' }" />
                  </span>
                  <span class="rpt__percent">{{ t.pct }}%</span>
                </p>
                <!-- 证据按可靠程度排：工具调用（正在做什么）→ 思考（为什么）→ 正文。
                     思考这一行是 2026-09-29 补的：很多任务一句正文都不写，只靠工具调用
                     根本看不出它在干嘛，而它的思考当时就在库里。
                     三行都带标签：窄栏放得下，标签比左侧竖线更能让三行左对齐、一列扫下来
                     （看板卡片上没有标签是因为卡片更窄，见 WorkbenchKanban 的 kb-card__live-tag） -->
                <p v-if="t.lastTool" class="rpt__line is-tool" :title="t.lastTool">
                  <span class="rpt__tag">{{ $t('@WORKBENCH:工具') }}</span>{{ t.lastTool }}
                </p>
                <p v-if="t.lastThought" class="rpt__line is-thought" :title="t.lastThought">
                  <span class="rpt__tag">{{ $t('@WORKBENCH:最近思考') }}</span>{{ t.lastThought }}
                </p>
                <p v-if="t.lastLine" class="rpt__line" :title="t.lastLine">
                  <span class="rpt__tag">{{ $t('@WORKBENCH:最新回复') }}</span>{{ t.lastLine }}
                </p>
              </li>
            </ul>
          </div>
        </li>
        <li v-else class="oc-empty" :title="idleHintTitle">
          {{ idleHint }}
        </li>
      </ul>

      <!-- 历史：一行一份，点一条就把它换到上面看。只在有两份以上时出现 ——
           只有一份时这个列表纯粹是噪音。
           默认折起来：它是"回看"，不该跟正在看的那份抢高度（见 script 里 SECT_KEY 的注释） -->
      <div
        v-if="(reports || []).length > 1"
        class="oc__history"
        :class="{ 'is-collapsed': !historyOpen }"
      >
        <button
          type="button"
          class="oc__sect"
          :aria-expanded="historyOpen"
          :title="historyOpen ? $t('@WORKBENCH:收起') : $t('@WORKBENCH:展开')"
          @click="toggleSect('history')"
        >
          <el-icon class="oc__sect-caret"><component :is="historyOpen ? ArrowDown : ArrowRight" /></el-icon>
          <span class="oc__sect-title">{{ $t('@WORKBENCH:历史报告') }}</span>
          <!-- 折起来时这一行就是全部内容：份数是它唯一值得一眼看到的信息 -->
          <span class="oc__sect-meta">
            <span class="oc__sect-brief">{{ $t('@WORKBENCH:共 {n} 份', { n: (reports || []).length }) }}</span>
          </span>
        </button>
        <ul v-show="historyOpen" class="oc__history-list">
          <li v-for="r in reports" :key="r.id">
            <button
              type="button"
              class="oc__history-item"
              :class="{ 'is-active': r.id === currentReport?.id }"
              @click="pickReport(r)"
            >
              <span class="oc__history-time">{{ clockFromIso(r.at) }}</span>
              <!-- 历史里也带上进度：一眼看出"这条是 20 分钟前那会儿 40%，现在 70%"。
                   没有进度的那几条这一格是空的但**占着位**（见 historyPct） -->
              <span class="oc__history-pct">{{ historyPct(r) }}</span>
              <span class="oc__history-sum">{{ reportBrief(r) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <div
      v-show="!collapsed && mode === 'command'"
      class="oc__git"
      :class="{ 'is-collapsed': !gitOpen }"
    >
      <button
        type="button"
        class="oc__sect"
        :aria-expanded="gitOpen"
        :title="gitOpen ? $t('@WORKBENCH:收起') : $t('@WORKBENCH:展开')"
        @click="toggleSect('git')"
      >
        <el-icon class="oc__sect-caret"><component :is="gitOpen ? ArrowDown : ArrowRight" /></el-icon>
        <span class="oc__sect-title">{{ $t('@WORKBENCH:项目概览') }}</span>
        <span class="oc__sect-meta">
          <!-- 无选中项目即「全部项目」：显式标出来，否则底下只剩「今日完成」一行，看着像数据没加载出来 -->
          <span class="oc__git-name">{{ selectedProject ? selectedProject.name : $t('@WORKBENCH:全部项目') }}</span>
          <!-- 折起来时再补上"这个仓库现在什么状态"：分支 + 工作区。
               不补的话，收起等于把这块唯一要扫的信息也一起收了 -->
          <span v-if="!gitOpen && gitBrief" class="oc__sect-brief">{{ gitBrief }}</span>
        </span>
      </button>
      <dl v-show="gitOpen" class="oc__git-list">
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
        :class="{ 'is-over': overLimit }"
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
        :on-pick="onPickAttachment"
        :on-remove="onRemoveAttachment"
        :raw-base="DRAFT_RAW_BASE"
        @paste="onPaste"
        @drop="onDrop"
        @dragover.prevent="attachDragging = true"
        @dragenter.prevent="attachDragging = true"
        @dragleave="attachDragging = false"
      />
      <!--
        字数：单独占输入框下方一行，不挤底部那一排按钮。
        空草稿时不渲染（"0 / 100000" 是噪音），接近上限转黄、超了转红 ——
        目的是让"粘太长发不出去"在**点之前**看得见，而不是点完等服务端 400 才知道
        （而超长恰恰是最容易失败的那一类，必须能改一改再发）。
      -->
      <p v-if="draftChars > 0" class="oc__count" :class="{ 'is-warn': nearLimit, 'is-over': overLimit }">
        <span v-if="overLimit">{{ $t('@WORKBENCH:超出上限 {max} 字，请精简后再派发（超出的部分不会被发出）', { max: charLimit }) }}</span>
        <span v-else>{{ draftChars }} / {{ charLimit }}</span>
      </p>
      <div class="oc__compose-foot">
        <button
          type="button"
          class="oc__attach"
          :disabled="attachBusy"
          :title="$t('@WORKBENCH:添加附件（也可直接粘贴或拖入文件）')"
          :aria-label="$t('@WORKBENCH:添加附件')"
          @click="onPickAttachment"
        >
          <el-icon><Paperclip /></el-icon>
        </button>
        <!-- 预设提示词设置入口：图标按钮按项目惯例不加底色，
             有没有设过看右侧"附加预设提示词"那个勾选（它是真实生效状态，这个只是入口） -->
        <button
          type="button"
          class="oc__attach"
          :class="{ 'is-on': anyPromptConfigured }"
          :title="$t('@WORKBENCH:设置派发时自动附加的预设提示词（全局 / 各项目）')"
          :aria-label="$t('@WORKBENCH:预设提示词设置')"
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
          :title="$t('@WORKBENCH:取消勾选则本次派发的任务不带预设提示词（设置本身不受影响）')"
        >
          <input type="checkbox" v-model="useDefaultPrompt" />
          <span>{{ $t('@WORKBENCH:预设提示词（{state}）', { state: promptStateLabel }) }}</span>
        </label>
        <!-- 执行器：与工作台执行按钮、看板「执行」共用同一份选择。
             下拉本体收口在 TaskExecutorPicker（对话模式底下那个也是它），
             它自己读 composable 的共享状态，这里不用再传 v-model -->
        <TaskExecutorPicker
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
  color: var(--text-meta);
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
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
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
/* 2026-10-05：面板标题原来和它下面的每一条注脚一样是 12px/500/次要色 ——
   整栏扫下来没有一处比别处更重，读起来是一堆平级的灰字。标题是这一栏唯一
   的"我是谁"，给它 13px/600/正文色，把层级从最上面立起来（正文刻度天花板
   仍是 14px，见 docs/ui-audit 的 P2-17，这里不越界）。 */
.oc__title {
  margin: 0;
  font-size: var(--font-size-mid);
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
}
/* 「暂停调度 / 恢复调度」：这一栏唯一的全局动作，原来是一段没有边框的 11px
   灰字 —— 和标题同为纯文字，看起来像第二个标题而不是能点的东西。
   现在与「立即报告」同一套胶囊（22px / pill / 1px 描边 / 白底），
   栏内所有"动作"长得一样。 */
.oc__toggle {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--surface-elevated);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 500;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom);
}
.oc__toggle:hover:not(:disabled) {
  color: var(--role-active-ink);
  border-color: var(--role-active-edge);
  background: var(--role-active-surface);
}
/* 暂停态：这一个按钮同时是"状态"和"动作"。暂停中染角色色（琥珀 = 需要注意），
   于是"现在没在自动跑"这件事在栏头就能看见，不用读到下面那行状态才明白。 */
.oc__toggle.is-off {
  color: var(--role-active-ink);
  border-color: var(--role-active-edge);
  background: var(--role-active-surface);
}
.oc__toggle.is-off:hover:not(:disabled) { border-color: var(--role-active-ink); }
.oc__toggle:disabled { opacity: var(--disabled-opacity); cursor: default; }
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
  color: var(--text-meta);
  border-radius: var(--radius-base);
  font-size: var(--font-size-mid);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.oc__collapse:hover { color: var(--color-primary); }
.oc__collapse:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

/* 状态读数条。原来底色是 --gradient-accent-soft（一层极淡的主色渐变），
   而右下角那块栏底本身就是 #f5f7fa —— 渐变叠上去只是让它"偏蓝一点点"，
   既不像一条有身份的读数，又让这一屏多出一种没有名字的底色。
   现在底色退回与拨片同一支中性 --bg-subtle，靠"值加粗放大 + 暂停时整条转角色色"
   来表达状态。 */
.oc__state {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 9px 12px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-color-light);
  flex-shrink: 0;
}
/* 2026-10-04：这里原本是 `color: var(--warning-dark)` —— 令牌表里只有
   --color-warning-dark，压根没有 --warning-dark。var() 解析失败会让整条声明
   被丢掉（编译器/tsc/build/浏览器 console 全都不报），于是「已暂停」与「调度中」
   一直是一个颜色。同一个错字在本文件还有第二处（.rpt__silent），一并修。 */
.oc__state.is-paused {
  color: var(--role-active-ink);
  background: var(--role-active-surface);
  border-bottom-color: var(--role-active-edge);
}
.oc__state-label { color: var(--text-meta); }
/* 值比标签大一档、粗一档：这一行要回答的是"现在到底跑不跑"，标签只是它的名字 */
.oc__state-value {
  margin-left: 2px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}
.oc__state.is-paused .oc__state-value { color: var(--role-active-ink); }
.oc__state-meta {
  margin-left: auto;
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}

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
  border: 1px solid var(--border-color);
}
.oc__mode-btn {
  flex: 1;
  height: 22px;
  border: none;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-meta);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: var(--transition-ui-fast);
}
.oc__mode-btn:hover { color: var(--text-secondary); }
/* 2026-10-04：选中档吃 primary 10% 淡底 + primary-dark 字色 + 600 字重。
   拨片只有两档，不需要第四个色相，靠「这块底色比旁边亮一档 + 字变主色」分得开；
   原来选中档只比未选中档白一点点，扫过去基本看不出选了哪个。 */
.oc__mode-btn.is-active {
  background: color-mix(in srgb, var(--color-primary) 10%, var(--bg-panel));
  color: var(--color-primary-dark);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
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

/* ── 空闲态：空态居中，输入框适度加高 ──
   实测（2026-10-05 截图量测 1718×1300）：没有进度报告时这一块是 458×700 的全白，
   占整屏约 14%，而空态那行字**顶对齐贴在列表第一行** —— 读起来像加载失败，
   不像"现在没有在跑的活"。这一版做两件事：
     ① 空态在剩下的空间里居中，并换成与看板列同一套的虚线框（见 .oc-empty）；
     ② 输入框下限抬到 6 行（76 → 168）。
   ⚠️ 试过更激进的一版：让报告区收缩、把 700px 全给输入框（flex:1 + max-height:none），
   实测输入框会长到 **798px** —— 一个只有占位符的巨框，比原来那块空白更像"没做完"。
   所以**高度仍然留在报告区**，只是那里面现在是一块说得清话的空态。
   真要利用它，正确做法是在空闲时自动展开「历史报告」（那是行为改动，单独一轮做）。 */
.oc__report.is-empty .oc__report-list {
  display: flex;
  align-items: center;
  justify-content: center;
}
.oc.is-report-empty .oc__input { min-height: 168px; }
/* 区块标题：与面板标题同一族的次级档（12px/600）。它下面是整块报告，
   原来跟着注脚一起挤在 11px，报告和它右边的两个控件谁先被读到全靠位置。 */
.oc__panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 12px 6px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
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
  background: var(--surface-elevated);
  border: 1px solid var(--border-color);
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
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--surface-elevated);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              border-color var(--transition-fast) var(--ease-custom);
}
.oc__report-run:hover:not(:disabled) { color: var(--color-primary); border-color: var(--color-primary); }
.oc__report-run:disabled { opacity: var(--disabled-opacity); cursor: default; }
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
  /* 左右 12px：与栏内其他区的 padding（头部 / 状态条 / 概览 / 派发栏）同一条线，
     原来是 10px —— 报告卡的左右边和它上面「进度报告」那行标题差 2px，
     窄栏里一眼能看出没对齐。 */
  padding: 0 12px 12px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

/* ── 报告卡片 ─────────────────────────────────────────── */
/* 卡片本体。边界用 --border-color 而不是 --border-color-light：后者在浅色
   主题下只有 3% 黑，压在 #f5f7fa 的栏底上肉眼等于没有 —— 整块报告看起来就是
   一大片没有边界的字（这正是"不清晰"的根，不是字号问题） */
/* 2026-10-04：这一块永远是「正在看的那一份」（模板是 v-if="currentReport"，
   没有别的形态），所以直接给 active 角色即可。之前是纯灰卡片，跟下面历史列表里
   的旧报告长得一模一样，「我现在看的哪份」要靠位置猜。
   （历史上这里还有个 .rp.is-current，但模板从来没绑这个类，是条死规则。）

   2026-10-05：底色原本是 `color-mix(--role-active-ink 4%, --bg-subtle)` ——
   而 --bg-subtle 本身带 alpha(rgba(0,0,0,.02))，混出来仍是**半透明**的暖灰，
   压在栏底 #f5f7fa 上再叠一圈 42% 的琥珀描边，整张卡看着发浑发脏（README
   第三轮的原话是"淡底一律从 hue 兑进 --surface-elevated"，这一处没跟上）。
   现在把卡面退回体系内的白（--surface-elevated）+ 中性描边，"这一份在跑"
   的身份改由**顶部 2px 的 --role-active-bar 色带**承担 —— 面积从整张卡收到
   一条线，同样的信息，不再让整块报告换一个色系。
   （顶部色带不属于被禁的 left/right 侧边色条。） */
.rp {
  padding: 10px 11px;
  border-radius: var(--radius-lg);
  background: var(--surface-elevated);
  border: 1px solid var(--border-color);
  border-top: 2px solid var(--role-active-bar);
  box-shadow: var(--shadow-sm);
}
.rp__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: var(--font-size-xs);
}
.rp__trigger { color: var(--color-primary); font-weight: 500; }
/* 自动那份是"系统自己说的"，手动那份才是"你刚才要的" —— 颜色分得开，
   回看历史时一眼能认出哪几份是自己点出来的 */
.rp__trigger.is-auto { color: var(--text-meta); font-weight: 400; }
/* 「已结束」：只有用户主动点开一份过期报告时才出现，所以用中性色而不是告警色——
   那不是异常，是历史。位置紧跟触发方式，让"自动/手动 + 已结束"连成一枚状态读数 */
.rp__stale {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  color: var(--text-meta);
}
/* 任务数给一枚淡底小标：它是这张卡"覆盖了几个任务"的一眼答案，
   不做底色的话会和右边的时间戳混成同一行的普通文字 */
.rp__count {
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--tint-primary-08);
  color: var(--color-primary);
  font-variant-numeric: tabular-nums;
}
.rp__time {
  margin-left: auto;
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
/* 进度条：几何与左栏项目列表那条（WorkbenchProjectPanel 的 proj-item__bar）保持一致，
   两处的"进度"才像同一个东西。轨道用 --bg-active（深浅两套都有定义）—— 卡片本身
   已经是 --bg-subtle，轨道再用更浅的色就看不见了 */
.rp__progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
}
.rp__bar {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  overflow: hidden;
}
/* 2026-10-04：原本是 --gradient-progress（蓝渐变）。这条进度表示
   「正在跑的活儿到哪一步」，跟看板「进行中」是同一件事，于是走同一个角色。
   同日第四轮：从 ink 换成 bar（ink 是文字的暗档，4px 实心块吃它整屏发沉）。 */
.rp__bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--role-active-bar);
  transition: width var(--transition-base) var(--ease-custom);
}
.rp__percent {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
/* 「AI 估计」四个字压暗一档：要读的是数字，但那四个字不能被省掉 */
.rp__percent-tag {
  margin-right: 4px;
  color: var(--text-meta);
}

/* 引文竖线挂在**外层**而不是 .rp__text 上：折叠用的是 mask 渐隐（见下面那条），
   mask 会把元素连同它自己的 border-left 一起淡掉，竖线底端会跟着缺一块 */
.rp__body {
  /* 2026-10-04：原本是 border-left: 2px solid var(--tint-primary-30)。
     这根竖线只承担缩进（上面那段注释记的是"竖线要挂外层、否则会被
     mask 渐隐吃掉"），去掉之后不存在这个问题了，缩进交给 padding。 */
  padding-left: 10px;
}
.rp__text {
  margin: 0;
  /* 2026-10-05：12px → 13px。这一栏里除了它全是 11px 的注脚，正文再压到 12px
     就跟注脚只差一档，一段模型写的判断读起来和"工具 35 次"是同一种东西。
     行高保持 1.6（下面 max-height 的 6 行口径按 em 走，跟着字号一起长）。 */
  font-size: var(--font-size-mid);
  line-height: 1.6;
  color: var(--text-primary);
  word-break: break-word;
  white-space: pre-wrap;
  /* 高度上限**常驻**（点开时才解开），不是"判定为超长才加"：反过来写就成了
     "没截断 → 量出没截断 → 不截断"的死循环，「展开全文」那个按钮永远不出现
     （本仓库第一次实现就栽在这儿，见 script 里 measureText 的注释） */
  max-height: calc(6 * 1.6em);
  overflow: hidden;
}
.rp__text.is-expanded { max-height: none; }
/* 渐隐用 mask 而不是"渐变到卡片底色"的伪元素：卡片底色是半透明的 --bg-subtle
   压在栏底 --bg-panel 上，合成出来的实际颜色浅色/深色两套主题各不相同，
   按变量渐变过去会露一道异色的边。mask 是把字自己淡到透明，与底色无关。 */
.rp__text.is-clamped {
  -webkit-mask-image: linear-gradient(#000 calc(100% - 1.8em), transparent);
  mask-image: linear-gradient(#000 calc(100% - 1.8em), transparent);
}
/* 「展开全文」原来是一串裸的蓝字，紧跟在被渐隐的正文最后一行下面 ——
   看起来像正文里的一句话，而不是一个动作。给一枚 primary 淡底胶囊：
   它落在正文与下面的事实区之间，位置本来就是要被看见的。 */
.rp__more {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin: 6px 0 0;
  padding: 2px 9px;
  border: none;
  border-radius: var(--radius-pill);
  background: var(--tint-primary-08);
  color: var(--color-primary);
  font-size: var(--font-size-xs);
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom);
}
.rp__more:hover {
  color: var(--color-primary-dark);
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}
.rp__more:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.rp__notice {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.55;
  color: var(--text-meta);
}
/* 事实区：正文（判断）与下面这堆（依据）之间要有一道真边界。标题这行把两者的
   身份写出来 —— 上面那段是模型说的，下面是从 job 里抄的，对不上时一眼能看出是谁在编 */
.rp__facts {
  margin: 9px 0 0;
  padding-top: 7px;
  border-top: 1px solid var(--border-color);
}
.rp__facts-cap {
  margin: 0 0 5px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-meta);
  letter-spacing: 0.04em;
  cursor: help;
}
.rp__tasks {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
}
/* 每个任务一张卡。以前任务与任务之间只有 6px 间隙，谁是谁的证据全靠读，
   窄栏里三组并排就是"一大片字"。左侧那道竖线是状态位：静默过久的那条转告警色 */
/* 2026-10-05：底色从 --bg-active（7.5% 黑，压在现在这张白卡上偏深）换成
   --bg-panel —— 它是"面板灰"这一支实色，白卡里一条灰带，边界比 4% 的描边
   更清楚，也不用再靠边框把两块分开。padding 与圆角各提一档，让每条任务
   有能呼吸的体量。 */
.rpt {
  min-width: 0;
  padding: 7px 9px;
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  /* 2026-10-04：原本紧跟在这圈 1px 描边后面又写了一条
     border-left: 2px solid var(--border-color) 把左边加粗 —— 视觉上
     就是一根侧边色条。删掉即可，描边保持 1px 均匀。 */
  border: 1px solid var(--border-color-light);
}
/* 2026-10-04：原本是 border-left-color（只染左边，配合已删掉的 2px 左边
     加粗用）。现在描边整圈统一 1px，改成整圈染。
   2026-10-05：底色同步换成角色淡底（--role-active-surface，不透明的那支）——
   --tint-warning-06 是带 alpha 的，叠在 --bg-panel 上合成出来的值深浅两套
   主题各不相同（README 第三轮记的就是这条）。 */
.rpt.is-silent {
  border-color: var(--role-active-edge);
  background: var(--role-active-surface);
}
/* 任务名是这张卡的标题：比下面那几行证据亮一档、粗一档，
   一列扫下来先看到的是"谁在跑"，再决定要不要读证据 */
.rpt__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rpt__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 6px;
  margin: 1px 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
/* meta 里相邻两项之间加个间隔点：这一行挤着 3~5 个短片段，
   6px 的 gap 在 11px 字下分不清哪里到哪里，只能靠点的位置读 */
.rpt__meta > span + span::before {
  content: '·';
  margin-right: 6px;
  color: var(--text-meta);
}
.rpt__project { color: var(--text-secondary); }
/* 每个任务自己的进度：比整体那条细一档（3px），它是注脚不是标题 */
.rpt__progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 3px 0 0;
}
.rpt__bar {
  flex: 1;
  min-width: 0;
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  overflow: hidden;
}
/* 同 .rp__bar-fill：任务事实里每一条进度也是「在跑的活儿」 */
.rpt__bar-fill {
  display: block;
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--role-active-bar);
  transition: width var(--transition-base) var(--ease-custom);
}
.rpt__percent {
  flex-shrink: 0;
  min-width: 30px;
  text-align: right;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
/* 静默：报告里说"可能卡住了"时，用户能在这行上核到依据。
   给一枚淡底：它是这一行里唯一的告警信号，混在灰色的时长/次数中间会被扫过去 */
.rpt__silent {
  padding: 0 4px;
  border-radius: var(--radius-pill);
  background: var(--tint-warning-14);
  /* 原本是 var(--warning-dark) —— 同一个错字，本文件第二处。整条声明被丢掉之后，
     这枚「可能卡住了」的告警徽标只剩淡底没有字色，压在灰底上几乎看不见。 */
  color: var(--role-active-ink);
  font-weight: 600;
}
.rpt__line {
  margin: 3px 0 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-meta);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
/* 工具行只给一行：它是"正在做什么"的标签（`Edit src/App.vue`），
   折成两行会被读成一句内容，而它本来不是（与看板卡片同一取舍） */
.rpt__line.is-tool {
  -webkit-line-clamp: 1;
  line-clamp: 1;
}
/* 思考那行比工具行**亮一档**：它是"它在干嘛"最直接的证据，
   而工具行只说明"它动了哪个文件"。看板那边靠左侧竖线分，这里改用标签 ——
   窄栏放得下标签，三行左对齐才扫得动（见模板里 .rpt__tag 的注释） */
.rpt__line.is-thought { color: var(--text-secondary); }
/* 固定宽度：三行各自的标签（工具 / 思考 / 回复）占一样宽，
   正文就从同一条竖线起排，一列扫下来不会左左右右。
   标签用 --text-meta 而不是 --text-tertiary：后者是装饰档（状态点/占位符），
   而"这行是工具调用还是思考"是实打实要读的信息。
   2026-10-05：标签统一加 500 字重 —— 原来只有"思考"那一行加粗，三行标签
   在正文同为灰色时和正文糊成一体，读不出"标签 + 内容"的格。 */
.rpt__tag {
  display: inline-block;
  min-width: 20px;
  margin-right: 5px;
  font-weight: 500;
  color: var(--text-meta);
}

/* ── 可收起的区块标题行（历史报告 / 项目概览共用）──────────
   标题自己就是开关：窄栏里再塞一枚"收起"按钮就是再挤一处，
   而这两块的内容（回看用的历史、Git 状态）都不是每眼都要读的。
   折起来后这一行仍然带关键信息（各自的 .oc__sect-brief），
   所以收起是"压缩"而不是"藏起来"。 */
.oc__sect {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  margin: 0 0 4px;
  padding: 4px 6px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-meta);
  font-size: var(--font-size-xs);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
              background var(--transition-fast) var(--ease-custom);
}
.oc__sect:hover { color: var(--text-secondary); background: var(--bg-subtle); }
.oc__sect:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }
/* 箭头跟着开合转（ArrowRight ⇄ ArrowDown），与左栏任务分组同一套 */
.oc__sect-caret { flex-shrink: 0; font-size: var(--font-size-sm); }
/* 标题比它右边那截 meta 亮一档：这一行是"章节名 + 当前值"，两者同色的话
   "历史报告 共 20 份"会读成一句话而不是"标题 + 读数" */
.oc__sect-title { flex-shrink: 0; font-weight: 500; color: var(--text-secondary); }
/* 行尾那一段。**整行只有这一个 flex 项吃 margin-left: auto** ——
   两个 auto 会把剩余空间对半分，项目名就飘到行中间去了 */
.oc__sect-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  min-width: 0;
}
/* 名称这类可长的内容让它自己省略号，短的那截（份数 / 分支状态）不参与压缩 */
.oc__sect-meta .oc__git-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc__sect-brief {
  flex-shrink: 0;
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}

/* ── 历史报告 ─────────────────────────────────────────── */
.oc__history {
  flex-shrink: 0;
  max-height: 132px;
  overflow-y: auto;
  padding: 6px 12px 8px;
  border-top: 1px solid var(--border-color);
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
  color: var(--text-meta);
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
/* 进度列给个固定最小宽度：整列数字对得齐才扫得动。**没有进度的那几条这一格是空的、
   但照样占位**（见 historyPct）—— 否则摘要会忽左忽右，一列扫下来很费眼 */
.oc__history-pct {
  flex-shrink: 0;
  min-width: 30px;
  text-align: right;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.oc__history-sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 空态与看板列的空态用同一套语言（虚线框 + 淡底 + --text-meta + xs）。
   原来这里是**裸文字**，另外两处（看板列空态、待处理列的「新建任务」）都是虚线框 ——
   同一个"这里没有东西"在一屏里两种长相，用户每次都要重新判断"是坏了还是真没有"
   （修复清单 E1 记的就是这条）。`.oc-empty` 的文案与 title 被
   verify-wb-progress-report.cjs 逐字断言，所以这里只动外观、一个字都没改。 */
.oc-empty {
  max-width: 260px;
  margin: 0 auto;
  padding: 18px 10px;
  text-align: center;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  list-style: none;
  border: 1px dashed var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}

.oc__git {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color);
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
.oc__git-label { color: var(--text-meta); }
.oc__git-value {
  margin: 0;
  text-align: right;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oc__git-value.is-warn { color: var(--color-warning-dark); }
.oc__git-value.is-danger { color: var(--color-danger-light); }

/* 折起来时只剩一行标题：把上下留白和列表的滚动框一起收掉，
   否则"收起"名义上收了、高度还是赖着不走（这正是这次要修的东西） */
.oc__git.is-collapsed,
.oc__history.is-collapsed { padding-top: 4px; padding-bottom: 4px; }
.oc__history.is-collapsed { max-height: none; overflow: visible; }
.oc__git.is-collapsed .oc__sect,
.oc__history.is-collapsed .oc__sect { margin-bottom: 0; }

.oc__compose {
  padding: 8px 12px 10px;
  border-top: 1px solid var(--border-color);
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
  /* 2026-10-05：内边距 7/8 → 9/10，字号 12 → 13。这是这一栏里用户唯一
     亲手写字的地方，之前它的正文比上面那段模型写的汇报还小一档。 */
  padding: 9px 10px;
  font-size: var(--font-size-mid);
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
.oc__input::placeholder { color: var(--text-meta); }
/* 超上限：边框转红，和下面那行字一起说"这条现在发不出去"。
   只改边框色，不动 focus 的 box-shadow —— 聚焦时仍然要看得见焦点环。 */
.oc__input.is-over {
  border-color: var(--color-danger);
  box-shadow: 0 0 0 1px var(--color-danger);
}
/* 字数行：右对齐贴在输入框下沿，tabular-nums 让数字跳动时不左右晃 */
.oc__count {
  margin: 5px 2px 0;
  text-align: right;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-meta);
}
.oc__count.is-warn { color: var(--color-warning-dark); }
.oc__count.is-over { color: var(--color-danger-dark); }
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
  color: var(--text-meta);
  font-size: var(--font-size-base);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom);
}
.oc__attach:hover:not(:disabled) { color: var(--color-primary); }
/* 已设过预设提示词：入口点亮，一次远程状态在图标上就能看出来 */
.oc__attach.is-on { color: var(--color-primary); }
.oc__attach:disabled { opacity: var(--disabled-opacity); cursor: default; }
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
/* 原生 checkbox 的勾选色由浏览器给（Chrome 是 #0075ff 那一支），和本仓的
   --color-primary 并排时是两个蓝。accent-color 一行就能把它收回主色。 */
.oc__autorn input { cursor: pointer; accent-color: var(--color-primary); }
/* 执行器下拉的样式随组件走（TaskExecutorPicker 自带），这里不再留一份 —— 
   同一个下拉在对话模式底下还有一个，样式留在这儿对它无效，只会变成"改了没反应"的死规则 */
/* 派发是这一栏的主动作，原来只有 24px 高 —— 和它并排的胶囊控件是 22px，
   一个"主按钮"只比旁边的次要控件高 2px，行尾的落点读不出来。
   抬到 28px（仍在 --control-height-sm/md 之间，不引入新刻度）。 */
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
  font-weight: 500;
  line-height: 28px;
  padding: 0 14px;
  cursor: pointer;
  transition: box-shadow var(--transition-fast) var(--ease-custom),
              opacity var(--transition-fast) var(--ease-custom);
}
.oc__send:hover:not(:disabled) {
  background: var(--gradient-accent-hover);
  box-shadow: var(--btn-shadow-hover);
}
.oc__send:disabled { opacity: var(--disabled-opacity); cursor: default; }
.oc__send:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.oc__send-icon { font-size: var(--font-size-sm); }
.oc__hint {
  margin: 6px 0 0;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-meta);
}

/* ── 窄屏 ──────────────────────────────────────────── */
/* 手机宽度下工作台改成上下排列（见 WorkbenchBoard 的 .board__cols），
   这条栏从"右侧一条"变成"占满宽度的一整块"：
   · 左边框换成上边框（分隔线要跟着方向走）
   · --wb-right-w 此时是 100%，所以宽度铺满，不用在这儿改
   · 给一个最小高度，否则内部那条 flex 高度链（feed 滚动 / 输入区钉底）没有参照，
     输入区会被压扁到只剩一行 */
@media (max-width: 860px) {
  .oc {
    border-left: none;
    border-top: 1px solid var(--border-color);
    min-height: 72vh;
    /* 排到看板**前面**（竖排时看板是 `order: 0`）。
       为什么：竖排以后看板三列是摞起来的，本项目实测 390px 宽下一整块 ≈1.25 万 px
       （120 张卡），控制台排在它后面 = 想看报告得先划过整个看板，"基本看不到"就是
       这么来的。手机上一次下滑够用：先读报告、要翻看板再往下。 */
    order: -1;
  }
  /* 竖排时右栏是一整块铺满，没有"收边"这个方向可收 —— 折叠按钮收起来，
     免得点了没反应（看板那边也把 collapsed 强制成 false，两边一致） */
  .oc__collapse { display: none; }

  /* 报告在小屏是主角，不再当"一截可以滚的小窗口"：
     · 正文解除 6 行上限。宽屏那道限制是为了不让汇报把下面的事实区顶出 300px 的栏，
       小屏没有这个顾虑（页面本来就靠滚），截了反而要再点一次「展开全文」。
       判定是量出来的（measureText 比 scrollHeight/clientHeight），
       这里解开上限后 JS 自然量成"没截断"，那个按钮也就不会出现 —— 不用另外藏它。
     · 列表盒不再自己滚：解开上限后卡片本来就撑得开，留着 auto 只会在
       "页面滚一层、报告里再滚一层"时让人滑错层。 */
  .rp__text { max-height: none; }
  .oc__report-list { overflow: visible; }
}
</style>
