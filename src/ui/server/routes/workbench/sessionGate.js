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

/** 正在进行中的会话 id 集合 */
export const activeSessionTurns = new Set();

/** 该会话当前是否有生成中的轮次 */
export function isSessionBusy(sessionId) {
  return activeSessionTurns.has(sessionId);
}

/**
 * 尝试占用一个会话。成功返回 true；已被占用返回 false（调用方自行决定跳过/排队）。
 * 注意这是"先查后占"的原子操作 —— 不要自己先 isSessionBusy 再 add，
 * 两步之间隔着 await 时会漏。
 */
export function acquireSession(sessionId) {
  if (activeSessionTurns.has(sessionId)) return false;
  activeSessionTurns.add(sessionId);
  return true;
}

/** 释放（幂等） */
export function releaseSession(sessionId) {
  activeSessionTurns.delete(sessionId);
}
