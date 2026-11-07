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
// 工具调用的"最迟什么时候回来"兜底。
//
// ── 要解决的问题（2026-11-07 实测） ────────────────────────────────────
// 一轮对话停在 `run_command` 上 **29 分 25 秒**：服务端的会话闸被占死（
// `POST /api/agent/abort` 读回 `busyMs: 1765441`），SSE 再没吐过一个字节，
// 前端的「停止」按了也没用 —— 因为这一轮的 await 谁都不理：
//   · 不是子进程没退（进程表里连 cmd.exe / more.com 都没有）
//   · 不是等模型（hub 进程没有任何对外连接）
//   · 各自的超时都没生效（run_command 120s、模型请求有 idle 超时）
// 结果是 finally 永远不跑：既不落盘，也不 res.end()，界面只能永远显示"生成中"。
//
// ── 为什么必须在工具外面再包一层 ──────────────────────────────────────
// `execCommand` 的超时只保证"子进程被杀掉"，保证不了"这个 Promise 一定落地"：
// 它前后还挂着 augmentEnvPath（读注册表）、platformGuard（where 探测）、
// registerProject（登记常用目录）这些 await —— 任何一个卡住，工具就没有返回值，
// 而它们一个都没有超时。工具层自己数不完的截止时间，只能在调用侧统一兜。
//
// ── 为什么不干脆给整轮挂一个总超时 ────────────────────────────────────
// 会因为一次合法的长命令（`npm install` 上限 600s）把整轮判死。这里的预算按
// **每个工具自己的上限**推出来（见 toolGuardMs），加一次余量，所以正常命令
// 永远走不到兜底那一步 —— 走到就说明它不是"慢"，是"回不来"。

import { resolveCommandTimeout } from '../../../../cli/ai/tools.js';

/** 兜底判定的余量：工具自己报超时 → 收尾 → 回喂，这段总要点时间 */
export const TOOL_GUARD_MARGIN_MS = 30 * 1000;

/**
 * 没有自己超时的工具的固定上限。
 *
 * 150s 的依据：MCP 调用自带 120s（mcp.js CALL_TIMEOUT_MS），读写文件/搜索/列目录
 * 都是本地毫秒级，给到 150s 已经是"连同 GC 和慢盘一起算进去"还绰绰有余的数。
 */
export const TOOL_GUARD_DEFAULT_MS = 150 * 1000;

/** background_task 的 read 最长可以带 wait_seconds=60，再留一分钟收尾 */
export const BG_WAIT_MAX_MS = 60 * 1000;
export const BG_GUARD_EXTRA_MS = 60 * 1000;

/** 兜底触发时抛出的错误码 —— 调用方靠它区分"卡住"与"工具自己报的错" */
export const TOOL_STALLED = 'TOOL_STALLED';

/**
 * 这个工具该给多久。
 *
 * 返回 `null` 表示**不设上限**：`ask_user` 是在等用户点选项，等到天荒地老都是
 * 正常行为，给它加超时等于把"等你回话"判成卡死。
 *
 * @param {string} name 工具名
 * @param {object} [args] 模型给的参数
 * @returns {number|null} 毫秒上限
 */
export function toolGuardMs(name, args = {}) {
  if (name === 'ask_user') return null;

  if (name === 'run_command') {
    const command = typeof args?.command === 'string' ? args.command : '';
    // 与 toolRunCommand 里同一个解析口径：模型给的值会被抬到上限（最长 600s），
    // 所以这里拿到的就是那条命令真正的执行预算。
    const seconds = resolveCommandTimeout(command, args?.timeout_seconds);
    return seconds * 1000 + TOOL_GUARD_MARGIN_MS;
  }

  if (name === 'background_task') {
    const wait = Number(args?.wait_seconds);
    const waitMs = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 60) * 1000 : 0;
    return waitMs + BG_WAIT_MAX_MS + BG_GUARD_EXTRA_MS;
  }

  return TOOL_GUARD_DEFAULT_MS;
}

/**
 * 跑一个工具，超时就把等待放弃掉。
 *
 * 注意语义：**放弃等待，不是杀进程**。真正跑着的东西由它自己的超时收尾
 * （execCommand 会 taskkill /T），这里只是不让"永远不落地"把整轮对话一起拖死。
 * 被放弃的那个 Promise 仍会继续跑完 —— 它后续的 then 已经挂在下面，不会变成
 * unhandledRejection。
 *
 * @template T
 * @param {() => Promise<T>} run 真正要跑的东西（用函数包起来，避免提前求值）
 * @param {number} ms 上限
 * @returns {Promise<T>}
 */
export function runWithToolGuard(run, ms) {
  if (!(ms > 0)) return run();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`工具 ${Math.round(ms / 1000)} 秒内没有返回`);
      err.code = TOOL_STALLED;
      err.timeoutMs = ms;
      reject(err);
    }, ms);
    // 这里**故意不 unref**：别的收尾定时器都可以让路，唯独这个不能 —— 它的全部
    // 职责就是到点开火，unref 之后事件循环一空它就永远不来，兜底等于没有
    // （单测里会直接表现为"Promise resolution is still pending"）。上限最长
    // 一段是 600s+余量，钉不死进程。

    run().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export default { toolGuardMs, runWithToolGuard, TOOL_STALLED };
