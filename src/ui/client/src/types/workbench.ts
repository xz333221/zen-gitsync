// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 工作台共享类型：执行日志（job）的两种形态
//   - Job:     流式/SSE 用的精简形态（不含 thinking 之外的大字段冗余）
//   - JobFull: 管理页用的完整形态（反范式 taskTitle、size）

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** 工具调用状态（与 zen-ai-chat-ui 的 ToolCallStatus 对齐） */
export type JobToolCallStatus = 'pending' | 'running' | 'done' | 'error'

/**
 * job 上记录的单次工具调用。
 * 形态对齐 zen-ai-chat-ui 的 ToolCall：服务端已做截断，前端直接用。
 * claude（Bash/Read/Edit）与 opencode（bash/read/edit）都归一成这一种。
 */
export interface JobToolCall {
  id: string
  name: string
  /** 一行参数摘要（折叠态展示） */
  argsPreview?: string
  /** 完整参数（JSON 字符串，服务端已截断） */
  arguments?: string
  /** 执行结果（服务端已截断） */
  result?: string
  status?: JobToolCallStatus
  error?: string
}

/** 流式 / SSE 事件传输形态——前端 jobs.value 数组里就是这个 */
export interface Job {
  id: string
  taskId: string
  subId: string
  title: string
  status: JobStatus
  prompt?: string
  output: string
  thinking?: string
  pid: number | null
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  error: string | null
  /** claude --output-format stream-json 的 system.init 事件捕获的会话 id;
   *  续接对话(`/jobs/:id/continue`)需要回传给后端做 --resume。
   *  opencode 的 sessionID / codex 的 thread_id 也存这里（语义 = "该执行器的会话续接标识"）。
   *  老 job 没这个字段;init 事件来之前也可能为空。 */
  claudeSessionId?: string | null
  /** 本轮用的执行器：'claude' | 'opencode' | 'codex'。老 job 没这个字段（视为 claude） */
  agent?: string
  /** 执行器协议层 error/turn.failed 事件捕获的错误消息（进程退出码可能是 0，靠它判失败） */
  agentError?: string
  /** 工具调用流水。老 job 可能没有这个字段（视为空） */
  toolCalls?: JobToolCall[]
}

// ── Workbench 任务相关类型 ──────────────────────────────────────────

export interface Attachment {
  id: string
  originalName: string
  mimeType: string
  size: number
  ext: string
  absolutePath?: string
  createdAt?: string
}

export interface Task {
  id: string
  title: string
  desc: string
  promptId: string | null
  /** 任务级提示词覆盖；为空则回退到 promptId 指向的预置模板 */
  simpleOverride?: string
  projectPath?: string
  status: string
  attachments?: Attachment[]
  createdAt?: string
  updatedAt?: string
}

export interface Prompt {
  id: string
  name: string
  content: string
  projectPath?: string
  createdAt?: string
  updatedAt?: string
}

/** 完整形态——管理页 /jobs/list 列表项、/jobs/:id 详情用 */
export interface JobFull extends Job {
  taskTitle: string
  size: number
}

/** 保留策略配置：maxCount/maxSizeMB 任一为 0 表示该维度不限 */
export interface JobsConfig {
  maxCount: number
  maxSizeMB: number
}

/** /jobs/list 接口统计区 */
export interface JobStats {
  count: number
  sizeMB: number
  byStatus: Record<string, number>
}

/** /jobs/list 接口响应 */
export interface JobsListResponse {
  success: boolean
  jobs: JobFull[]
  total: number
  stats: JobStats
  error?: string
}

// ── 多项目编排台（L1 看板）相关类型 ──────────────────────────────────
// 全部对应后端 GET /api/workbench/projects 与 GET /api/workbench/orchestrator 的返回，
// 字段是服务端算好的事实（口径见 routes/workbench/projectRegistry.js），前端不重复推导。

/** 看板列。顺序即列顺序 */
export type TaskColumn = 'todo' | 'doing' | 'done'

/** 项目条目的 Git 状态；isGitRepo 为 null 表示没探到，此时不要显示任何 Git 标记 */
export interface ProjectGitState {
  isGitRepo: boolean | null
  branch: string | null
  upstream: string | null
  hasUpstream: boolean
  detached: boolean
  ahead: number
  behind: number
  changed: number
  staged: number
  unstaged: number
  untracked: number
}

export interface ProjectStats {
  total: number
  todo: number
  doing: number
  done: number
  /** 已完成任务 / 总任务 × 100，整数 */
  progress: number
  /** 活跃 job 数（不是任务数） */
  runningJobs: number
  lastActiveAt: string | null
}

export interface ProjectSummary {
  path: string
  /** 归一化后的路径，用作分组/比较的 key */
  key: string
  name: string
  /** recent=只在最近目录里 / task=只在任务里出现过 / both=两边都有 */
  source: 'recent' | 'task' | 'both'
  isCurrent: boolean
  /** null = 没探到（不要把未知显示成"目录不存在"） */
  exists: boolean | null
  git: ProjectGitState | null
  stats: ProjectStats
}

/**
 * 「这轮执行现在在干嘛」—— 卡片上那几行事实摘要在前端的形态。
 * 全部由服务端 jobActivity.pickLiveActivity 抽好（与进度报告的事实同一份实现），
 * 前端只负责显示，不在这里二次加工（加工一遍就会和右栏报告里的说法对不上）。
 *
 * 空串 = 该任务还没有对应内容（例如一句正文都没写过的任务 lastLine 是空的），
 * 前端据此**不渲染那一行**，而不是显示"暂无"。
 */
export interface BoardTaskLive {
  jobId: string
  status: JobStatus | ''
  /** 本轮执行器（claude | opencode | codex）；老记录为空串 */
  agent: string
  startedAt: string | null
  /** 子进程 PID（卡片元信息行显示）；认不出 → null */
  pid: number | null
  elapsedMs: number
  /** 工具调用次数（受服务端上限截断，含义是"至少这么多次"） */
  toolCallCount: number
  /** 最近一次工具调用的一句话（`Edit src/App.vue`）；空串 = 还没调过工具 */
  lastTool: string
  /** 最近若干次调用的名字分布（`Bash×14 · Read×5`），鼠标停上去看 */
  toolMix: string
  /** 最近一段思考 —— 多数任务不写正文，它是"它在干嘛"最直接的证据 */
  lastThought: string
  /** 最新的回复（正文最后一行），空串 = 这轮还没写过正文 */
  lastLine: string
  /** 已经多久没动静了；null = 不到阈值（阈值见服务端 SILENT_NOTABLE_MS） */
  silentMs: number | null
}

/** 看板卡片：任务的精简形态 */
export interface BoardTask {
  id: string
  title: string
  desc: string
  projectPath: string
  column: TaskColumn
  attachmentCount: number
  runningJobs: number
  /** 正在跑时的活动摘要（思考 / 工具 / 最新回复 / 时长）；没在跑时为 null */
  live?: BoardTaskLive | null
  /**
   * 跑完之后留下的「最后说了什么」（最近一条 job 的正文摘录，已压平并截断）。
   * 与 live 互斥：有 job 在跑时恒为 null；从没跑过 / 那次没写正文时是空串。
   */
  lastReply?: string | null
  /**
   * 最近一条 job 用的执行器（`claude` | `opencode` | `codex`），卡片上的品牌图标按它取。
   * 从没跑过 / 执行器认不出（老记录没写 agent 字段）时是空串 —— 空串不渲染图标，
   * 而不是回落成某个默认品牌（猜错执行器比不显示更糟）。
   */
  lastJobAgent: string
  lastJobStatus: string | null
  /** 最近一条 job 的结束时间（= 这张卡片跑完的时刻），从没执行过时为 null */
  lastJobEndedAt: string | null
  /**
   * 最近一条 job 实际跑了多久（毫秒），卡片上渲染成「用时 3 分 20 秒」。
   * null = 算不出来（正在跑 → 用 live.elapsedMs；从没跑过 / 老记录缺时间戳），
   * 此时前端不显示这一段，而不是显示一个假的 0。
   */
  lastDurationMs?: number | null
  /** 那条 job 的启动时刻（悬停提示里的「几点到几点」），从没执行过时为 null */
  lastJobStartedAt?: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 弹窗用的 job 明细：服务端已丢弃 prompt/thinking，output 只留尾部 */
export interface TaskDetailJob {
  id: string
  subId: string
  title: string
  status: JobStatus | ''
  pid: number | null
  startedAt: string | null
  endedAt: string | null
  exitCode: number | null
  error: string
  /** 输出尾部（最多 OUTPUT_TAIL_CHARS 字符） */
  outputTail: string
  /** outputTail 是否只是原文的末尾一段，前端据此提示「仅显示末尾」 */
  outputTruncated: boolean
  hasOutput: boolean
}

/** GET /api/workbench/tasks/:id/detail —— 点卡片弹窗时按需取一次 */
export interface TaskDetailResponse {
  success: boolean
  task: Task
  column: TaskColumn
  lastJob: TaskDetailJob | null
  recentJobs: TaskDetailJob[]
  jobCount: number
}

/** 派发过的人类干预指令 */
export interface OrchestratorInstruction {
  id: string
  text: string
  projectPath: string
  at: string | null
  taskId: string | null
  status: 'accepted' | 'rejected' | 'created'
  reason: string
  /** 落点是怎么定下来的：explicit / mention / agent / default（'' = 老记录） */
  targetSource?: string
  /** 这条指令附带了哪一级默认提示词：global / project / both（'' = 没附带） */
  promptSource?: string
  /**
   * `text` 是否因超过**下发**上限而被截断（落盘那份始终完整，见服务端
   * shared.js 的 INSTRUCTION_PREVIEW_CHARS）。前端据此显示"已截断"，
   * 别让人以为当初就只写了这么多 —— 完整原文在 task.desc 里。
   */
  textTruncated?: boolean
}

/**
 * 项目级默认提示词。键是归一化后的项目路径（canonicalProjectPath），
 * 与项目清单 / 看板同一套口径 —— 两侧一旦分叉，派发时就会查不到自己的那条。
 */
export interface ProjectPromptEntry {
  /** 项目路径原始写法（大小写照原样），只用于显示 */
  path: string
  prompt: string
  updatedAt: string | null
}

export type OrchestratorEventKind = 'dispatch' | 'done' | 'error' | 'cancelled' | 'user'

/** 控制台活动流的一行。服务端只给结构化事实，句子由前端 $t() 渲染 */
export interface OrchestratorActivity {
  id: string
  kind: OrchestratorEventKind
  at: string | null
  jobId?: string
  taskId: string | null
  subId?: string | null
  taskTitle: string
  jobStatus?: string
  pid?: number | null
  exitCode?: number | null
  error?: string
  projectPath: string
  projectName: string
  instructionId?: string
  text?: string
  /**
   * `text` 是否因超过**下发**上限而被截断（落盘那份始终完整，见服务端
   * shared.js 的 INSTRUCTION_PREVIEW_CHARS）。前端据此显示"已截断"，
   * 别让人以为当初就只写了这么多 —— 完整原文在 task.desc 里。
   */
  textTruncated?: boolean
  instructionStatus?: string
  reason?: string
  /** 落点是怎么定下来的：explicit / mention / agent / default（'' = 本次升级前的老记录） */
  targetSource?: string
  /** 这条指令附带了哪一级默认提示词：global / project / both（'' = 没附带） */
  promptSource?: string
}

/** 正在执行的执行体（一行 = 一个活跃 job） */
export interface RunningAgent {
  jobId: string
  taskId: string | null
  subId: string | null
  taskTitle: string
  status: string
  pid: number | null
  startedAt: string | null
  projectPath: string
  projectName: string
}

/**
 * 一份进度报告里"当时某个任务长什么样"的事实快照。
 *
 * elapsedMs 是**生成那一刻**算好的，不是前端拿现在的时间减 startedAt：
 * 否则回看三小时前那份"已运行 12 分钟"的报告，会显示成"已运行 3 小时 12 分"，
 * 历史报告就再也说不清"当时是什么情况"了。
 */
export interface ProgressReportFact {
  taskId: string | null
  taskTitle: string
  projectName: string
  startedAt: string | null
  elapsedMs: number
  /** 本轮用的执行器（claude | opencode | codex），'' = 老记录没记 */
  agent: string
  toolCallCount: number
  /** 最近一次工具调用的一句话描述，'' = 还没有 */
  lastTool: string
  /** 最近一行模型输出，'' = 还没有 */
  lastLine: string
  /**
   * 最近 N 次工具调用的名字分布（`Bash×14 · Read×5`），'' = 还没调过工具。
   *
   * 只报"最近一次"看不出 119 次里 118 次在干同一件事，报告就只能写
   * "无法判断是在改代码还是反复读文件"（2026-09-29 补）。
   */
  toolMix?: string
  /** 最近一段思考（`job.thinking` 的尾行），'' = 该轮没有思考块 / 老记录没有这个字段 */
  lastThought?: string
  /**
   * 距最后一次产出（正文 / 思考 / 工具调用）多久，null = 不到阈值 / 老记录没有这个字段。
   * 阈值见服务端 SILENT_NOTABLE_MS —— 这里记的是"显然静默了"，不是精确的空闲时长。
   */
  silentMs?: number | null
  /**
   * 模型给这个任务估的进度（0~100 的整数），null / 缺字段 = 模型没给或给的是脏值 ——
   * 这时**不画**那一条进度条。别拿整体百分比往下摊：那是替模型说它没说过的话。
   */
  percent?: number | null
}

/** 报告生成失败的原因码。'' = 成功；正文由前端 $t() 渲染，服务端只给码 */
export type ProgressReportErrorCode = '' | 'NO_MODEL' | 'LLM_TIMEOUT' | 'LLM_EMPTY' | 'LLM_FAILED'

/**
 * 一份进度报告：一段模型写的汇报 + 当时那批任务的事实。
 *
 * 历史里**不会有 `tasks: []` 的那种** —— 没有任务在跑时服务端既不生成也不落盘
 * （见 routes/workbench/index.js 的 runProgressReport、orchestratorStore 的 readReports），
 * 所以正常流程里拿到的每一份都带事实。渲染层保留着"空事实"的分支，那是给脏数据兜底的，
 * 不要指望它在正常流程里被走到。
 */
export interface ProgressReport {
  id: string
  at: string | null
  trigger: 'auto' | 'manual'
  text: string
  /**
   * 主 Agent 对**整体**进度的估计（0~100 的整数），null / 缺字段 = 它没给 ——
   * 界面据此决定画不画顶部那条进度条。
   *
   * 它是模型给的**估计**，不是精确进度：判据是任务的思考 / 工具分布 / 静默时长，
   * 和"还剩多少活"没有硬对应关系。所以界面上必须写明这是 AI 估计（见
   * OrchestratorConsole 的 .rp__percent-tag），不能光甩一个百分比数字让人当成实测值。
   */
  percent?: number | null
  errorCode: ProgressReportErrorCode
  /** 失败时的原始报错（模型 / 网关给的），只用于展示细节 */
  errorDetail: string
  tasks: ProgressReportFact[]
}

export interface ProjectsResponse {
  success: boolean
  projects: ProjectSummary[]
  tasks: BoardTask[]
  currentProjectPath: string
  error?: string
}

export interface OrchestratorResponse {
  success: boolean
  active: boolean
  updatedAt: string | null
  instructions: OrchestratorInstruction[]
  /** 全局默认提示词（'' = 没设置）。派发时自动附加在指令之前 */
  defaultPrompt?: string
  /** 各项目的默认提示词，键为归一化项目路径 */
  projectPrompts?: Record<string, ProjectPromptEntry>
  /** 自动进度报告间隔（毫秒），0 = 关闭。报告正文走 /orchestrator/reports，不在这份轮询里 */
  reportIntervalMs?: number
  /** 上次生成报告的时间（含"已抢占名额、还在生成中"那一瞬间） */
  lastReportAt?: string | null
  /**
   * 指令正文上限（字符）。**以服务端为准**（派发校验的同一份常量，
   * 见服务端 shared.js 的 MAX_INSTRUCTION_CHARS）—— 前端只拿它显示计数器，
   * 不自己另定一个数，否则就是"界面说还有余量、点下去 400"。
   */
  maxInstructionChars?: number
  activity: OrchestratorActivity[]
  running: RunningAgent[]
  error?: string
}
