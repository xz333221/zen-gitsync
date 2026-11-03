// 会话目录监听的回归测试。
//
// 这条信号承载的是"别的进程刚写了会话"—— 远端 peer 提问、另一个 g ui 窗口、CLI。
// 没有它时左栏永远停在打开页面时那份（用户 2026-11-04 报的就是这个）。
//
// 夹具用临时目录（绝不能落到用户真实的 <DATA_DIR>/agent-sessions）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { subscribeAgentSessionChanges, isAgentSessionWatchActive } from './agentSessionEvents.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('会话目录里落盘会触发通知，且同一批写入被 debounce 合并', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-agent-sessions-'));
  let dispose = () => {};
  try {
    let hits = 0;
    dispose = subscribeAgentSessionChanges(() => { hits += 1; }, dir);
    assert.equal(isAgentSessionWatchActive(), true);

    // 一次保存是 tmp + rename 两步，这里再叠三份模拟"连写"。
    for (let i = 0; i < 3; i += 1) {
      const tmp = path.join(dir, `s${i}.json.tmp`);
      fs.writeFileSync(tmp, '{}');
      fs.renameSync(tmp, path.join(dir, `s${i}.json`));
    }
    await sleep(1200);

    assert.ok(hits >= 1, '目录变了却没有通知 = 前端永远不会自动刷新');
    assert.ok(hits <= 3, `同一批写入应被合并，实际 ${hits} 次`);
  } finally {
    // 必须在删目录前断开：监听残留会污染下一条用例的"订阅者计数"。
    dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('最后一个订阅者离开后关掉监听（没人看列表的窗口不该常驻 watcher）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-agent-sessions-'));
  try {
    const disposeA = subscribeAgentSessionChanges(() => {}, dir);
    const disposeB = subscribeAgentSessionChanges(() => {}, dir);
    assert.equal(isAgentSessionWatchActive(), true);
    disposeA();
    assert.equal(isAgentSessionWatchActive(), true, '还有订阅者时不能关');
    disposeB();
    assert.equal(isAgentSessionWatchActive(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
