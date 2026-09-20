// 工作台任务执行器的选择状态。
//
// 口径（2026-09-20 与用户对齐）：
//   - 默认执行器在「设置 → 通用设置 → 任务执行器」里配置（config.taskExecutor，全局）
//   - 工作台执行按钮旁可以**临时切**，选择记在 localStorage——比"只在内存"多活一次刷新，
//     又不污染文件配置（文件里那份始终代表"默认值"）
//   - 简单任务续聊不走这里：续哪个执行器由上一轮 job.agent 决定（服务端强制），
//     否则 claude 的 --resume 和 opencode 的 --session 会互不认对方的会话 id
//
// localStorage 键沿用 `zen-gitsync-` 前缀（历史上迁移 UI 状态到 config.json 时
// 保留的命名习惯）；它不进 config.json 的 ui 迁移清单——临时选择就该留在浏览器侧。

export type TaskExecutorId = 'claude' | 'opencode'

const STORAGE_KEY = 'zen-gitsync-task-executor'

export interface TaskExecutorOption {
  id: TaskExecutorId
  /** 产品名，中英文一致，不走 i18n */
  name: string
}

export const TASK_EXECUTOR_OPTIONS: TaskExecutorOption[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
]

function isValid(value: unknown): value is TaskExecutorId {
  return value === 'claude' || value === 'opencode'
}

/** 读上次的临时选择；没有/损坏时回落 'claude'（与后端默认一致） */
export function getSelectedTaskExecutor(): TaskExecutorId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isValid(raw)) return raw
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return 'claude'
}

export function setSelectedTaskExecutor(value: TaskExecutorId): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch { /* 忽略：下次启动回落默认 */ }
}
