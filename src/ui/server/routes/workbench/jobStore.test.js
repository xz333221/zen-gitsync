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

// jobs「磁盘 ∪ 内存」合并的回归测试(2026-09-20)。
//
// 背景:jobs Map 只在进程启动时 hydrate 一次、之后永不回读磁盘,而看板列
// (projectRegistry.deriveTaskColumn)完全由执行记录推导 —— 于是同时开两个 g ui 时,
// 跑完任务的那个显示"已完成",另一个启动更早的还停在"待处理"。
// 修法见 jobStore.js 的「磁盘快照」段。本文件钉住修复后的三条口径:
//   1. 别的实例落在 jobs.json 里的记录,刷新后必须参与推导
//   2. 同一 id 两边都有时,**内存**(本进程跑的,最新)优先
//   3. 落盘前必须先并上磁盘,否则会把别的实例的记录抹掉
//
// 隔离策略与 config.*.test.mjs 一致:在 import jobStore.js **之前**把
// USERPROFILE/HOME 指向 mkdtemp 沙箱 —— 这个模块 import 时就会 hydrate +
// enforceRetention,不隔离就是在用户真实的 ~/.zen-gitsync 上做读写。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import jobStore.js 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-jobstore-test-'));
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
// Windows 下 os.homedir() 的兜底是 HOMEDRIVE+HOMEPATH,清掉以防 USERPROFILE 被忽略
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
});

const modUrl = (rel) => pathToFileURL(path.join(projectRoot, rel)).href;
const { DATA_DIR } = await import(modUrl('src/ui/server/routes/workbench/shared.js'));
const {
  jobs,
  snapshotJobs,
  mergedJobs,
  refreshJobsFromDisk,
  flushJobsSaveNow,
} = await import(modUrl('src/ui/server/routes/workbench/jobStore.js'));
const { deriveTaskColumn, groupJobsByTask } = await import(modUrl('src/ui/server/routes/workbench/projectRegistry.js'));

const dataDir = path.join(fakeHome, '.zen-gitsync');
const jobsFile = path.join(dataDir, 'jobs.json');

async function seedJobsFile(list) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(jobsFile, JSON.stringify({ version: 1, jobs: list }, null, 2), 'utf-8');
}

/**
 * 磁盘上的一条记录,形如"另一个 g ui 实例跑完/跑着的时候落盘的"。
 * pid 固定用一个不可能存在的值(Windows 的 pid 从低位顺序分配,POSIX 的 pid_max
 * 默认 4194304),这样"进程已不存在"那条分支是稳定可测的,不依赖跑测试时的机器状态。
 */
const diskJob = (id, taskId, status, extra = {}) => ({
  id,
  taskId,
  subId: '',
  title: `job-${id}`,
  status,
  startedAt: '2026-09-20T00:40:00.000Z',
  endedAt: status === 'done' ? '2026-09-20T00:50:00.000Z' : null,
  pid: 2147483647,
  ...extra,
});

const simpleTask = (id) => ({ id, title: id, type: 'simple', projectPath: 'c:\\ws\\a' });

// ── 沙箱自检 ────────────────────────────────────────────────────────
// 这条不是形式主义:DATA_DIR 一旦没落在沙箱里,下面每个用例都会去写用户真实的
// jobs.json(还会顺带跑一遍 retention)。先钉死它。
test('沙箱:DATA_DIR 落在 mkdtemp 里,不是用户真实 home', () => {
  assert.ok(DATA_DIR.startsWith(fakeHome), `DATA_DIR 应落在沙箱内,实际: ${DATA_DIR}`);
});

// ── 核心场景 ────────────────────────────────────────────────────────
test('另一个 g ui 跑完的任务:刷新后必须推导成「已完成」', async () => {
  await seedJobsFile([diskJob('j-other', 't1', 'done')]);
  await refreshJobsFromDisk();

  const snap = snapshotJobs();
  assert.ok(snap.some(j => j.id === 'j-other'), '磁盘上的记录必须出现在快照里');

  const byTask = groupJobsByTask(snap);
  // 修复前这里是 todo:内存 Map 里没有别的实例跑的 job,deriveTaskColumn 只能看到空数组
  assert.equal(deriveTaskColumn(simpleTask('t1'), byTask.get('t1') || []), 'done');
  assert.equal(
    deriveTaskColumn(simpleTask('t2'), byTask.get('t2') || []),
    'todo',
    '没动过的任务仍应在待处理'
  );
});

test('只刷一次不够:文件被别的实例改写后,下一次刷新要读到新内容', async () => {
  // 故意让两次写入**等长**(done / todo 都是 4 字节,endedAt 显式给同一个值),
  // 把"靠 size 变化兜底"这条路堵掉,逼 mtime 判断真的起作用。
  const endedAt = '2026-09-20T00:50:00.000Z';
  await seedJobsFile([diskJob('j-x', 't1', 'done', { endedAt })]);
  await refreshJobsFromDisk();
  assert.equal(snapshotJobs().find(j => j.id === 'j-x').status, 'done');

  await seedJobsFile([diskJob('j-x', 't1', 'todo', { endedAt })]);
  await refreshJobsFromDisk();
  assert.equal(
    snapshotJobs().find(j => j.id === 'j-x').status,
    'todo',
    '缓存短路不能把旧内容锁死'
  );
});

// ── 优先级:内存 > 磁盘 ─────────────────────────────────────────────
test('同一 id 内存优先:正在跑的 job 不能被磁盘上的旧状态盖掉', async () => {
  await seedJobsFile([diskJob('j-live', 't1', 'done')]);
  jobs.set('j-live', {
    id: 'j-live',
    taskId: 't1',
    subId: '',
    title: 'job-j-live',
    status: 'running',
    startedAt: '2026-09-20T01:00:00.000Z',
    pid: process.pid,
    child: { 假装: 'ChildProcess,不该出现在快照里' },
  });
  try {
    await refreshJobsFromDisk();
    assert.equal(mergedJobs().get('j-live').status, 'running', '内存里是活的,必须优先');

    const snap = snapshotJobs().find(j => j.id === 'j-live');
    assert.equal(snap.status, 'running');
    assert.equal('child' in snap, false, 'child 引用必须被剥离');
  } finally {
    jobs.delete('j-live');
  }
});

// ── 孤儿回收 ────────────────────────────────────────────────────────
test('孤儿 job 回收:进程没了且文件很久没人写 → 降级 error,不占着「进行中」', async () => {
  await seedJobsFile([diskJob('j-orphan', 't1', 'running')]);
  // 模拟"另一个 g ui 被 Ctrl+C 掉在中途":它的终态永远不会再 flush 出来
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(jobsFile, old, old);
  await refreshJobsFromDisk();

  const j = snapshotJobs().find(x => x.id === 'j-orphan');
  assert.equal(j.status, 'error');
  assert.match(j.error || '', /回收/);
  assert.equal(deriveTaskColumn(simpleTask('t1'), [j]), 'todo', '回收后不该继续占着进行中');
});

test('宽限期:刚跑完还没落盘的窗口里,不把别人的 job 误判成孤儿', async () => {
  // 文件是刚写的(job 结束 → 终态 flush 有 1.5s debounce),这时的 pid 死 + running
  // 是正常现象,不是孤儿
  await seedJobsFile([diskJob('j-fresh', 't1', 'running')]);
  await refreshJobsFromDisk();
  assert.equal(
    snapshotJobs().find(x => x.id === 'j-fresh').status,
    'running',
    '宽限期内必须保持原状'
  );
});

// ── 写盘:先合并再写 ────────────────────────────────────────────────
test('落盘不抹别人的记录:flush 必须并上磁盘上的历史 job 再写', async () => {
  await seedJobsFile([diskJob('j-a', 't1', 'done'), diskJob('j-b', 't2', 'done')]);
  jobs.set('j-mine', {
    id: 'j-mine',
    taskId: 't3',
    subId: '',
    title: 'job-j-mine',
    status: 'done',
    startedAt: '2026-09-20T01:10:00.000Z',
    endedAt: '2026-09-20T01:20:00.000Z',
    pid: process.pid,
  });
  try {
    await flushJobsSaveNow();
    const raw = JSON.parse(await fs.readFile(jobsFile, 'utf-8'));
    assert.deepEqual(
      raw.jobs.map(j => j.id).sort(),
      ['j-a', 'j-b', 'j-mine'],
      '别的实例的记录不能被本进程的落盘抹掉'
    );
  } finally {
    jobs.delete('j-mine');
  }
});
