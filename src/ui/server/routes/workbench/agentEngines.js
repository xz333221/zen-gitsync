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
// 智能体面板的「引擎」注册表。
//
// 引擎 = 谁来跑这一轮对话的智能体循环。两种性质完全不同：
//
//   gai ── 内置。**服务端**跑循环：LLM 流式 + 服务端执行工具（src/cli/ai/tools.js），
//          前端只渲染事件。默认引擎，历史行为。
//
//   claude / opencode / codex ── 外部 CLI。**CLI 自己**跑循环：它有自己的工具集、
//          自己的系统提示词、自己的权限模型。服务端退化成一根管子 —— spawn 出来、
//          把它的 NDJSON 翻译成同一组 SSE 事件。见 runExternalTurn.js。
//
// ⚠️ 这儿**不新写一份 id 清单**：外部三家直接复用 config.js 的 TASK_EXECUTORS。
//   本仓库为"同一份口径在多个地方各写一遍"吃过亏（见 agentParity.test.js 的注释：
//   提示词四处、路径归一三处，分叉的失效方式是「不报错，两个入口表现不一样」）。
//   工作台那份是任务执行器，这里是对话引擎，但**底层是同一批 CLI**，加第四家时
//   应当只改 config.js 一处。有单测钉住这条。

import { TASK_EXECUTORS } from '../../../../config.js';

/** 内置引擎 id。用 'gai' 而不是 'g-ai'/'zen'：前端路由与 i18n key 都用它。 */
export const BUILTIN_ENGINE = 'gai';

/** 外部 CLI 引擎（顺序继承 config.js，与工作台执行器列表一致） */
export const EXTERNAL_ENGINES = TASK_EXECUTORS;

/** 全部可选引擎，内置排第一（前端下拉默认选中第一项） */
export const AGENT_ENGINES = [BUILTIN_ENGINE, ...EXTERNAL_ENGINES];

/**
 * 展示名。产品名中英文一致、不走 i18n —— 与前端 utils/taskExecutor.ts 的
 * TASK_EXECUTOR_OPTIONS 同一条判断（"Claude Code" 在中文界面里也不译）。
 */
export const ENGINE_LABELS = {
  [BUILTIN_ENGINE]: 'g ai',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex',
};

export function isAgentEngine(value) {
  return typeof value === 'string' && AGENT_ENGINES.includes(value);
}

export function isExternalEngine(value) {
  return typeof value === 'string' && EXTERNAL_ENGINES.includes(value);
}

/**
 * 归一化：非法/缺省一律回落内置引擎。
 *
 * 为什么回落而不是报错：body.engine 来自网络，老前端不会带这个字段。
 * 报错会让所有老客户端在升级服务端后立刻不能聊天 —— 回落才是安全的兼容方向
 * （与 taskRunner.normalizeTaskExecutor 的取舍一致）。
 */
export function normalizeAgentEngine(value) {
  if (typeof value !== 'string') return BUILTIN_ENGINE;
  const v = value.trim().toLowerCase();
  return isAgentEngine(v) ? v : BUILTIN_ENGINE;
}

export function engineLabel(id) {
  return ENGINE_LABELS[normalizeAgentEngine(id)];
}
