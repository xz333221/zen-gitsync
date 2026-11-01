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
// utils/instanceQuery.js 的回归测试。
//
// 这层薄封装的唯一职责：把"这台机器上现在有哪些活着的 g ui"翻译成两个问题 ——
// 「谁在听 peer 端口」「有没有活着的 hub」。翻译错了的后果很具体：
//   · findHubInstance 认错 → 项目窗口把 reload 发给一个不存在的地址；
//   · findPeerOwner 认错 → 面板把"其实有人在服务"报成已停止（2026-11-01 的原始故障）。
//
// 隔离方式同 peerSettings.test.js：先改 HOME/USERPROFILE 再动态 import，
// 让 INSTANCES_DIR 落在临时目录（paths.js 在模块加载时求值）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-instance-query-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { findHubInstance, findPeerOwner, listInstances } = await import('./instanceQuery.js');
const { INSTANCES_DIR } = await import('../../../paths.js');

assert.ok(
  INSTANCES_DIR.startsWith(sandboxHome),
  `沙箱未生效：INSTANCES_DIR=${INSTANCES_DIR}（不是 ${sandboxHome} 之下），拒绝继续跑`
);

/**
 * 写一条实例条目。
 *
 * pid 一律用真实存在的进程（自己 / 父进程）—— 注册表 list() 会调用
 * isProcessAlive 把"进程已经没了"的条目裁掉，编一个 pid=999999 只会得到空结果。
 */
async function writeEntry({ pid, port, role = 'project', peerPort = 0, heartbeatAgeMs = 0 }) {
  await fs.mkdir(INSTANCES_DIR, { recursive: true });
  const now = Date.now();
  const entry = {
    pid,
    port,
    projectPath: `D:\\sandbox\\${pid}`,
    projectName: `p${pid}`,
    hostname: 'sandbox',
    role,
    peerPort,
    startedAt: now,
    lastHeartbeat: now - heartbeatAgeMs
  };
  await fs.writeFile(path.join(INSTANCES_DIR, `${pid}.json`), JSON.stringify(entry, null, 2), 'utf-8');
}

async function clearEntries() {
  await fs.rm(INSTANCES_DIR, { recursive: true, force: true });
}

test('空注册表：两个查找都返回 null，不抛', async () => {
  await clearEntries();
  assert.deepEqual(await listInstances(), []);
  assert.equal(await findHubInstance(), null);
  assert.equal(await findPeerOwner(5600), null);
});

test('findHubInstance 只认 role=hub 的那条', async () => {
  await clearEntries();
  await writeEntry({ pid: process.pid, port: 5599, role: 'hub', peerPort: 5600 });
  await writeEntry({ pid: process.ppid, port: 5277, role: 'project', peerPort: 0 });

  const hub = await findHubInstance();
  assert.ok(hub, '应该找到 hub');
  assert.equal(hub.pid, process.pid);
  assert.equal(hub.port, 5599);
});

test('findPeerOwner 按端口命中，不匹配的端口返回 null', async () => {
  await clearEntries();
  await writeEntry({ pid: process.pid, port: 5599, role: 'hub', peerPort: 5600 });
  await writeEntry({ pid: process.ppid, port: 5277, role: 'project', peerPort: 0 });

  const owner = await findPeerOwner(5600);
  assert.ok(owner, '5600 应该有人持有');
  assert.equal(owner.pid, process.pid);

  assert.equal(await findPeerOwner(6000), null, '没人在听的端口不该乱认');
});

test('findPeerOwner 不带端口时返回第一个持有者（peerPort > 0）', async () => {
  await clearEntries();
  await writeEntry({ pid: process.pid, port: 5599, role: 'hub', peerPort: 5601 });
  await writeEntry({ pid: process.ppid, port: 5277, role: 'project', peerPort: 0 });

  const owner = await findPeerOwner();
  assert.ok(owner);
  assert.equal(owner.peerPort, 5601, 'peerPort=0 的条目也不算持有者');
});

test('心跳过期的条目不再被当成持有者（幽灵进程不能骗面板）', async () => {
  await clearEntries();
  // 进程活着但心跳停了（> 30s，比如被挂起 / 卡死）—— 注册表读的时候会裁掉它
  await writeEntry({ pid: process.pid, port: 5599, role: 'hub', peerPort: 5600, heartbeatAgeMs: 60_000 });

  assert.equal(await findHubInstance(), null);
  assert.equal(await findPeerOwner(5600), null);
});
