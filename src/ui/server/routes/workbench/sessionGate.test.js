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
// 会话闸的三条边界（都是 2026-11-03「点了停止却没释放」那条 bug 的产物）：
//   · 查与占必须是同一个原子调用 —— 分两步做，并发请求能一起穿过去
//   · 释放要校验 token —— 无主 release 会把别人占着的闸放掉（假释放）
//   · abort 之后宽限期一到就强制放闸 —— 卡在不响应 signal 的 await 上时，
//     这是唯一的自愈路径，否则会话会被堵死到进程重启
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeSessionTurns,
  isSessionBusy,
  getSessionTurn,
  acquireSession,
  acquireSessionTurn,
  releaseSession,
  requestSessionAbort,
} from './sessionGate.js';

test('acquireSessionTurn：第二次占用必须失败（查与占是原子的）', () => {
  const sid = 'gate-atomic';
  const first = acquireSessionTurn(sid);
  assert.ok(first, '第一次应占用成功');
  assert.equal(isSessionBusy(sid), true);

  const second = acquireSessionTurn(sid);
  assert.equal(second, null, '同一会话不能占两次');
  assert.equal(getSessionTurn(sid).token, first.token, '持有者仍是第一次那个轮次');

  releaseSession(sid, first.token);
  assert.equal(isSessionBusy(sid), false);
});

test('releaseSession：token 不匹配时是空操作（防假释放）', () => {
  const sid = 'gate-token';
  const turn = acquireSessionTurn(sid);
  assert.ok(turn);

  // 另一个轮次的收尾不该动得了这一轮
  assert.equal(releaseSession(sid, turn.token + 999), false);
  assert.equal(isSessionBusy(sid), true, '别人的收尾不能把闸放掉');

  assert.equal(releaseSession(sid, turn.token), true);
  assert.equal(isSessionBusy(sid), false);
});

test('acquireSession：旧签名仍返回 boolean（调度器按真假判）', () => {
  const sid = 'gate-legacy';
  assert.equal(acquireSession(sid), true);
  assert.equal(acquireSession(sid), false);
  releaseSession(sid); // 调度器不带 token
  assert.equal(isSessionBusy(sid), false);
});

test('requestSessionAbort：掐断当前轮次，但不立即放闸', () => {
  const sid = 'gate-abort';
  let aborted = 0;
  const turn = acquireSessionTurn(sid, { abort: () => { aborted += 1; } });
  assert.ok(turn);

  const result = requestSessionAbort(sid, { graceMs: 60 });
  assert.equal(result.hit, true);
  assert.equal(aborted, 1, 'abort 通道必须被调用');
  assert.equal(result.released, false, '此刻不能放闸：这一轮还在写快照');
  assert.equal(isSessionBusy(sid), true);

  // 这一轮自己退出（正常路径）：finally 带 token 释放
  releaseSession(sid, turn.token);
  assert.equal(isSessionBusy(sid), false);
});

test('requestSessionAbort：宽限期内没退出 → 标记 abandoned 并强制放闸', async () => {
  const sid = 'gate-orphan';
  const turn = acquireSessionTurn(sid, { abort: () => {} });

  requestSessionAbort(sid, { graceMs: 30 });
  assert.equal(isSessionBusy(sid), true, '宽限期内仍占着');

  await new Promise(r => setTimeout(r, 80));
  assert.equal(isSessionBusy(sid), false, '超时未退必须强制放闸，否则会话永久堵死');
  assert.equal(turn.abandoned, true, '被放弃的轮次收尾时靠这个跳过落盘');
  assert.equal(activeSessionTurns.has(sid), false);
});

test('requestSessionAbort：闸是空的时候直接说自己没命中', () => {
  const result = requestSessionAbort('gate-idle');
  assert.equal(result.hit, false);
  assert.equal(result.released, true);
  assert.equal(result.reason, 'not-busy');
});
