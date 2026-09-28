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
// 「工作台任务执行结束」→ 定向刷新快照。
//
// 为什么需要这个触发点：任务跑完是**状态真的变了**的时刻 —— 任务从"进行中"变"已完成"、
// 它自己的仓库多了一条提交。而用户下一刻很可能就切到智能体页问"刚才那个任务怎么样了"。
// 没有这个触发点，那次提问拿到的还是最多 30s 前的快照（tasks 的 TTL），
// 表现为"任务明明跑完了，g ai 却说还在进行中"。
//
// 为什么挂在 jobStore 的事件总线上，而不是往 taskRunner 里塞一个 hook：
// 终态是 taskRunner 在 finally 里 publish('job:update') 推出来的，而 workbench/index.js
// 本来就在消费同一条总线（SSE 广播）。多挂一个监听，比往 1000+ 行的热模块里加一个
// setter + 一处 await 要干净得多。
//
// 为什么可以"激进地 force"：四个板块里 github / gitee 要联网，但它们各自有
// forceTtlMs(60s) 地板 —— 「连续跑 20 个任务」最多每分钟真拉一次。这正是地板机制
// 存在的意义（见 aiContext/index.js 头注释第 2 条）。
//
// 本模块保持**零依赖纯逻辑**：快照生成器从外面传进来，单测不用碰真实快照。

/** job 的终态 —— 只有这三个才算"执行结束了"。running / pending 都要忽略。 */
export const TERMINAL_JOB_STATUSES = new Set(['done', 'cancelled', 'error']);

/**
 * 任务结束后要刷的板块。
 *
 * 一个任务跑完，直接受影响的是两件事：看板状态（tasks）与它自己那个仓库的工作区（git）；
 * 顺手建仓 / 推远端则落到 github / gitee。四块都刷，由各自的 forceTtlMs 兜住频率。
 */
export const JOB_SETTLED_SECTIONS = ['tasks', 'git', 'github', 'gitee'];

/**
 * 去重集合的上限。
 *
 * 取消一个任务会先收到一条"立即反馈"（workbench/index.js 的 cancel 路由，status=cancelled），
 * 随后 child 真正退出、taskRunner 的 finally 又推一条同状态 —— 不去重就是白刷一次。
 * 键用 `${id}:${status}`，正常任务只会命中一次；集合按插入序淘汰，防止长跑服务里无限膨胀。
 */
export const SEEN_TERMINAL_LIMIT = 1000;

/**
 * 建一个「任务结束 → 刷快照」的监听器。
 *
 * @param {object}   deps
 * @param {Function} deps.getSnapshotter  () => snapshotter|null（延迟取值：注册时它可能还没建好）
 * @param {string[]} [deps.sections]      要刷的板块，默认 JOB_SETTLED_SECTIONS
 * @param {Function} [deps.onError]       刷新失败时回调（默认吞掉 —— 刷不动快照不该影响任务本身）
 * @returns {(evt: object) => boolean}    事件处理函数；返回 true 表示本次真的触发了刷新
 */
export function createJobSettledRefresher({
  getSnapshotter,
  sections = JOB_SETTLED_SECTIONS,
  onError,
} = {}) {
  const seen = new Set();

  function remember(key) {
    seen.add(key);
    // Set 保插入序 → 第一个就是最旧的
    while (seen.size > SEEN_TERMINAL_LIMIT) {
      seen.delete(seen.values().next().value);
    }
  }

  function reportError(err) {
    try { onError?.(err); } catch { /* 日志失败不能搞挂主链路 */ }
  }

  return function handleEvent(evt) {
    if (!evt || evt.event !== 'job:update') return false;
    const job = evt.payload;
    if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return false;

    const key = `${job.id || ''}:${job.status}`;
    if (seen.has(key)) return false;
    remember(key);

    const snapshotter = typeof getSnapshotter === 'function' ? getSnapshotter() : null;
    if (!snapshotter || typeof snapshotter.refreshSections !== 'function') return false;

    // fire-and-forget：任务已经结束了，这次刷新只服务于"下一次提问"，
    // 绝不能反过来让路由层或者任务收尾逻辑等它（联网板块可能要几秒）。
    //
    // 直接调用、**只对返回的 Promise 挂 catch** —— 不用 `Promise.resolve().then(...)`
    // 把调用本身推迟一个微任务：那样"刷新到底有没有启动"在事件处理函数返回时就看不出来，
    // 排错时非常别扭（单测也只能靠 sleep 猜）。这里要的是"立刻启动、不等待、不冒泡"。
    let pending;
    try {
      pending = snapshotter.refreshSections(sections, { force: true });
    } catch (err) {
      // 实现里同步抛（而不是返回 rejected Promise）也要吞掉
      reportError(err);
      return true;
    }
    Promise.resolve(pending).catch(reportError);
    return true;
  };
}
