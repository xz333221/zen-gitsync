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
// 「和 g ai 对话时固定注入的两块提示词」—— 拼装规则（纯函数）+ 取数（读两处配置）。
//
// 两块分别来自两处，语义也不同，别混：
//   ① g ai 智能体的默认提示词 —— config.json 的 agentDefaultPrompt，
//      在「智能体视图 → 设置」里编辑。只喂给 g ai 自己。
//   ② 派发任务的提示词 —— orchestrator.json 的 defaultPrompt（+ 落点项目的 projectPrompts），
//      和工作台「预设提示词」是**同一份**（同一套读写接口，同一处解析）。
//      它的原生用途是"派发任务时附加在指令之前"（见 orchestratorStore.resolveDispatchPrompt）；
//      这里把同一份也喂给对话中的 g ai —— 用户在 g ai 里说的"帮我改完就提交"
//      本来就依赖这些约束，让它在对话里也看得见。
//
// ⚠️ 为什么注入的是**每轮请求副本**而不是会话里的那条 system 消息：
//   会话的 system 消息只在首轮写入并落盘，之后改设置要新开会话才生效，而且会把
//   当时的配置永久腌进会话文件（回看历史会话时看到的是过期规则，还占上下文）。
//   注入请求副本则每轮现读、立即生效、不落盘 —— 与工作区快照/附件路径同一套口径
//   （见 agentChat.js 的 injectRequestContext）。
//
// ⚠️ 解析失败一律当作"没有配置"（返回空串），绝不抛：配置坏了不该让用户发不出消息。
//   与 workspaceBlock 的兜底口径一致。

import configManager from '../../../../config.js';
import { logger } from './shared.js';
import { readOrchestrator, resolveDispatchPrompt } from './orchestratorStore.js';

/**
 * 拼「用户固定提示词」这一节。
 *
 * 纯函数：只吃入参、不做 IO，单测不碰真实用户数据（与 promptParts.js / memoryContext.js
 * 同一个理由）。取数在 resolveChatPromptSection。
 *
 * @param {object} input
 * @param {string} [input.gaiPrompt]      g ai 默认提示词（'' = 没设）
 * @param {string} [input.dispatchPrompt] 派发任务提示词（全局 + 落点项目，'' = 没设）
 * @param {string} [input.locale]         'zh' | 'en' —— 与系统提示词同一套判定
 * @returns {string} 两块都空时返回 ''（调用方据此完全跳过注入）
 */
export function buildChatPromptSection({ gaiPrompt = '', dispatchPrompt = '', locale = 'zh-CN' } = {}) {
  const gai = typeof gaiPrompt === 'string' ? gaiPrompt.trim() : '';
  const dispatch = typeof dispatchPrompt === 'string' ? dispatchPrompt.trim() : '';
  if (!gai && !dispatch) return '';

  const en = String(locale || '').startsWith('en');
  const parts = [];
  if (gai) parts.push(`${en ? '### g ai default prompt' : '### g ai 默认提示词'}\n${gai}`);
  if (dispatch) {
    // 括号里那句是给模型看的（也是给排查的人看的）：这一块的来源与工作台是同一份，
    // 不是对话专属的又一份配置 —— 模型据此知道"这些约束在派发出去的任务里同样成立"。
    parts.push(en
      ? `### Dispatch prompt (same text attached to tasks dispatched from the workbench)\n${dispatch}`
      : `### 派发任务的提示词（与工作台派发任务时附加的是同一份）\n${dispatch}`);
  }

  const head = en
    ? 'The user configured the following standing instructions in Settings. They apply to every turn of this conversation — follow them alongside your built-in rules.'
    : '以下是用户在「设置」里配置的固定提示词，对本轮对话生效 —— 请与你的内置规则一并遵守。';

  return `${head}\n\n${parts.join('\n\n')}`;
}

/**
 * 拼「派活」这一节的策略（主动 / 不主动 / 定时任务）。
 *
 * 为什么非主动时也要注入：`dispatch_task` 一直在工具表里，它的 schema 写的是
 * "让别的 agent 替我干活"。只"少注入一段"等于没约束 —— 模型照样会照着 schema
 * 派活。所以关闭时要**反向**给一条"不要主动派"，不然开关是假的。
 *
 * 为什么定时任务单独一版：那条链路本来就是无人值守（scheduler.js 直接调
 * runAgentTurn），用户在任务里写什么就做什么；再给一份"主动派"的策略等于
 * 让它在没人盯着的时候自己 spawn CLI，成本和风险都放大。
 *
 * 纯函数、不读配置：调用方（agentRoutes / scheduler）才知道这一轮是什么形态。
 *
 * @param {object} input
 * @param {boolean} [input.proactive] 用户是否开了「让 g ai 主动派活」
 * @param {boolean} [input.scheduled] 这一轮是不是定时任务发起的
 * @param {string}  [input.locale]
 * @returns {string} 空串 = 不注入
 */
export function buildDispatchPolicySection({ proactive = true, scheduled = false, locale = 'zh-CN' } = {}) {
  const en = String(locale || '').startsWith('en');

  if (scheduled) {
    return en
      ? '# Dispatching work (unattended run)\n'
        + 'This turn was started by a scheduled task and nobody is watching. Only call `dispatch_task` when the task text explicitly asks for it; otherwise do the work yourself.'
      : '# 派活（无人值守）\n'
        + '这一轮是定时任务发起的，没人盯着。只有任务文本明确要求派发时才调用 `dispatch_task`，否则自己把事情做完。';
  }

  if (!proactive) {
    return en
      ? '# Dispatching work (on request only)\n'
        + 'You can hand work to another executor with `dispatch_task`, but **do not do it on your own initiative**. '
        + 'Only call it when the user explicitly asks to dispatch / hand it to an executor / let another agent do it. '
        + 'In every other case finish the work yourself with your own tools.'
      : '# 派活（只在用户要求时）\n'
        + '你可以用 `dispatch_task` 把活交给别的执行器，但**不要主动这么做**。'
        + '只有用户明确说"派发 / 派给别人 / 让某个执行器去做"时才调用；其它情况自己用工具做完。';
  }

  return en
    ? '# Dispatching work (you are allowed to dispatch proactively)\n'
      + 'The user allows you to dispatch work to another executor. **Dispatch it** instead of doing it yourself when:\n'
      + '- the job means editing several files, running a build/test suite, or is otherwise long-running implementation work\n'
      + '- it is unrelated cleanup / refactor / test-writing that would otherwise derail the conversation\n'
      + 'Still do it yourself: answering questions, looking things up, reading files, small single-file edits, and anything that needs back-and-forth with the user.\n'
      + 'Rules for dispatching:\n'
      + '- one call = one task; never dispatch the same thing twice\n'
      + '- `text` must be self-contained (the executor cannot see this conversation or your reasoning)\n'
      + '- do not pass `executor` — the dispatch priority set in Settings decides it; if the user wants a different executor for one job, tell them to reorder that list (a passed `executor` is ignored)\n'
      + '- pass `project_path` when the target is the current working directory (saves the server a fallback lookup)\n'
      + '- after dispatching, say in one or two sentences who got it and where it landed, then carry on — do not redo the work yourself'
    : '# 派活（用户允许你主动派发）\n'
      + '用户已经允许你把活派给别的执行器。以下情况**直接派**，不要自己从头做：\n'
      + '- 要连续改多个文件、跑构建/测试、或明显耗时的实施类工作\n'
      + '- 与本轮对话无关的清理、重构、补测试 —— 顺手派出去，别打断对话\n'
      + '仍然自己做的：回答问题、查资料、读文件、单文件小改、需要边做边和用户确认的事。\n'
      + '派活的规矩：\n'
      + '- 一次调用只派一件事；同一件事不要重复派\n'
      + '- `text` 要写成自足的一轮请求（对方看不到这段对话，也读不到你的推理）\n'
      + '- 不要传 `executor` —— 执行器由设置里的「派发优先级」决定；用户想临时换一个，让他去设置里调顺序（传了也会被忽略）\n'
      + '- 目标就是当前工作目录时直接传 `project_path`，省掉服务端一次落点判断\n'
      + '- 派完用一两句话说明派给了谁、落在哪个项目，然后继续回答用户或等结果，**不要**自己再做一遍';
}

/** 默认取数：config.json 的 agentDefaultPrompt（读不到 = 空） */
async function defaultLoadAgentPrompt() {
  const cfg = await configManager.loadConfig();
  return typeof cfg?.agentDefaultPrompt === 'string' ? cfg.agentDefaultPrompt : '';
}

/** 默认取数：orchestrator.json 里按**落点项目**解析出的派发提示词（读不到 = 空） */
async function defaultLoadDispatchPrompt(cwd) {
  const state = await readOrchestrator();
  return resolveDispatchPrompt(state, cwd).text;
}

/**
 * 解析一次对话实际要注入的两块提示词。
 *
 * @param {object}   input
 * @param {string}   [input.cwd]    本轮对话的工作目录（决定项目级那条派发提示词生不生效）
 * @param {string}   [input.locale]
 * @param {Function} [input.loadAgentPrompt]   注入口（单测用；生产走 config.json）
 * @param {Function} [input.loadDispatchPrompt] 注入口（同上；生产走 orchestrator.json）
 * @returns {Promise<string>} 拼好的正文，'' = 不注入
 */
export async function resolveChatPromptSection({
  cwd = '',
  locale = 'zh-CN',
  loadAgentPrompt = defaultLoadAgentPrompt,
  loadDispatchPrompt = defaultLoadDispatchPrompt,
} = {}) {
  let gaiPrompt = '';
  let dispatchPrompt = '';
  try {
    gaiPrompt = await loadAgentPrompt();
  } catch (err) {
    logger.warn(`[chatPrompts] 读 g ai 默认提示词失败,本轮跳过: ${err?.message || err}`);
  }
  try {
    dispatchPrompt = await loadDispatchPrompt(cwd);
  } catch (err) {
    logger.warn(`[chatPrompts] 读派发提示词失败,本轮跳过: ${err?.message || err}`);
  }
  return buildChatPromptSection({ gaiPrompt, dispatchPrompt, locale });
}
