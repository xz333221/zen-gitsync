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
// 「这一轮执行现在跑到哪了」—— 从执行记录里抽出可读事实的**唯一实现**。
//
// 2026-09-29 从 progressReport.js 拆出来。同一批事实现在有两个消费者：
//   1. 进度报告（progressReport.buildRunningFacts → 喂给主 Agent 写汇报）；
//   2. 看板「进行中」卡片（projectRegistry.decorateTaskForBoard → 直接给人看）。
// 留在 progressReport.js 里会让 projectRegistry 反向依赖报告模块，而报告模块本来就依赖
// projectRegistry（用它的 projectName）—— 拆成独立模块比引一条循环依赖省事得多：
// 这几段文本本来就只跟 job 有关，跟"报告"无关。
//
// 两处口径必须逐字一致：同一件事在报告里写「最近思考：…」、在卡片上换了另一句话，
// 用户看到的是**同一条任务的两个说法**，只会以为自己看错了。

/** 一句话的最大长度（最近思考 / 最近输出都走它） */
export const MAX_LINE_CHARS = 160;
/** 最近一次工具调用的参数摘要长度 */
export const MAX_TOOL_CHARS = 100;
export const MAX_TOOL_NAME_CHARS = 60;
/** 工具名分布串的长度上限（`Bash×14 · Read×5 · Edit`） */
export const MAX_MIX_CHARS = 160;

/** 工具分布只看最近这么多次调用：整轮上千次的话，早先的模式早就被淹没了 */
export const TOOL_MIX_WINDOW = 20;
/**
 * 静默多久才算"值得写进事实"（毫秒）。
 * 低于这个数的"刚刚还在产出"不是事实、只是噪声 —— 写进 prompt 会挤掉有用的话，
 * 显示在卡片上会让每一条都挂个"静默 2 秒"。
 */
export const SILENT_NOTABLE_MS = 60 * 1000;

/** 输出里的最后一行有效文本 —— 模型最近说的一句话，比第一行更能说明"现在在干嘛" */
export function tailLine(output) {
  const text = typeof output === 'string' ? output : '';
  if (!text) return '';
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\s+/g, ' ').trim();
    if (line) return line.slice(0, MAX_LINE_CHARS);
  }
  return '';
}

/**
 * 最近一次工具调用的一句话描述（如 `Edit src/ui/client/src/App.vue`）。
 * 从后往前找：数组里最后一条未必带 name（老数据 / 半截记录），跳过它们而不是返回空。
 */
export function describeLastTool(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const call = list[i];
    if (!call || !call.name) continue;
    const name = String(call.name).slice(0, MAX_TOOL_NAME_CHARS);
    const raw = typeof call.argsPreview === 'string' && call.argsPreview
      ? call.argsPreview
      : (typeof call.arguments === 'string' ? call.arguments : '');
    const args = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_CHARS);
    return args ? `${name} ${args}` : name;
  }
  return '';
}

/**
 * 最近 N 次工具调用的名字分布（`Bash×14 · Read×5`，从多到少）。
 *
 * 为什么需要它：只给"最近一次调用"时，看不出 119 次里有 118 次在干同一件事 ——
 * 于是只能写"无法判断是在改代码还是反复读文件"。名字为空的老记录 / 半截记录跳过，
 * 但不占窗口名额（否则一串空名字会把整段分布挤没）。
 */
export function describeToolMix(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const counts = new Map();
  let seen = 0;
  for (let i = list.length - 1; i >= 0 && seen < TOOL_MIX_WINDOW; i--) {
    const call = list[i];
    if (!call || !call.name) continue;
    seen++;
    const name = String(call.name).slice(0, MAX_TOOL_NAME_CHARS);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  if (!counts.size) return '';
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
    .join(' · ')
    .slice(0, MAX_MIX_CHARS);
}

/**
 * 距最后一次产出（正文 / 思考 / 工具调用）多久。
 * 没有 `lastActivityAt`（老记录、别实例上的旧版进程）或还没到阈值 → null，
 * 调用方据此决定"这条不显示"，而不是显示一个假的 0。
 */
export function silentMsOf(job, now) {
  const last = Date.parse((job && job.lastActivityAt) || '');
  if (!Number.isFinite(last)) return null;
  const ms = Math.max(0, now - last);
  return ms >= SILENT_NOTABLE_MS ? ms : null;
}

/** job 是否算"正在跑"（看板卡片只在此时显示活动摘要） */
export function isLiveJob(job) {
  return !!job && (job.status === 'running' || job.status === 'pending');
}

/**
 * 单条 job → 卡片 / 报告可用的活动摘要。非 running/pending 返回 null（调用方据此不显示）。
 *
 * 时间戳用**毫秒时长**（elapsedMs / silentMs）而不是 ISO：
 * 前端两个视图都拿 formatDurationMs 格式化，跨实例读来的记录也一样能算出时长。
 *
 * @param {object} job  执行记录（内存里的原始对象，或 projectJob 投影）
 * @param {number} now  参照时刻，便于单测
 */
export function buildLiveActivity(job, now = Date.now()) {
  if (!isLiveJob(job)) return null;
  const started = Date.parse(job.startedAt || '');
  return {
    jobId: job.id || '',
    status: job.status,
    /** 本轮执行器（claude | opencode | codex）。老记录没有这个字段 → 空串 */
    agent: typeof job.agent === 'string' ? job.agent : '',
    startedAt: job.startedAt || null,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    /** 见 taskRunner 的 MAX_TOOL_CALLS：超上限的调用不再入数组，所以这是"至少这么多次" */
    toolCallCount: Array.isArray(job.toolCalls) ? job.toolCalls.length : 0,
    lastTool: describeLastTool(job.toolCalls),
    toolMix: describeToolMix(job.toolCalls),
    /** 最近一段思考。多数任务一句正文都不写，它是"它在干嘛"最直接的证据 */
    lastThought: tailLine(job.thinking),
    /** 最新的回复（正文最后一行），空串 = 这轮还没写过正文 */
    lastLine: tailLine(job.output),
    silentMs: silentMsOf(job, now),
  };
}

/** 最近一次产出的时刻，取不到时回落到启动时刻 */
function activityTimestamp(job) {
  return Date.parse(job.lastActivityAt || '') || Date.parse(job.startedAt || '') || 0;
}

/**
 * 一个任务可能同时有好几条 job 在跑（并行的子任务 / 连点两次执行），
 * 卡片只放得下一条 —— 挑**最近有动静的**那条：用户问"现在在干嘛"时，
 * 刚吐过字的那个才是答案，跑得最久的那个未必。
 *
 * 时间戳打平时按原顺序取末条（与 latestJob 同口径）。
 *
 * @returns {object|null} buildLiveActivity 的结果；没有在跑的 job 时 null
 */
export function pickLiveActivity(jobsForTask, now = Date.now()) {
  const list = Array.isArray(jobsForTask) ? jobsForTask : [];
  let best = null;
  let bestAt = -Infinity;
  for (const j of list) {
    if (!isLiveJob(j)) continue;
    const at = activityTimestamp(j);
    if (at >= bestAt) {
      best = j;
      bestAt = at;
    }
  }
  return best ? buildLiveActivity(best, now) : null;
}

export const __testables = {
  tailLine,
  describeLastTool,
  describeToolMix,
  silentMsOf,
  buildLiveActivity,
  pickLiveActivity,
};
