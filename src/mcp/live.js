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
// 「找到一个正在跑的 g ui」+ 通过它做 MCP 自己做不到的事。
//
// 为什么需要这一层:绝大多数板块的数据是**文件即真相**(tasks.json / jobs.json /
// agent-sessions/…),MCP 服务端直读即可,不需要任何进程在跑。但有三类不行:
//   1. 派发任务 —— 建任务 + 起执行器的逻辑在 GUI 侧(dispatchInstruction.js)
//   2. 让 g ai 跑一轮 —— 真正跑对话的是 GUI 的 runAgentTurn
//   3. 运行中 job 的完整输出 —— live-jobs/ 里的是截尾快照
// 这三类统一走"发现实例 → 转发 HTTP"。
//
// 端口发现为什么不写死:g ui 的端口是**随机**的(utils/randomStartPort.js 从
// 4000-6000 里挑,占用就顺延),只有 PORT 环境变量显式指定时才固定。
// 唯一可靠的来源是实例注册表 ~/.zen-gitsync/instances/<pid>.json,里面有 port。
// 心跳 stale 阈值 30s,与 instanceRegistry.js 一致;额外再用 pid 探活兜一层,
// 因为进程被强杀时心跳文件会留在盘上(本机实测一堆 .tmp 残留就是这么来的)。
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { INSTANCES_DIR, INSTANCE_STALE_MS } from './paths.js';
import { canonicalProjectPath, isPidAlive, listDataFiles, readJsonFile } from './util.js';

/**
 * 列出当前活着的 g ui 实例(心跳新鲜 + pid 存活)。
 * @returns {Promise<Array<{ pid:number, port:number, projectName:string, projectPath:string,
 *                           startedAt:number, lastHeartbeat:number, age:number, url:string }>>}
 */
export async function listLiveInstances({ maxAgeMs = INSTANCE_STALE_MS } = {}) {
  const files = await listDataFiles(INSTANCES_DIR);
  const now = Date.now();
  const out = [];
  for (const file of files) {
    const entry = await readJsonFile(file, null);
    if (!entry || typeof entry !== 'object') continue;
    const pid = Number(entry.pid);
    const port = Number(entry.port);
    if (!Number.isInteger(pid) || !Number.isInteger(port) || port <= 0) continue;
    const heartbeat = Number(entry.lastHeartbeat) || 0;
    const age = now - heartbeat;
    // 心跳过期 **或** 进程已死 → 视为残留文件(不删,删文件不是 MCP 该干的事)
    if (maxAgeMs > 0 && age > maxAgeMs) continue;
    if (!isPidAlive(pid)) continue;
    out.push({
      pid,
      port,
      projectName: entry.projectName || '',
      projectPath: entry.projectPath || '',
      startedAt: Number(entry.startedAt) || 0,
      lastHeartbeat: heartbeat,
      age,
      url: `http://127.0.0.1:${port}`,
    });
  }
  out.sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
  return out;
}

/**
 * 挑一个实例:优先项目路径与 cwd 匹配的,否则取心跳最新的。
 * @returns {Promise<object|null>}
 */
export async function findLiveInstance({ cwd } = {}) {
  const instances = await listLiveInstances();
  if (instances.length === 0) return null;
  const want = canonicalProjectPath(cwd);
  if (want) {
    const hit = instances.find(i => canonicalProjectPath(i.projectPath) === want);
    if (hit) return hit;
  }
  return instances[0];
}

/** 统一的"没有活实例"提示。写清楚该怎么办,别让模型瞎猜。 */
export const NO_LIVE_INSTANCE_HINT =
  '这不是错误,是当前状态:这个能力需要 g ui 正在运行(它持有执行器与调度器)。'
  + '请让用户在目标目录下跑 `g ui`(或 `npm run dev`)后再试。'
  + '⚠️ 不要重试这个工具,也不要向用户承诺"已经派发出去了"。';

/**
 * 向一个活实例发一个 JSON 请求。
 * 不走 fetch 的默认代理设置 —— 目标是 127.0.0.1,代理会把它当外部地址。
 *
 * @param {string} baseUrl - 形如 http://127.0.0.1:4468
 * @param {string} apiPath - 形如 /api/workbench/tasks
 * @param {{ method?: string, body?: object, timeoutMs?: number }} [options]
 */
export async function liveFetch(baseUrl, apiPath, { method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(apiPath, baseUrl), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    try { payload = text.trim() ? JSON.parse(text) : null } catch { /* 非 JSON,原样带回 */ }
    return { ok: res.ok, status: res.status, payload, text };
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? `请求超时(${Math.round(timeoutMs / 1000)}s)`
      : (err?.message || String(err));
    return { ok: false, status: 0, payload: null, text: '', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 消费一个 SSE 端点,把事件逐条交给 onEvent,直到 done 或超时。
 *
 * ⚠️ 必须用流式 reader,不能 `await res.text()` —— /api/agent/chat 的流在 done 之后
 * 不一定立刻关闭(服务端还挂着心跳),等整条流读完会一路挂到超时。
 * 拿到 done 事件立刻 cancel,与 src/cli/ai/mcp.js 的 #readSseResult 同一个理由。
 *
 * @param {string} baseUrl
 * @param {string} apiPath
 * @param {{ method?: string, body?: object, timeoutMs?: number,
 *           onEvent: (payload: object) => boolean|void, signal?: AbortSignal }} options
 *   onEvent 返回 false 表示"够了,停"
 * @returns {Promise<{ ok:boolean, error?:string, events:number }>}
 */
export async function liveSse(baseUrl, apiPath, { method = 'POST', body, timeoutMs = 180_000, onEvent } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let events = 0;
  try {
    const res = await fetch(new URL(apiPath, baseUrl), {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, events };
    }
    const reader = res.body?.getReader?.();
    if (!reader) return { ok: false, error: '响应没有可读流', events };

    const decoder = new TextDecoder();
    let buffer = '';
    let stop = false;
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while (!stop && (index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        const payload = parseSseFrame(frame);
        if (!payload) continue;
        events += 1;
        if (onEvent(payload) === false) stop = true;
      }
    }
    return { ok: true, events };
  } catch (err) {
    const reason = err?.name === 'AbortError'
      ? `等待超时(${Math.round(timeoutMs / 1000)}s)`
      : (err?.message || String(err));
    return { ok: false, error: reason, events };
  } finally {
    clearTimeout(timer);
  }
}

/** SSE 帧 → 解析后的对象。只认 data: 行(event:/id:/注释一律忽略)。 */
function parseSseFrame(frame) {
  const data = frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data.trim()) return null;
  try { return JSON.parse(data) } catch { return null }
}

/**
 * 拿"完整的" job 表,按能力从强到弱降级。
 *
 * 三条路线,真相度依次降低 —— 区别不是"能不能拿到列表",而是**输出的完整度**:
 *   1. 本进程内存(HTTP 入口,g ui 内部)—— 完整输出,且不用 parse 37MB 的 jobs.json
 *   2. 转发活实例的 /api/workbench/jobs/list —— 也是完整的,代价是一次 HTTP
 *   3. null —— 调用方退回读盘:live-jobs 是截尾的,jobs.json 是终态的
 *
 * @param {object} ctx - MCP ctx(可能带 getLiveJobs)
 * @returns {Promise<{ jobs: object[], source: 'process'|'live', complete: true, from?: string }|null>}
 */
export async function resolveJobs(ctx) {
  // 路线 1:本进程内存(挂在 g ui 上时才有)
  if (typeof ctx?.getLiveJobs === 'function') {
    try {
      const jobs = await ctx.getLiveJobs();
      if (Array.isArray(jobs)) {
        return { jobs, source: 'process', complete: true };
      }
    } catch (err) {
      // 内存态拿不到不是致命问题 —— 让调用方退回读盘,别把请求打挂
      void err;
    }
  }

  // 路线 2:转发给活着的 g ui
  const instance = await findLiveInstance({ cwd: ctx?.cwd });
  if (instance) {
    const res = await liveFetch(
      instance.url,
      '/api/workbench/jobs/list?limit=200',
      { timeoutMs: 30_000 },
    );
    if (res.ok && Array.isArray(res.payload?.jobs)) {
      return { jobs: res.payload.jobs, source: 'live', complete: true, from: describeInstance(instance) };
    }
    void res.error;
  }

  return null;
}

/** 兼容性小工具:实例信息 → 一句话描述(给工具结果里标注数据来源用)。 */
export function describeInstance(instance) {
  if (!instance) return '';
  return `pid ${instance.pid} · 端口 ${instance.port} · ${instance.projectName || instance.projectPath || '未知项目'}`;
}

/** 目录是否存在(用于 mindmap 这类"用户自选目录"的入参校验)。 */
export async function dirExists(dir) {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export { path };
