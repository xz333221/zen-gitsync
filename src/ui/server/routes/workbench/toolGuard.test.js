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

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolGuardMs,
  runWithToolGuard,
  TOOL_STALLED,
  TOOL_GUARD_MARGIN_MS,
  TOOL_GUARD_DEFAULT_MS,
} from './toolGuard.js';

// ========== 预算:按各工具自己的上限推,不搞一刀切 ==========

test('toolGuardMs: ask_user 不设上限(等用户点选项,等多久都正常)', () => {
  assert.equal(toolGuardMs('ask_user', {}), null);
});

test('toolGuardMs: run_command 用命令自己的超时 + 余量', () => {
  assert.equal(toolGuardMs('run_command', { command: 'git status' }), 120 * 1000 + TOOL_GUARD_MARGIN_MS);
  // 模型给一个更小的值:按它给的值算(它明确想快速失败)
  assert.equal(toolGuardMs('run_command', { command: 'git status', timeout_seconds: 10 }), 10 * 1000 + TOOL_GUARD_MARGIN_MS);
});

test('toolGuardMs: 长耗时命令按上限 600s 算,别把 npm install 判成卡死', () => {
  assert.equal(toolGuardMs('run_command', { command: 'npm install', timeout_seconds: 30 }), 600 * 1000 + TOOL_GUARD_MARGIN_MS);
});

test('toolGuardMs: background_task 要容下 wait_seconds 再留收尾', () => {
  assert.equal(toolGuardMs('background_task', { action: 'read', wait_seconds: 30 }), 30 * 1000 + 120 * 1000);
  // wait_seconds 超过上限(60)时按 60 算
  assert.equal(toolGuardMs('background_task', { action: 'read', wait_seconds: 600 }), 60 * 1000 + 120 * 1000);
});

test('toolGuardMs: 其余工具走固定上限', () => {
  assert.equal(toolGuardMs('read_file', { path: 'a.txt' }), TOOL_GUARD_DEFAULT_MS);
  assert.equal(toolGuardMs('mcp__foo__bar', {}), TOOL_GUARD_DEFAULT_MS);
});

// ========== 兜底本身:不吞正常结果、不吞工具自己的错、超时才判卡死 ==========

test('runWithToolGuard: 正常返回的值原样透传', async () => {
  const r = await runWithToolGuard(async () => 'ok', 200);
  assert.equal(r, 'ok');
});

test('runWithToolGuard: 工具自己抛的错原样抛出,不被当成卡死', async () => {
  const boom = new Error('工具内部报错');
  await assert.rejects(
    () => runWithToolGuard(async () => { throw boom }, 200),
    (err) => {
      assert.equal(err, boom);
      assert.notEqual(err.code, TOOL_STALLED);
      return true;
    }
  );
});

test('runWithToolGuard: 永不落地的工具会被判卡死(2026-11-07 那轮 29 分钟的回归)', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    // 复现线上那一下:await 永远不 settle(既没有子进程,也没有对外连接)
    () => runWithToolGuard(() => new Promise(() => {}), 1000),
    (err) => {
      assert.equal(err.code, TOOL_STALLED);
      assert.match(err.message, /1 秒/);
      return true;
    }
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 900, `不该提前触发,实际 ${elapsed}ms`);
  assert.ok(elapsed < 4000, `该在 1000ms 左右触发,实际 ${elapsed}ms`);
});

test('runWithToolGuard: 上限为空/0 时不加任何约束(ask_user 走这条)', async () => {
  const r = await runWithToolGuard(async () => 'no-limit', null);
  assert.equal(r, 'no-limit');
});
