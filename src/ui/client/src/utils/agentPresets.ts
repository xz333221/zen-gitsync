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
// 数据流：~/.zen-gitsync/config.json 的 agentPresetPrompts（全局，跨项目共享）
//   → configStore.agentPresetPrompts
//   → resolveAgentPresets()（空数组时回落这里的内置默认）
//   → ChatContainer 的 preset-questions。

import { $t } from '@/lang/static'

/** 一条预设卡片：label = 卡片标题，prompt = 点击后原样发送给 g ai 的内容 */
export interface AgentPresetPrompt {
  id: string
  label: string
  prompt: string
}

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

/** 生效的预设：配置里有自定义（非空数组）用自定义，否则回落内置默认 */
export function resolveAgentPresets(
  custom: AgentPresetPrompt[] | null | undefined,
  view?: string | null
): AgentPresetPrompt[] {
  if (Array.isArray(custom) && custom.length > 0) return custom
  const viewPresets = viewAgentPresets(view)
  if (viewPresets.length > 0) return viewPresets
  return builtinAgentPresets()
}

/**
 * 按板块（活动栏 Tab）的预设提示词。
 *
 * 同一个 g ai 浮窗在任何板块都能唤起，但"查看项目结构 / 帮我提交代码"这种问题
 * 摆在「系统运行状态」页就很突兀 —— 用户此刻看的是 CPU / 内存 / 端口，
 * 想问的自然是这些。所以每个板块给一组更贴题的问题。
 *
 * 优先级：**用户在设置里自定义过 → 全板块统一用自定义**。
 * 这是刻意的：自定义是一份明确的用户意图，混进内置的板块预设会让人以为设置没生效。
 * 想要板块专属 → 现在只能改内置（未来若做"按板块配置"，入口应加到设置面板里）。
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
