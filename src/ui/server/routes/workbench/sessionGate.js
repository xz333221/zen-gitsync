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
// 「同一会话同一时刻只允许一个生成中的轮次」的共享闸。
//
// 原先这个 Set 内联在 agentRoutes.js 里（对话路由独占）。定时任务落地后
// 多了一个消费方：调度器到点要往专属会话里发消息，必须和手动对话走**同一道闸**
// —— 否则同一个会话会被两条链路同时改写（两个流各自的会话快照互相覆盖，
// 与当初引入这道闸要挡的问题一模一样）。
//
// 拆出来的收益：判定口径只有一份。加第三个消费方（比如未来的工作台）时
// 直接 import 这里，不要各自再抄一个 Set。
//
// 2026-11-03 起多了三件事（都是"点了停止却没释放"那条 bug 的直接产物）：
//   · token：占用时发一个令牌，释放时校验。原先 `release(sessionId)` 无主，
//     任何一轮收尾都能把**别人**占着的闸放掉（假释放），于是两个轮次同跑。
//   · abort 通道：闸里存着这一轮的 abort()，外部（POST /api/agent/abort）能直接
//     掐断它。在此之前唯一的停止信号是 `req.socket` 的 close，走 dev 态的 vite
//     代理时那段事件不一定传得下来，用户点了停止服务端根本不知道。
//   · 宽限兜底：abort 后这一轮若卡在不响应 signal 的 await 上（读配置、跑子进程、
//     取工作区快照），宽限期一到就标记 abandoned 并强制放闸 —— 宁可放弃落盘，
//     也不能让一道内存闸把会话堵死到进程重启。

/** 正在进行中的会话 id 集合（保留原导出，判定口径仍然是它） */
export const activeSessionTurns = new Set();

/** sessionId -> turn（轮次元信息：token / 起始时间 / abort 通道 / 是否被放弃） */
const turns = new Map();
/** sessionId -> 宽限兜底的定时器（release 时清掉，避免重复放） */
const orphanTimers = new Map();

/** 令牌自增源（进程内唯一即可，不需要全局唯一） */
let turnSeq = 0;

/** abort 之后等这一轮自己退出；超时未退就强制放闸 */
export const ABORT_GRACE_MS = 3000;

/** 该会话当前是否有生成中的轮次 */
export function isSessionBusy(sessionId) {
  return activeSessionTurns.has(sessionId);
}

/** 取当前轮次元信息（没有则 null）。给"被占用"时的回话与前端展示用 */
export function getSessionTurn(sessionId) {
  return turns.get(sessionId) || null;
}

/**
 * 尝试占用一个会话并登记轮次。成功返回 turn（含 token）；已被占用返回 null。
 * 注意这是"先查后占"的原子操作 —— 不要自己先 isSessionBusy 再 acquire，
 * 两步之间隔着 await 时会漏。
 *
 * @param {string} sessionId
 * @param {{ abort?: () => void, stage?: string }} [options]
 *        abort：掐断这一轮的唯一通道（通常是该轮 AbortController 的 abort）
 *        stage：当前阶段（给 /api/agent/abort 的回执与前端提示用）
 */
export function acquireSessionTurn(sessionId, options = {}) {
  if (!sessionId || activeSessionTurns.has(sessionId)) return null;
  const turn = {
    token: ++turnSeq,
    startedAt: Date.now(),
    stage: typeof options.stage === 'string' ? options.stage : '',
    abort: typeof options.abort === 'function' ? options.abort : null,
    abandoned: false,
  };
  activeSessionTurns.add(sessionId);
  turns.set(sessionId, turn);
  return turn;
}

/**
 * 旧签名：只要成功与否。调度器用这个（它不关心 token）。
 * 返回值保持 boolean，别改成 turn —— 调用方是按真假判的。
 */
export function acquireSession(sessionId) {
  return acquireSessionTurn(sessionId) !== null;
}

/**
 * 释放（幂等）。
 * @param {string} sessionId
 * @param {number} [token] 传了就校验主人 —— 不匹配说明闸已经被别人（或宽限兜底）
 *                         放过了，这一次释放必须无效，否则会连带放掉新一轮。
 */
export function releaseSession(sessionId, token) {
  const current = turns.get(sessionId);
  if (token !== undefined && current && current.token !== token) return false;
  const timer = orphanTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    orphanTimers.delete(sessionId);
  }
  turns.delete(sessionId);
  activeSessionTurns.delete(sessionId);
  return true;
}

/**
 * 请求中止某个会话当前这一轮。
 *
 * 返回 hit=false 表示当前没有在跑的轮次（闸本来就是空的，前端可以立刻重发）。
 * hit=true 时**不立即释放**：这一轮还在写会话快照，此刻放闸会让新一轮与它并发
 * 写同一份文件。宽限期（默认 3s）内它自己退出就由它的 finally 释放；超时未退
 * 说明卡在不响应 signal 的 await 上 —— 标记 abandoned 并强制放闸，这一轮的
 * 收尾会跳过落盘（见 agentRoutes 里 writeSession 前的判断）。
 */
export function requestSessionAbort(sessionId, options = {}) {
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : ABORT_GRACE_MS;
  const turn = turns.get(sessionId);
  if (!turn) return { hit: false, released: true, reason: 'not-busy' };

  // abort 抛错不该影响回执：这一轮已经注定要被放弃，宽限兜底会接着放闸
  try {
    turn.abort?.();
  } catch {}

  const timer = setTimeout(() => {
    orphanTimers.delete(sessionId);
    const current = turns.get(sessionId);
    if (!current || current.token !== turn.token) return;
    current.abandoned = true;
    turns.delete(sessionId);
    activeSessionTurns.delete(sessionId);
  }, graceMs);
  // 别让一个兜底定时器把进程钉在事件循环里（测试环境尤其明显）
  timer.unref?.();
  orphanTimers.set(sessionId, timer);

  return {
    hit: true,
    released: false,
    graceMs,
    busyMs: Date.now() - turn.startedAt,
    stage: turn.stage,
  };
}
