// 智能体面板「引擎」的选择状态。
//
// 口径（2026-09-28 与用户对齐）：
//   - 内置 g ai 是默认项，排第一
//   - 外部三家（Claude Code / OpenCode / Codex）与工作台是**同一批 CLI**，
//     所以 id/名字一律从 utils/taskExecutor.ts 派生，**不在这里再写一份**。
//     本仓库为"同一份清单抄两处"吃过亏（见 server 侧 agentParity.test.js 的注释），
//     加第四家时应当只改 taskExecutor.ts 一处。
//   - 选择记在 localStorage（与工作台的临时切换同一取舍：比"只在内存"多活一次刷新，
//     又不污染 config.json —— 文件里那份始终代表工作台的默认执行器）
//
// ⚠️ 与工作台**不同**的一条：工作台可以每次派发都临时换执行器；
//    这里一旦会话开了头就锁死引擎，中途只能新建会话。原因是三家的续聊标识互不通用
//    （claude --resume / opencode --session / codex exec resume），且历史消息格式不同。
//    服务端也做了同样的拦截（ENGINE_LOCKED），前端这里只是提前把 UI 置灰。
//
// ── 关于内置引擎的图标（2026-09-28 改的口径，改前先读）────────────────
// 初版刻意让 g ai **不带图标**（"不给 AI 功能贴装饰性图标"）。用户看过下拉后指出：
// 下面三家各有品牌图标、只有 g ai 那行左边空一格，看起来是"图标没加载出来"。
// 于是改为复用仓库里早就有的 g ai 产品标识（assets/icons/svg/g-ai.svg，
// 走 sprite，与顶栏"用 g ai 打开当前目录"按钮同一个 icon-class）。
// 这不违反原来那条口径：那条针对的是**给"AI 功能"贴的装饰性小图标**（魔法棒 / 闪光），
// 而这里是"四个引擎各自的身份标识"，三缺一才是问题。
//
// 图标怎么渲染也分两路，与顶栏 DirectorySelector 完全一致：
//   · 内置 g ai → sprite，`<svg-icon icon-class="g-ai">`（BUILTIN_ENGINE_ICON）
//   · 外部三家 → 品牌彩色 SVG，`<TaskExecutorIcon>`（utils/taskExecutor.ts 那一批）

import { TASK_EXECUTOR_OPTIONS, isTaskExecutorId, type TaskExecutorId } from './taskExecutor'

export type AgentEngineId = 'gai' | TaskExecutorId

/** 内置引擎的展示名。产品名，中英文一致，不走 i18n（与 TASK_EXECUTOR_OPTIONS 同一条判断） */
export const BUILTIN_ENGINE_NAME = 'g ai'

/**
 * 内置引擎的图标 —— sprite 里的 icon-class（见 assets/icons/svg/g-ai.svg）。
 * 与顶栏 DirectorySelector 的"用 g ai 打开当前目录"按钮用的是同一张。
 */
export const BUILTIN_ENGINE_ICON = 'g-ai'

export interface AgentEngineOption {
  id: AgentEngineId
  name: string
}

export const AGENT_ENGINE_OPTIONS: AgentEngineOption[] = [
  { id: 'gai', name: BUILTIN_ENGINE_NAME },
  ...TASK_EXECUTOR_OPTIONS.map(o => ({ id: o.id as AgentEngineId, name: o.name })),
]

const STORAGE_KEY = 'zen-gitsync-agent-engine'

export function isAgentEngineId(value: unknown): value is AgentEngineId {
  if (value === 'gai') return true
  return isTaskExecutorId(value)
}

/** 按 id 取展示名。未知/缺省回落内置 g ai */
export function agentEngineName(id?: string | null): string {
  return AGENT_ENGINE_OPTIONS.find(o => o.id === id)?.name || BUILTIN_ENGINE_NAME
}

/** 是否是外部 CLI 引擎（服务端会 spawn 子进程，权限档与 g ai 完全不同） */
export function isExternalAgentEngine(id?: string | null): id is TaskExecutorId {
  return isTaskExecutorId(id)
}

/** 读上次选的引擎（只影响**新建会话**的默认值）；没有/损坏时回落 g ai */
export function getSelectedAgentEngine(): AgentEngineId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (isAgentEngineId(raw)) return raw
  } catch { /* localStorage 不可用（隐私模式等） */ }
  return 'gai'
}

export function setSelectedAgentEngine(value: AgentEngineId): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch { /* 忽略：下次启动回落默认 */ }
}
