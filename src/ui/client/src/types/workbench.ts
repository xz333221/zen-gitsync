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
//   - JobFull: 管理页用的完整形态（反范式 taskTitle/subTitle、size）

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
   *  opencode 执行器把 sessionID 也存这里（语义 = "该执行器的会话续接标识"）。
   *  老 job 没这个字段;init 事件来之前也可能为空。 */
  claudeSessionId?: string | null
  /** 本轮用的执行器：'claude' | 'opencode'。老 job 没这个字段（视为 claude） */
  agent?: string
  /** opencode 协议层 error 事件捕获的错误消息（进程退出码可能是 0，靠它判失败） */
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

export interface SubTask {
  id: string
  title: string
  desc: string
  status: 'todo' | 'running' | 'done' | 'error'
  promptOverride: string
  attachments?: Attachment[]
  error?: string
  errorAt?: string
}

export interface Task {
  id: string
  title: string
  desc: string
  promptId: string | null
  type?: 'simple' | 'complex'
  simpleOverride?: string
  projectPath?: string
  sequential?: boolean
  subtasks: SubTask[]
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
  subTitle: string
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
  errorSubtasks: number
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

/** 看板卡片：任务的精简形态 */
export interface BoardTask {
  id: string
  title: string
  desc: string
  type: 'simple' | 'complex'
  projectPath: string
  column: TaskColumn
  subtaskCount: number
  subtaskDoneCount: number
  subtaskErrorCount: number
  attachmentCount: number
  runningJobs: number
  lastJobStatus: string | null
  /** 最近一条 job 的结束时间（= 这张卡片跑完的时刻），从没执行过时为 null */
  lastJobEndedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 弹窗用的 job 明细：服务端已丢弃 prompt/thinking，output 只留尾部 */
export interface TaskDetailJob {
  id: string
  subId: string
  title: string
  subTitle: string
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
  subTitle: string
  jobStatus?: string
  pid?: number | null
  exitCode?: number | null
  error?: string
  projectPath: string
  projectName: string
  instructionId?: string
  text?: string
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
  subTitle: string
  status: string
  pid: number | null
  startedAt: string | null
  projectPath: string
  projectName: string
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
  activity: OrchestratorActivity[]
  running: RunningAgent[]
  error?: string
}
