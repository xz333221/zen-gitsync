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
// 「会话目录变了」的进程内广播。
//
// 为什么需要它：左栏的会话列表只在**本窗口自己发起的动作**之后刷新（一轮流结束、
// 切项目、定时任务跑完），可会话文件是整机共享的 —— 远端 peer 提问、另一个 g ui
// 窗口、CLI 都会往同一个目录里写。没有这条信号时，用户在另一台机器问完话，回到
// 本机只能靠切项目 / 刷新页面才看得见那条新会话（2026-11-04 用户报的就是这个）。
//
// 为什么用 fs.watch 而不是让 peer 层发事件：写盘方可能根本不在本进程（hub / 项目
// 窗口 / CLI），只有「目录变了」这件事是所有写盘路径的共同事实。也正因为如此，
// 它顺带覆盖了定时任务、外部 CLI、多窗口这些原本各自要单独接线的场景。
//
// 目录里一次保存是 tmp + rename 两步，一轮对话还会中途检查点落盘 —— 必须 debounce，
// 否则前端会被连续几帧「列表变了」打爆。

import fs from 'node:fs';

import { AGENT_SESSIONS_DIR } from '../../../../paths.js';
import logger from '../../utils/logger.js';

/** 合并同一批写入的窗口：一次落盘会产生好几个目录事件。 */
const DEBOUNCE_MS = 500;

const listeners = new Set();
/** @type {fs.FSWatcher|null} */
let watcher = null;
let watchedDir = '';
/** @type {NodeJS.Timeout|null} */
let timer = null;

function publish() {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      logger.warn(`[agent-sessions] 变更通知回调失败: ${err?.message || err}`);
    }
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    publish();
  }, DEBOUNCE_MS);
  timer.unref?.();
}

function stopWatcher() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!watcher) return;
  try { watcher.close(); } catch {}
  watcher = null;
  watchedDir = '';
}

function ensureWatcher(dir) {
  if (watcher && watchedDir === dir) return;
  stopWatcher();
  try {
    // 首次启动时目录可能还没建（一条会话都没跑过）—— 不建就 watch 会 ENOENT。
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, () => schedule());
    // 目录被删 / 权限变化：关掉，等下次有人订阅时重建。留一个死 watcher 只会静默漏事件。
    watcher.on('error', (err) => {
      logger.warn(`[agent-sessions] 目录监听中断: ${err?.message || err}`);
      stopWatcher();
    });
    watchedDir = dir;
  } catch (err) {
    stopWatcher();
    logger.warn(`[agent-sessions] 无法监听会话目录: ${err?.message || err}`);
  }
}

/**
 * 订阅会话目录变更。返回取消订阅函数。
 *
 * 最后一个订阅者离开时关掉 watcher —— 没人看列表的窗口不该常驻一个目录监听。
 *
 * @param {() => void} cb
 * @param {string} [dir] 会话目录（单测注入临时目录，别碰真实数据目录）
 */
export function subscribeAgentSessionChanges(cb, dir = AGENT_SESSIONS_DIR) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  ensureWatcher(dir);
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) stopWatcher();
  };
}

/** 当前是否在监听（排查用）。 */
export function isAgentSessionWatchActive() {
  return !!watcher;
}
