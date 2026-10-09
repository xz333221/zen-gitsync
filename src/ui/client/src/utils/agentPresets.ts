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
  custom: AgentPresetPrompt[] | null | undefined
): AgentPresetPrompt[] {
  if (Array.isArray(custom) && custom.length > 0) return custom
  return builtinAgentPresets()
}

/**
 * 生成一条新预设的 id。本地唯一即可 —— 服务端只拿它当去重键（缺失/重复都会补），
 * 前端拿它当 v-for key（增删时保持稳定）。用时间戳 + 随机后缀，避免快速连点时撞号。
 */
export function newAgentPresetId(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
