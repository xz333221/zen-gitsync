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
// Web 端（g ui 服务端）的扩展层（Skill 清单 + MCP 工具）加载缓存。
//
// 背景：AgentExtensions.load 原先只有 CLI 的 `g ai` 调（agent.js 启动时一次），
// 而 Web 智能体面板的 runAgentTurn 与定时任务的执行体共用同一个函数却不加载
// 扩展 —— 表现就是「MCP 广场显示已安装，对话框里就是没有那些工具」
// （2026-10-12 用户实测：agent 只能自己读 mcp.json 按 HTTP 协议直调）。
// 这个模块把同一份加载逻辑接到 Web 侧，并按 cwd 做进程内缓存。
//
// 为什么按 cwd 缓存而不是每轮加载：
//   - MCP 握手不便宜：stdio 要起子进程（npx 首次还要下载包，实测 20s+），
//     HTTP 也要 initialize + tools/list 两个往返。每轮都付一次的话，
//     装了两三个 MCP 的用户每轮对话都要先等好几秒。
//   - CLI 的口径是「进程启动时加载一次，/cwd 切换时重载」。Web 没有进程重启
//     这个自然边界，用缓存等价实现：同一 cwd 只加载一次，配置变化靠失效。
//
// 缓存什么时候失效：
//   - 广场安装/卸载（agentMarketplace.js 调 invalidateWebExtensions）——
//     不接这一路的话，刚装的 MCP 要等 g gui 重启才在对话里生效；
//   - 手动编辑 ~/.zen-gitsync/ai/mcp.json（不走广场的那种）—— 下次 g gui
//     重启生效，与 CLI「下次启动时生效」一致。
//
// 生命周期：stdio 子进程走 cli/cleanup.js 的 trackChild，不在 g ui 自己的
// runningProcesses 表里，shutdown 的 drainRunningProcesses 兜不到 —— 所以
// index.js 的优雅退出里显式调 closeWebExtensions()，否则 Ctrl+C 之后会留下
// 一堆 npx 孤儿子进程。

import path from 'node:path';
import { AgentExtensions } from '../../../../cli/ai/extensions.js';
import { logger } from './shared.js';

/** cwd(绝对路径) → { extensions: AgentExtensions } */
const cache = new Map();
/** cwd → 进行中的加载。同 cwd 的并发首轮只允许一次真实加载（去重）。 */
const inflight = new Map();
/**
 * 加载期间被 invalidate 标记过的 cwd。任务收尾时看到自己在这张表里 →
 * 不写回缓存、直接关掉刚建好的连接，只服务当前这一个调用方。
 *
 * 为什么需要它：不能改用"cache 里没有这个 key"来判断 —— 首次加载时缓存
 * 本来就是空的，两种状态长得一模一样。2026-10-12 第一版就是这么写的，
 * 后果是每次首轮加载完都把刚握好的 MCP 连接关掉（还不进缓存），
 * 症状是"工具定义下发成功了、一调用就报连接已关闭"。
 */
const poisoned = new Set();

const normalizeCwd = (cwd) => {
  try {
    return path.resolve(cwd || process.cwd());
  } catch {
    return String(cwd || process.cwd());
  }
};

/**
 * 取某个 cwd 的扩展层；没有则加载（同 cwd 并发只加载一次）。
 *
 * 失败不抛：AgentExtensions.load 内部已对 skill / MCP 各自降级，这里再包一层
 * 是防读取路径之外的意外把整轮对话打挂 —— 扩展是增量能力，不该让用户消息发不出去。
 *
 * @param {{ cwd?: string, locale?: string }} [options]
 * @returns {Promise<AgentExtensions>}
 */
export async function getWebExtensions({ cwd, locale } = {}) {
  const key = normalizeCwd(cwd);
  const hit = cache.get(key);
  if (hit) return hit.extensions;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const extensions = await AgentExtensions.load({
      cwd: key,
      locale,
      onWarn: (message) => logger.warn(`[agentExtensions] ${message}`),
    }).catch((err) => {
      logger.warn(`[agentExtensions] 加载失败(${key})，本轮按无扩展继续: ${err?.message || err}`);
      return new AgentExtensions();
    });
    // 加载期间被 invalidate 过 → 不把这份刚建好的连接写回缓存（下一个调用方
    // 会按新配置重新加载），直接关掉它，只服务当前这一个调用方。
    // has → delete → set 之间没有 await，整段是原子的，不会被 invalidate 插进来。
    if (poisoned.has(key)) {
      poisoned.delete(key);
      await extensions.mcp?.close().catch(() => {});
    } else {
      cache.set(key, { extensions });
    }
    return extensions;
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 让扩展缓存失效（广场安装 / 卸载后调）。
 *
 * 先摘缓存再关旧连接 —— 反过来会让下一轮拿到正在关闭的连接。
 * 传 cwd 只失效那一个目录（项目级安装），不传失效全部（全局安装影响所有目录）。
 *
 * @param {string} [cwd]
 */
export async function invalidateWebExtensions(cwd) {
  // 受影响对象 = 缓存键 + 在途加载键。只遍历缓存的话，"加载前刚被失效过
  // （缓存已空）、又在加载中被失效"这一下会漏掉在途那个，让它把按旧配置
  // 建好的连接写回缓存。
  const keys = cwd ? [normalizeCwd(cwd)] : [...new Set([...cache.keys(), ...inflight.keys()])];
  const victims = [];
  for (const key of keys) {
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      victims.push(entry.extensions);
    }
    // 有加载在进行中 → 标记它收尾时别写回缓存（见 getWebExtensions 里的 poisonous 分支）
    if (inflight.has(key)) poisoned.add(key);
  }
  await Promise.all(victims.map(async (extensions) => {
    // 正在跑的某一轮可能还持有这份对象：它的 in-flight tools/call 会收到
    // "连接已关闭"（以错误字符串回喂给模型，不会打挂对话）。装/卸配置与对话
    // 并发是罕见边角，为它做代际管理不值这个复杂度。
    try {
      await extensions.mcp?.close();
    } catch (err) {
      logger.warn(`[agentExtensions] 关闭旧连接失败: ${err?.message || err}`);
    }
  }));
}

/**
 * 关掉全部缓存的 MCP 连接。g gui 优雅退出时调（见 index.js 的 shutdown）。
 */
export async function closeWebExtensions() {
  const all = [...cache.values()];
  cache.clear();
  await Promise.all(all.map(async ({ extensions }) => {
    try { await extensions.mcp?.close(); } catch (_) {}
  }));
}
