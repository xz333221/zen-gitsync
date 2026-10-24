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
/**
 * 右下角 g ai dock 的轻量事件总线（模块级 reactive，与 useConvListCollapse 同一范式）。
 *
 * 为什么需要它：AI 对话入口整合后，「智能体」tab 没有了，但别的地方仍要能
 * 「打开 dock 并把问题发进去」——最典型的是 Git 视图「AI 项目状态解读」下面的
 * 追问 chips：点一下就要带着这批目录的 Git 状态和解读原文去问 g ai。
 * 发问的动作必须落在 dock 里那个 AgentView 实例上（它自持 useAgentChat），
 * 所以这里只传「想 asks 什么」，由 AgentDock 监听后转发给 AgentView.askQuestion。
 *
 * 两个字段：
 * - open：面板是否展开（chips 置 true；AgentDock 的开关也写它，保证单一事实源）
 * - pending：待发问的问题（AgentDock 消费后立刻清掉，防重入）
 */
import { reactive } from 'vue'

export interface AgentDockAskPayload {
  /** 要发送的问题文本 */
  text: string
  /** 这批目录的 Git 状态（服务端认识的形状，可选） */
  dirStatus?: unknown[]
  /** 解读原文（可选；没有就只带状态） */
  dirSummary?: string
}

export const agentDockBus = reactive({
  open: false,
  pending: null as AgentDockAskPayload | null,
})

/** 打开 dock 并把问题发进对话（Git 视图追问 chips 用） */
export function askAgentDock(p: AgentDockAskPayload): void {
  agentDockBus.pending = p
  agentDockBus.open = true
}
