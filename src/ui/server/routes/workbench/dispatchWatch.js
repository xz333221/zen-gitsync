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
// 「派发任务完成 → 自动唤醒派发它的那条 g ai 会话」。
//
// 背景见 agentRoutes.js 里 dispatch_task 的老文案："跑完会有任务完成提示" ——
// 那条提示只是给**用户**的 UI toast，模型自己一轮结束就"睡着"了：既没有查询
// 工具，也没有任何回调能把"任务跑完了"注回会话。于是每条派发任务的收尾都
// 变成模型对用户说"跑完后提示我一声，我来触发"，人被当成了轮询器。
//
// 这块补齐闭环的三件事：
//   1. register()：派发成功时记下 taskId → 来源会话（agentRoutes 的
//      runDispatchTask onDispatched 回调里调）；
//   2. handleJobUpdate()：job 进终态（taskRunner publish 的 'job:update'，
//      由 agentRoutes 订阅 jobStore 的 bus 转发进来）→ 弹掉监听，往来源会话
//      注入一条系统通知 user 消息并跑完整一轮 runAgentTurn —— 模型读到结果、
//      向用户汇报、继续答应过的后续动作；
//   3. 会话闸被占（用户正在那聊 / 别的轮次在跑）→ 按固定间隔重试，别跟用户抢。
//
// 设计约束：
//   - 一条任务只唤醒一次：注册即消费（终态到达就弹掉监听）。用户之后手动重跑
//     同一条任务，属于用户自己盯着看的活动，不该再往会话里塞通知。
//   - 监听表是**内存态**：g ui 重启期间跑完的任务不会补唤醒（重启后 hydrateJobs
//     会把 running 降级成 error，那一刻会话闸/模型都未必可用，宁缺勿滥）。
//   - 唤醒轮跑 runAgentTurn 的方式与 scheduler.executeTask 同一套（共享闸、
//     无人值守 askUser、落盘会话），不走 HTTP —— 它没有 SSE 观众，前端靠
//     sessions_changed 的目录事件静默重拉看到新消息。

import { logger as defaultLogger, nowIso } from './shared.js';
import { recordTurnTiming } from '../../../../cli/ai/sessionStore.js';

/** 唤醒轮的硬上限：无人值守必须有兜底，比 scheduler 的 60 分钟短 —— 汇报不该比干活久 */
export const WAKE_TURN_MAX_MS = 15 * 60_000;
/** 会话被占时的重试间隔与次数：30s × 40 ≈ 20 分钟 */
export const DEFAULT_RETRY_DELAY_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 40;

const JOB_STATUS_LABELS = {
  done: '执行成功',
  error: '执行出错',
  cancelled: '已被用户取消',
};

/** 毫秒 → 「x分y秒」；不足一分钟只给秒。给唤醒通知里那句"用时"用 */
export function formatDurationMs(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  if (total < 60) return `${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

/**
 * 拼给模型看的唤醒通知（role:'user' 进会话）。
 *
 * 三段缺一不可：发生了什么（任务、状态、用时）、证据（错误信息 / 输出结尾）、
 * 该干什么（汇报、继续后续动作、别重复派发）。少了第三段，模型要么只回一句
 * "好的"，要么把同一件事再派一遍。
 *
 * 输出只给**结尾**：执行输出大头是工具流水，开头几乎一定是环境探测；模型要的
 * "结果长什么样"在最尾部。纯函数，单测覆盖。
 */
export function buildWakeMessage(entry, job, { outputTailChars = 1500 } = {}) {
  const status = String(job?.status || '');
  const label = JOB_STATUS_LABELS[status] || `状态 ${status || '未知'}`;
  const title = String(entry?.taskTitle || job?.taskTitle || '').trim() || '未命名任务';
  const lines = [];

  let head = `【系统通知】你派发的任务「${title}」（taskId=${entry?.taskId || ''}）已执行结束：${label}`;
  const start = Date.parse(job?.startedAt || '');
  const end = Date.parse(job?.endedAt || '');
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    head += `，用时 ${formatDurationMs(end - start)}`;
  }
  lines.push(`${head}。`);

  if (status === 'error' && job?.error) {
    lines.push(`错误信息：${String(job.error).slice(0, 500)}`);
  }
  if (status === 'cancelled') {
    lines.push('这条任务是被用户手动取消的 —— 不要自动重跑，先向用户确认要不要换一种做法。');
  }
  const output = String(job?.output || '').trim();
  if (output) {
    lines.push(`执行输出结尾（截取）：\n${output.slice(-outputTailChars)}`);
  }
  lines.push(
    '请检查上面的结果并向用户简要汇报（结果、关键产出或失败原因）。'
    + '不要为同一件事重复派发任务；如果之前答应过用户后续步骤（验证 / 提交 / 部署等），继续把它们做完；'
    + '需要查其它任务的进度可以用 task_status 工具。'
  );
  return lines.join('\n');
}

/**
 * 建一个派发监听器。依赖全部注入（与 scheduler.createScheduler 同一做法），
 * 本模块不 import jobStore / sessionGate —— 那两条边由装配层（agentRoutes）接。
 *
 * @param {object} deps
 * @param {(id: string) => Promise<object|null>} deps.readSession     agentSessionStore.read
 * @param {(id: string, session: object) => Promise<void>} deps.writeSession
 * @param {(id: string) => object|null} deps.acquireTurn              sessionGate.acquireSessionTurn（null = 被占）
 * @param {(id: string, token?: object) => boolean} deps.releaseTurn  sessionGate.releaseSession
 * @param {Function} deps.runTurn                                     runAgentTurn（测试注入替身）
 * @param {() => Promise<{model:string,name:string,...}>} deps.resolveTurnModel
 * @param {(entry: object) => object|Promise<object>} [deps.buildTurnExtras]
 *        唤醒轮的附加注入（listProjects / dispatchTask / taskStatus / 上下文快照…），
 *        原样展开进 runAgentTurn 的参数。entry 里带 sessionId，链式派发要往**本会话**回挂监听。
 * @param {Function} [deps.findLatestTerminalJob]  注册时补查：派发后任务瞬间终态（spawn 秒败）
 *        时终态事件会抢在 register 前面，靠这个兜住。返回该任务最新的终态 job 或 null。
 * @param {object} [deps.logger]
 * @param {number} [deps.retryDelayMs] [deps.maxRetries]
 */
export function createDispatchWatch({
  readSession,
  writeSession,
  acquireTurn,
  releaseTurn,
  runTurn,
  resolveTurnModel,
  buildTurnExtras,
  logger = defaultLogger,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  findLatestTerminalJob,
} = {}) {
  /** taskId -> { taskId, sessionId, taskTitle, projectPath } */
  const watched = new Map();
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function register(entry = {}) {
    const taskId = String(entry.taskId || '').trim();
    const sessionId = String(entry.sessionId || '').trim();
    if (!taskId || !sessionId) return false;
    if (watched.has(taskId)) return false;
    watched.set(taskId, {
      taskId,
      sessionId,
      taskTitle: String(entry.taskTitle || ''),
      projectPath: String(entry.projectPath || ''),
    });
    // 派发后任务可能瞬间终态（spawn 失败、执行器秒退），终态事件抢在注册前面 ——
    // 注册完补查一次，别把这种最快的"完成"漏成永不汇报。
    if (typeof findLatestTerminalJob === 'function') {
      const existing = findLatestTerminalJob(taskId);
      if (existing) {
        handleJobUpdate(existing).catch(err => {
          logger.warn(`[dispatch-watch] 注册补查唤醒失败(taskId=${taskId}): ${err?.message || err}`);
        });
      }
    }
    return true;
  }

  function isWatched(taskId) {
    return watched.has(String(taskId || '').trim());
  }

  function watchedCount() {
    return watched.size;
  }

  /**
   * job 终态入口。返回值给单测断言：{ handled, woken?, reason?, error? }。
   * 只消费自己认识的 taskId；终态判定由调用方（bus 订阅处）负责。
   */
  async function handleJobUpdate(job) {
    const taskId = String(job?.taskId || '').trim();
    const entry = watched.get(taskId);
    if (!entry) return { handled: false };
    // 注册即消费：后面无论唤醒成败都不再试第二次 —— 失败已在日志里，反复重试
    // 只会在会话里堆出多条"任务完成了"。
    watched.delete(taskId);

    for (let attempt = 0; ; attempt++) {
      const token = acquireTurn(entry.sessionId);
      if (token) {
        try {
          await runWakeTurn(entry, job);
          return { handled: true, woken: true };
        } catch (err) {
          logger.warn(`[dispatch-watch] 唤醒会话失败(${entry.sessionId}, taskId=${taskId}): ${err?.message || err}`);
          return { handled: true, woken: false, reason: 'error', error: String(err?.message || err) };
        } finally {
          releaseTurn(entry.sessionId, token);
        }
      }
      if (attempt >= maxRetries) {
        logger.warn(`[dispatch-watch] 会话持续被占用，放弃唤醒(${entry.sessionId}, taskId=${taskId})`);
        return { handled: true, woken: false, reason: 'busy' };
      }
      await delay(retryDelayMs);
    }
  }

  /**
   * 跑唤醒那一轮。与 scheduler.executeTask 的编排同构：读会话 → 拿默认模型 →
   * 注入通知消息 → runTurn → 记用时 → 落盘。闸的占用在 handleJobUpdate 里做。
   */
  async function runWakeTurn(entry, job) {
    const session = await readSession(entry.sessionId);
    if (!session) throw new Error('来源会话不存在（已被删除？）');
    if (!Array.isArray(session.messages)) session.messages = [];

    // 轮次序号在本轮消息入栈之前取（与 agentRoutes / scheduler 同一口径）
    const turnIndex = session.messages.filter(m => m?.role === 'user').length;
    const model = await resolveTurnModel();
    session.model = `${model.model || ''} (${model.name || ''})`;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      try { abortController.abort(); } catch { /* 已 aborted */ }
    }, WAKE_TURN_MAX_MS);
    const startedAt = Date.now();
    try {
      const extras = typeof buildTurnExtras === 'function'
        ? (await buildTurnExtras(entry) || {})
        : {};
      await runTurn({
        session,
        model,
        userMessage: buildWakeMessage(entry, job),
        cwd: session.cwd || entry.projectPath || '',
        locale: 'zh',
        signal: abortController.signal,
        send: () => {},
        onChild: () => {},
        // 无人值守：唤醒轮没有 SSE 观众在等回答，ask_user 挂起只会白等满 15 分钟
        askUser: async () => '（这是任务完成通知触发的自动汇报，当前没有人在实时回答。）'
          + '请基于已有信息自行判断并继续；如果这一步必须由人决定，跳过它，'
          + '并在最终答复里说明需要用户确认什么。',
        ...extras,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    recordTurnTiming(session, { turnIndex, durationMs: Date.now() - startedAt });
    session.updatedAt = nowIso();
    await writeSession(session.sessionId, session);
  }

  return { register, handleJobUpdate, isWatched, watchedCount };
}
