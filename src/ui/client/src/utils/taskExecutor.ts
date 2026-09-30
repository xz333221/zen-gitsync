// 工作台任务执行器的**纯口径**：id 集合 / 展示名 / 收口校验。
//
// 这里**只放纯函数**，不引 store / fetch / i18n —— 它被 agentEngine.test.ts 用相对路径
// 直接 import，不该因为一个类型声明就把 Pinia / 网络拉进单测环境。
// 「当前选了哪个」那种带状态的部分在 composables/useTaskExecutorSelection.ts。
//
// 口径：
//   - 默认执行器在「设置 → 通用设置 → 任务执行器」里配置（config.taskExecutor，全局）
//   - 「上次用过哪个」记在 config.json 的 ui.lastTaskExecutor（同一个 composable 读写）。
//     这里曾经用 localStorage 记（键 zen-gitsync-task-executor），但 GUI 每次启动都换一个
//     随机端口，origin 一变 localStorage 就是另一个桶 —— "记住上次"从来没生效过。
//     同仓其他 UI 状态（视图模式 / 分割比例）早就为此迁到了 config.json 的 ui 字段。
//   - 任务续聊不走这里：续哪个执行器由上一轮 job.agent 决定（服务端强制），
//     否则 claude 的 --resume、opencode 的 --session、codex 的 exec resume 会互不认对方的会话 id
export type TaskExecutorId = 'claude' | 'opencode' | 'codex'

export interface TaskExecutorOption {
  id: TaskExecutorId
  /** 产品名，中英文一致，不走 i18n */
  name: string
}

export const TASK_EXECUTOR_OPTIONS: TaskExecutorOption[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'codex', name: 'Codex' },
]

// ── 执行器当前配置的模型（展示口径）─────────────────────────────────────────
//
// 这里只有类型、没有取数逻辑：取数要发请求 + 缓存 + 定时刷新，那套东西
// 归「本机 CLI 探测」那一个 store（stores/toolsStore），取值口在
// composables/useTaskExecutorSelection 的 executorModelText / executorModelTitle。

/**
 * 某个执行器当前配置的模型。字段来自服务端只读探测
 * （src/ui/server/routes/workbench/executorModels.js，读三个 CLI 的配置文件）。
 */
export interface ExecutorModelInfo {
  /**
   * 给人看的名字。claude 场景下这是**别名背后真实模型**（本机是 deepseek-v4.1-flash），
   * 不是 CLI 认识的别名 —— 用户看到 claude-sonnet-5 会以为在用官方模型。
   */
  name: string
  /** 次要信息（claude 的 CLI 别名）。进 title 用；没有则 null */
  detail: string | null
  /** 服务商名或 base_url；没有则 null */
  provider: string | null
  /**
   * 这个模型是从哪读到的 —— 同一个模型名，来源不同含义不同：
   *   'config' 配置文件里写死的（"默认模型"）
   *   'state'  CLI 自己记的"上次用的"（opencode 的 TUI 选择不回写配置文件）
   *   null     不适用（claude / codex 只有一处来源）
   */
  source: 'config' | 'state' | null
}

/**
 * 模型展示的**三态**。
 *
 * 为什么必须区分 unknown 与 unset：探测请求还没回来时就把界面写成「未在配置中指定」
 * 是在撒谎 —— 用户会以为"我确实没配"，而事实只是"还没问到"。unknown 一律不渲染，
 * 等结果到了再决定说哪一句。
 */
export type ExecutorModelState =
  | { status: 'unknown' }
  | { status: 'unset' }
  | { status: 'set'; info: ExecutorModelInfo }

/** 收口校验：新加执行器只改 TASK_EXECUTOR_OPTIONS，各处的 isValid 跟着走 */
export function isTaskExecutorId(value: unknown): value is TaskExecutorId {
  return TASK_EXECUTOR_OPTIONS.some(o => o.id === value)
}

/**
 * 按执行器 id 取展示名。未知/缺省（老 job 没有 agent 字段）回落列表首项 Claude Code ——
 * 与 avatarForExecutor 的回落口径一致。
 */
export function taskExecutorName(id?: string | null): string {
  return TASK_EXECUTOR_OPTIONS.find(o => o.id === id)?.name || TASK_EXECUTOR_OPTIONS[0].name
}
