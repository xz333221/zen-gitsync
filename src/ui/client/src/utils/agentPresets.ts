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
// 智能体视图欢迎页「预设提示词」（快捷卡片）的共享定义。
//
// 抽成独立模块的原因：内置默认要在**两处**用到 ——
//   1. AgentView 欢迎页：配置里没有自定义时展示它；
//   2. 设置面板（GitGlobalSettingsDialog）：编辑预设时拿它当初始草稿 / 「恢复默认」的目标。
// 两处各写一份迟早分叉（而且内置文案是 i18n 的，分叉了肉眼很难发现）。
//
// 数据流：~/.zen-gitsync/config.json 的
//   · agentPresetPrompts        —— 通用那一套（所有板块的兜底）
//   · agentPresetPromptsByView  —— { [板块]: 该板块专属的一套 }
//   → configStore（两个 ref）
//   → resolveAgentPresets()（按优先级回落内置）
//   → ChatContainer 的 preset-questions。

import { $t } from '@/lang/static'

/** 一条预设卡片：label = 卡片标题，prompt = 点击后原样发送给 g ai 的内容 */
export interface AgentPresetPrompt {
  id: string
  label: string
  prompt: string
}

/** 按板块存的预设：键是板块 id，值是那一套（非空；没配过的板块不出现在这里） */
export type AgentPresetsByView = Record<string, AgentPresetPrompt[]>

/**
 * 有专属预设的板块（与活动栏的 view id 一一对应）。
 * ⚠️ 必须与后端 src/config.js 的 AGENT_PRESET_VIEW_IDS 一致 —— 那边按它做白名单，
 * 多写一个前端要用的板块、后端不认识，保存时会被静默丢掉。
 */
export const AGENT_PRESET_VIEW_IDS = [
  'git', 'console', 'editor', 'source-map', 'workbench', 'projects', 'monitor', 'mindmap'
] as const

/**
 * 设置面板里的作用域列表：''（通用，所有板块的兜底）+ 每个板块。
 * labelKey 指向活动栏那套文案（@ACTBAR），别在这里另写一份中英文 —— 板块改名时
 * 两处必然对不上。
 */
export const AGENT_PRESET_SCOPES: { id: string; labelKey: string }[] = [
  { id: '', labelKey: '@42BB9:通用（兜底）' },
  { id: 'git', labelKey: '@ACTBAR:Git' },
  { id: 'console', labelKey: '@ACTBAR:控制台' },
  { id: 'editor', labelKey: '@ACTBAR:编辑器' },
  { id: 'source-map', labelKey: '@ACTBAR:源码地图' },
  { id: 'workbench', labelKey: '@ACTBAR:工作台' },
  { id: 'projects', labelKey: '@ACTBAR:项目管理' },
  { id: 'monitor', labelKey: '@ACTBAR:系统监控' },
  { id: 'mindmap', labelKey: '@ACTBAR:思维导图' }
]

/**
 * 内置默认的 5 条（文案随界面语言走）。
 * 只在「配置里没有自定义」时使用 —— 用户一旦自定义，存的是全量快照，
 * 内置文案后续更新不会覆盖用户版本（想回来点设置里的「恢复默认」）。
 */
export function builtinAgentPresets(): AgentPresetPrompt[] {
  return [
    { id: 'p1', label: $t('@AGENT:查看项目结构'), prompt: $t('@AGENT:prompt_p1') },
    { id: 'p2', label: $t('@AGENT:分析代码质量'), prompt: $t('@AGENT:prompt_p2') },
    { id: 'p3', label: $t('@AGENT:帮我提交代码'), prompt: $t('@AGENT:prompt_p3') },
    { id: 'p4', label: $t('@AGENT:Git 状态检查'), prompt: $t('@AGENT:prompt_p4') },
    { id: 'p5', label: $t('@AGENT:帮我启动项目'), prompt: $t('@AGENT:prompt_p5') }
  ]
}

/**
 * 生效的预设：优先级只有这一处实现，别在组件里再写一遍。
 *
 *   本板块自定义（byView[view]）> 通用自定义（custom）> 板块内置 > 通用内置
 *
 * 为什么板块自定义排在通用自定义前面：通用那套是"所有板块的兜底"。用户专门给某个
 * 板块写了一套，再让通用覆盖它就是白写 —— 这也是 2026-10-25 用户提这条需求的理由
 *（"每个板块有不同的预设提示词"）。
 */
export function resolveAgentPresets(
  custom: AgentPresetPrompt[] | null | undefined,
  view?: string | null,
  byView?: AgentPresetsByView | null
): AgentPresetPrompt[] {
  const scoped = view && byView && typeof byView === 'object' ? byView[view] : null
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  if (Array.isArray(custom) && custom.length > 0) return custom
  const viewPresets = viewAgentPresets(view)
  if (viewPresets.length > 0) return viewPresets
  return builtinAgentPresets()
}

/**
 * 某个设置作用域的内置文案：'' = 通用内置 5 条；板块 = 该板块的内置那一套。
 * 设置面板用它在"没自定义"时当草稿（用户改了才落成自定义）。
 */
export function builtinPresetsForScope(scope: string): AgentPresetPrompt[] {
  if (!scope) return builtinAgentPresets()
  const viewPresets = viewAgentPresets(scope)
  return viewPresets.length > 0 ? viewPresets : builtinAgentPresets()
}

/**
 * 按板块（活动栏 Tab）的预设提示词。
 *
 * 同一个 g ai 浮窗在任何板块都能唤起，但"查看项目结构 / 帮我提交代码"这种问题
 * 摆在「系统运行状态」页就很突兀 —— 用户此刻看的是 CPU / 内存 / 端口，
 * 想问的自然是这些。所以每个板块给一组更贴题的问题。
 *
 * 这些是**内置**文案；用户在设置里给某个板块单独配过就用他那套（见 resolveAgentPresets）。
 */
const VIEW_PRESETS: Record<string, () => AgentPresetPrompt[]> = {
  git: () => [
    { id: 'git-1', label: $t('@AGENT:vp_git_1'), prompt: $t('@AGENT:vq_git_1') },
    { id: 'git-2', label: $t('@AGENT:vp_git_2'), prompt: $t('@AGENT:vq_git_2') },
    { id: 'git-3', label: $t('@AGENT:vp_git_3'), prompt: $t('@AGENT:vq_git_3') },
    { id: 'git-4', label: $t('@AGENT:vp_git_4'), prompt: $t('@AGENT:vq_git_4') }
  ],
  console: () => [
    { id: 'console-1', label: $t('@AGENT:vp_console_1'), prompt: $t('@AGENT:vq_console_1') },
    { id: 'console-2', label: $t('@AGENT:vp_console_2'), prompt: $t('@AGENT:vq_console_2') },
    { id: 'console-3', label: $t('@AGENT:vp_console_3'), prompt: $t('@AGENT:vq_console_3') },
    { id: 'console-4', label: $t('@AGENT:vp_console_4'), prompt: $t('@AGENT:vq_console_4') }
  ],
  editor: () => [
    { id: 'editor-1', label: $t('@AGENT:vp_editor_1'), prompt: $t('@AGENT:vq_editor_1') },
    { id: 'editor-2', label: $t('@AGENT:vp_editor_2'), prompt: $t('@AGENT:vq_editor_2') },
    { id: 'editor-3', label: $t('@AGENT:vp_editor_3'), prompt: $t('@AGENT:vq_editor_3') },
    { id: 'editor-4', label: $t('@AGENT:vp_editor_4'), prompt: $t('@AGENT:vq_editor_4') }
  ],
  'source-map': () => [
    { id: 'source-map-1', label: $t('@AGENT:vp_source-map_1'), prompt: $t('@AGENT:vq_source-map_1') },
    { id: 'source-map-2', label: $t('@AGENT:vp_source-map_2'), prompt: $t('@AGENT:vq_source-map_2') },
    { id: 'source-map-3', label: $t('@AGENT:vp_source-map_3'), prompt: $t('@AGENT:vq_source-map_3') },
    { id: 'source-map-4', label: $t('@AGENT:vp_source-map_4'), prompt: $t('@AGENT:vq_source-map_4') }
  ],
  mindmap: () => [
    { id: 'mindmap-1', label: $t('@AGENT:vp_mindmap_1'), prompt: $t('@AGENT:vq_mindmap_1') },
    { id: 'mindmap-2', label: $t('@AGENT:vp_mindmap_2'), prompt: $t('@AGENT:vq_mindmap_2') },
    { id: 'mindmap-3', label: $t('@AGENT:vp_mindmap_3'), prompt: $t('@AGENT:vq_mindmap_3') },
    { id: 'mindmap-4', label: $t('@AGENT:vp_mindmap_4'), prompt: $t('@AGENT:vq_mindmap_4') }
  ],
  monitor: () => [
    { id: 'monitor-1', label: $t('@AGENT:vp_monitor_1'), prompt: $t('@AGENT:vq_monitor_1') },
    { id: 'monitor-2', label: $t('@AGENT:vp_monitor_2'), prompt: $t('@AGENT:vq_monitor_2') },
    { id: 'monitor-3', label: $t('@AGENT:vp_monitor_3'), prompt: $t('@AGENT:vq_monitor_3') },
    { id: 'monitor-4', label: $t('@AGENT:vp_monitor_4'), prompt: $t('@AGENT:vq_monitor_4') }
  ],
  projects: () => [
    { id: 'projects-1', label: $t('@AGENT:vp_projects_1'), prompt: $t('@AGENT:vq_projects_1') },
    { id: 'projects-2', label: $t('@AGENT:vp_projects_2'), prompt: $t('@AGENT:vq_projects_2') },
    { id: 'projects-3', label: $t('@AGENT:vp_projects_3'), prompt: $t('@AGENT:vq_projects_3') }
  ],
  workbench: () => [
    { id: 'workbench-1', label: $t('@AGENT:vp_workbench_1'), prompt: $t('@AGENT:vq_workbench_1') },
    { id: 'workbench-2', label: $t('@AGENT:vp_workbench_2'), prompt: $t('@AGENT:vq_workbench_2') },
    { id: 'workbench-3', label: $t('@AGENT:vp_workbench_3'), prompt: $t('@AGENT:vq_workbench_3') },
    { id: 'workbench-4', label: $t('@AGENT:vp_workbench_4'), prompt: $t('@AGENT:vq_workbench_4') }
  ]
}

/** 某个板块的专属预设；没有专用条目（或 view 为空 / 未知）时返回空数组 */
export function viewAgentPresets(view: string | null | undefined): AgentPresetPrompt[] {
  if (!view) return []
  const build = VIEW_PRESETS[view]
  return build ? build() : []
}

/**
 * 生成一条新预设的 id。本地唯一即可 —— 服务端只拿它当去重键（缺失/重复都会补），
 * 前端拿它当 v-for key（增删时保持稳定）。用时间戳 + 随机后缀，避免快速连点时撞号。
 */
export function newAgentPresetId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
