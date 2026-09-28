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
// 「任务结束 → 刷快照」监听器单测。
//
// 守的是四件事：
//   1. 只有**终态**才触发（running/pending 期间疯狂刷快照会把机器拖垮）；
//   2. 同一次结束只刷一次（取消一个任务会先后收到两条 cancelled —— cancel 路由的
//      立即反馈 + 进程退出后 taskRunner 的 finally）；
//   3. 刷新是 **fire-and-forget**：事件处理函数不 await，任务收尾逻辑绝不被拖住；
//   4. 取不到生成器 / 刷新抛错都**不抛给调用方**（任务已经结束了，刷不动快照
//      不该反过来影响任何东西）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createJobSettledRefresher,
  JOB_SETTLED_SECTIONS,
  TERMINAL_JOB_STATUSES,
  SEEN_TERMINAL_LIMIT,
} from './jobRefresh.js';

/** 假快照生成器：记下每次刷新调用，便于断言 */
function fakeSnapshotter({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    refreshSections(sections, opts) {
      calls.push({ sections, opts });
      if (fail) return Promise.reject(new Error('boom'));
      return Promise.resolve({ ok: true });
    },
  };
}

const evt = (status, id = 'j1') => ({ event: 'job:update', payload: { id, status }, ts: 'x' });

/** 等一轮微任务 + 一轮宏任务，让 fire-and-forget 的那条链跑完 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('终态集合：只有 done / cancelled / error 算"执行结束"', () => {
  assert.deepEqual([...TERMINAL_JOB_STATUSES].sort(), ['cancelled', 'done', 'error']);
  assert.equal(TERMINAL_JOB_STATUSES.has('running'), false);
  assert.equal(TERMINAL_JOB_STATUSES.has('pending'), false);
});

test('非终态与无关事件都不触发刷新', () => {
  const snap = fakeSnapshotter();
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap });

  assert.equal(handle(evt('running')), false);
  assert.equal(handle(evt('pending')), false);
  // 别的事件类型（同一总线还跑着 job:output-delta / job:toolcalls / hello …）
  assert.equal(handle({ event: 'job:output-delta', payload: { id: 'j1' } }), false);
  assert.equal(handle({ event: 'hello', payload: {} }), false);
  // 脏数据不该把监听器打挂
  assert.equal(handle(null), false);
  assert.equal(handle({}), false);
  assert.equal(handle({ event: 'job:update' }), false);
  assert.equal(handle({ event: 'job:update', payload: {} }), false);

  assert.equal(snap.calls.length, 0);
});

test('终态触发一次定向 force 刷新，板块清单就是 JOB_SETTLED_SECTIONS', () => {
  const snap = fakeSnapshotter();
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap });

  assert.equal(handle(evt('done')), true);
  assert.equal(snap.calls.length, 1);
  assert.deepEqual(snap.calls[0].sections, JOB_SETTLED_SECTIONS);
  // 必须 force：{ force: true }。不 force 的话 tasks 的 30s TTL 会把它挡回去，
  // 表现就是"任务刚跑完，g ai 还说它在进行中"。
  assert.deepEqual(snap.calls[0].opts, { force: true });
  // 联网那两块必须在清单里，否则任务顺手推上去的仓库不会进快照
  assert.ok(JOB_SETTLED_SECTIONS.includes('tasks'));
  assert.ok(JOB_SETTLED_SECTIONS.includes('git'));
  assert.ok(JOB_SETTLED_SECTIONS.includes('github'));
  assert.ok(JOB_SETTLED_SECTIONS.includes('gitee'));
});

test('同一次结束只刷一次（取消场景的两条 cancelled 只算一条）', () => {
  const snap = fakeSnapshotter();
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap });

  // cancel 路由先推一条立即反馈，进程退出后 taskRunner 的 finally 再推一条
  assert.equal(handle(evt('cancelled')), true);
  assert.equal(handle(evt('cancelled')), false);
  assert.equal(snap.calls.length, 1);

  // 换一个 job 照常触发
  assert.equal(handle(evt('done', 'j2')), true);
  assert.equal(snap.calls.length, 2);

  // 去重键是 `${id}:${status}`：同一 job 的**另一种**终态算新的一次结束。
  // 现实里能凑出的组合只有 cancelled（cancel 路由的立即反馈）→ cancelled（finally），
  // 已经被上面去重掉了；这里只是把键的语义钉住 —— 别哪天有人改成"按 id 去重"
  // 顺手把"同一 job 先后两个终态"的那次刷新吃掉。
  assert.equal(handle(evt('error', 'j1')), true);
  assert.equal(handle(evt('error', 'j1')), false, '同 id 同 status 再来一次不刷');
  assert.equal(snap.calls.length, 3);
});

test('fire-and-forget：事件处理函数不等刷新完成，也不返回 Promise', () => {
  let resolved = false;
  const snap = {
    refreshSections() {
      return new Promise((resolve) => { setTimeout(() => { resolved = true; resolve(); }, 5); });
    },
  };
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap });

  const ret = handle(evt('done'));
  assert.equal(ret, true, '同步返回 true，不是 Promise');
  assert.equal(resolved, false, '此刻刷新还没完成 —— 说明监听器没有 await 它');
});

test('生成器还没建好 / 不可用时不抛，只当没触发', () => {
  for (const getSnapshotter of [
    undefined,
    () => null,
    () => ({}),                                  // 有对象但没有 refreshSections
    () => ({ refreshSections: 'not a function' }),
  ]) {
    const handle = createJobSettledRefresher({ getSnapshotter });
    assert.equal(handle(evt('done')), false);
  }
  // 不传 getSnapshotter 也不该炸
  assert.equal(createJobSettledRefresher({})(evt('done')), false);
});

test('刷新失败走 onError，不产生未处理的 rejection', async () => {
  const seen = [];
  const handle = createJobSettledRefresher({
    getSnapshotter: () => fakeSnapshotter({ fail: true }),
    onError: (err) => seen.push(err.message),
  });

  assert.equal(handle(evt('done')), true);
  await settle();
  assert.deepEqual(seen, ['boom']);

  // onError 自己也抛的话，同样必须被吞掉（日志失败不能反过来搞挂主链路）
  const handle2 = createJobSettledRefresher({
    getSnapshotter: () => fakeSnapshotter({ fail: true }),
    onError: () => { throw new Error('日志也挂了'); },
  });
  assert.equal(handle2(evt('done')), true);
  await settle();

  // 不传 onError 时静默 —— 但也不能崩
  const handle3 = createJobSettledRefresher({ getSnapshotter: () => fakeSnapshotter({ fail: true }) });
  assert.equal(handle3(evt('done')), true);
  await settle();
});

test('去重集合有上限：长跑服务里不会无限膨胀', () => {
  const snap = fakeSnapshotter();
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap });

  for (let i = 0; i < SEEN_TERMINAL_LIMIT + 50; i += 1) {
    handle({ event: 'job:update', payload: { id: `j${i}`, status: 'done' } });
  }
  assert.equal(snap.calls.length, SEEN_TERMINAL_LIMIT + 50, '每一次都该刷（只是去重表有上限）');

  // 最旧的那条已经被淘汰 → 再来一次会被当成新的。
  // 这是**有意的取舍**：去重表不该为了"永远记得"而无限长，
  // 而重放一条几百次之前结束的 job 事件在现实中不会发生。
  assert.equal(handle({ event: 'job:update', payload: { id: 'j0', status: 'done' } }), true);
  // 但最近的仍然记得
  assert.equal(handle({ event: 'job:update', payload: { id: `j${SEEN_TERMINAL_LIMIT + 49}`, status: 'done' } }), false);
});

test('sections 可覆盖（调用方想刷别的板块时）', () => {
  const snap = fakeSnapshotter();
  const handle = createJobSettledRefresher({ getSnapshotter: () => snap, sections: ['tasks'] });
  handle(evt('done'));
  assert.deepEqual(snap.calls[0].sections, ['tasks']);
});
