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
   *  老 job 没这个字段;init 事件来之前也可能为空。 */
  claudeSessionId?: string | null
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
