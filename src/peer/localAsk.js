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
// 让"本机的 g ai 跑一轮"—— 供 peer 服务端（远端提问）使用。
//
// 为什么走本机 HTTP 而不是直接调 runAgentTurn：
//   · runAgentTurn 需要 session / model / send / askUser / 各种 ctx 注入，这些
//     脚手架全在 /api/agent/chat 这个路由里，重写一遍必然和它对不上口径
//     （工具集合、上下文注入、请求预算、引擎选择都会分叉）；
//   · 这台机器上"能跑 g ai"的唯一权威入口就是那个路由，环回打它等于复用全部行为。
// 代价是多一跳 localhost HTTP（几十微秒），换来零分叉。
//
// 走环回的请求**没有 Origin 头**，createOriginChecker() 对这种请求是放行的
// （见 middleware/originGuard.js 的头一段注释），所以不会被自己的同源守卫挡掉。

import logger from '../ui/server/utils/logger.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 让本机 g ai 回答一个问题。
 *
 * @param {object} opts
 * @param {number} opts.port 本机 g ui 的端口（环回调用）
 * @param {string} opts.question 提问正文
 * @param {string} [opts.sessionId] 续聊用的会话 id；空 = 新会话
 * @param {string} [opts.locale] 'zh' | 'en'
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal] 上游取消（提问方断开 / 本机 peer 请求被中止）。
 *        它必须打到环回那次 /api/agent/chat 上 —— 那个路由靠 socket close 才知道
 *        "这一轮没人要了"，从而中止并释放会话闸。不接这条线，对端的轮次会继续跑到
 *        底，期间任何新提问都回 SESSION_BUSY。
 * @param {(text:string)=>void} [opts.onDelta] 正文增量回调（可选，供日志/调试）
 * @returns {Promise<{answer:string, sessionId:string, ms:number}>}
 */
export async function askLocalAgent({
  port,
  question,
  sessionId = '',
  locale = 'zh',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  onDelta
} = {}) {
  const text = String(question || '').trim();
  if (!text) throw new Error('问题不能为空');
  if (!port) throw new Error('本机端口不可用');

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onUpstreamAbort = () => { try { controller.abort(); } catch {} };
  if (signal?.aborted) onUpstreamAbort();
  else signal?.addEventListener?.('abort', onUpstreamAbort, { once: true });
  const stop = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onUpstreamAbort);
  };

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/agent/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify({
        userMessage: text,
        sessionId: sessionId || undefined,
        locale,
        // 标记这次提问来自另一台机器：会话要有 source=peer、且不归属任何项目
        // （见 agentRoutes 的 peerAsk —— 远端提问在这台机器上没有被选过项目，
        // 挂在某个项目下会让本机用户在别的项目里一直看不到它）。
        peer: true
      }),
      signal: controller.signal
    });
  } catch (err) {
    stop();
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw new Error('提问方已断开，本轮已取消');
      throw new Error(`本机智能体超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new Error(`连不上本机 g ui（127.0.0.1:${port}）：${err?.message || err}`);
  }

  if (!res.ok || !res.body) {
    stop();
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch {}
    throw new Error(`本机智能体返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  let answer = '';
  let newSessionId = sessionId || '';
  let failure = '';
  let buf = '';

  try {
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      // SSE 事件以空行分隔；一条事件里可能有多行 data:
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.type === 'meta' && evt.sessionId) newSessionId = evt.sessionId;
          else if (evt.type === 'content' && typeof evt.delta === 'string') {
            answer += evt.delta;
            try { onDelta?.(evt.delta); } catch {}
          } else if (evt.type === 'done') {
            // done 带的是**完整正文**，比逐段拼接更权威（重试时前面那截会被回退）
            if (typeof evt.content === 'string') answer = evt.content;
          } else if (evt.type === 'error') {
            failure = String(evt.error || '未知错误');
          }
        }
      }
    }
  } catch (err) {
    stop();
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw new Error('提问方已断开，本轮已取消');
      throw new Error(`本机智能体超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new Error(`读取本机智能体输出失败：${err?.message || err}`);
  }
  stop();

  if (failure) throw new Error(`本机智能体报错：${failure}`);
  if (!answer.trim()) {
    logger.warn('[peer] 本机智能体返回了空正文（可能是工具轮次结束或模型空答）');
  }
  return { answer: answer.trim(), sessionId: newSessionId, ms: Date.now() - startedAt };
}
