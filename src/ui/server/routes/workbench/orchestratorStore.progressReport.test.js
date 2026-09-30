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

// 进度报告**历史文件**的两条规则（读写都在 orchestratorStore 里）：
//
//   1. 没有事实的报告不算报告 —— 读的时候当不存在，写的时候也活不过下一次落盘。
//      用户 2026-09-29 的原话："这种没有在执行的就不用展示了"：那 4 条
//      "当时没有任务在执行"既零信息量，又占着 20 条上限的格子。
//   2. 窗口期内**内容一样**的只留第一份 —— 没有正文的报告（NO_MODEL）逐字节相同，
//      「立即报告」连点两下就会在历史里留下两条一模一样的记录
//      （真实数据：2026-09-28T15:44:08.161 与 .226，两条都是 manual / tasks=0）。
//
// 隔离：必须在 import 之前把 USERPROFILE/HOME 指向 mkdtemp 沙箱，否则就是往用户真实的
// ~/.zen-gitsync 里写报告（同 dispatchInstruction.test.js / jobStore.test.js 的做法）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-report-store-test-'));
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const load = p => import(pathToFileURL(path.join(projectRoot, p)).href);
const { readReports, appendReport } = await load('src/ui/server/routes/workbench/orchestratorStore.js');
const { ORCHESTRATOR_REPORTS_FILE, readJson } = await load('src/ui/server/routes/workbench/shared.js');

after(async () => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
});

/** 一份任务事实的最小形状（normalizeReport 认得的那几个字段） */
const fact = (taskId, taskTitle) => ({
  taskId,
  taskTitle,
  projectName: 'zen-gitsync',
  startedAt: null,
  elapsedMs: 1000,
  agent: 'claude',
  toolCallCount: 3,
  lastTool: 'Edit src/a.ts',
  lastLine: '正在改登录模块',
});

/** 手写历史文件：直接落盘才能构造"30 秒前"这种 appendReport 自己写不出来的时间 */
async function seed(reports) {
  await fs.mkdir(path.dirname(ORCHESTRATOR_REPORTS_FILE), { recursive: true });
  await fs.writeFile(ORCHESTRATOR_REPORTS_FILE, JSON.stringify({ version: 1, reports }, null, 2), 'utf8');
}

/** 磁盘上的原始内容（不走 readReports 的过滤），用来验证"真的清掉了" */
async function onDisk() {
  const data = await readJson(ORCHESTRATOR_REPORTS_FILE, null);
  return (data && Array.isArray(data.reports)) ? data.reports : [];
}

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const rawReport = (over = {}) => ({
  id: 'r-' + Math.random().toString(36).slice(2, 8),
  at: iso(0),
  trigger: 'manual',
  text: '',
  errorCode: '',
  errorDetail: '',
  tasks: [],
  ...over,
});

before(async () => { await seed([]); });

test('空报告读不出来（"这种没有在执行的就不用展示了"）', async () => {
  await seed([
    rawReport({ id: 'with-facts', at: iso(60_000), tasks: [fact('t1', '有事实的任务')] }),
    rawReport({ id: 'empty-1', at: iso(30_000) }),
    rawReport({ id: 'empty-2', at: iso(20_000) }),
  ]);
  const list = await readReports();
  assert.deepEqual(list.map(r => r.id), ['with-facts']);
});

test('空报告不再占用 20 条上限：读出来的是最近 20 条**真**报告', async () => {
  const reports = [];
  // 交错写：每两条真报告中间夹一条空报告，真报告共 21 条（超上限 1 条）
  for (let i = 0; i < 21; i++) {
    reports.push(rawReport({ id: `real-${i}`, at: iso((21 - i) * 1000), tasks: [fact(`t${i}`, `任务 ${i}`)] }));
    reports.push(rawReport({ id: `empty-${i}`, at: iso((21 - i) * 1000 + 500) }));
  }
  await seed(reports);
  const list = await readReports();
  assert.equal(list.length, 20);
  assert.ok(list.every(r => r.tasks.length > 0), '读出来的每一条都得有事实');
  // 新的在前：real-20 最新，real-0 被上限挤掉
  assert.equal(list[0].id, 'real-20');
  assert.ok(!list.some(r => r.id === 'real-0'));
});

test('历史遗留的空报告在下一次落盘时从磁盘上清掉', async () => {
  await seed([rawReport({ id: 'legacy-empty', at: iso(60_000) })]);
  await appendReport(rawReport({ id: 'ignored', trigger: 'auto', tasks: [fact('t1', '任务')] }));
  const disk = await onDisk();
  assert.equal(disk.length, 1);
  assert.ok(!disk.some(r => r.id === 'legacy-empty'), '空报告应该已经从文件里消失');
});

test('窗口期内内容一样的第二份不落盘（连点两下的去重）', async () => {
  await seed([]);
  const first = await appendReport(rawReport({ errorCode: 'NO_MODEL', tasks: [fact('t1', '任务 A')] }));
  const second = await appendReport(rawReport({ errorCode: 'NO_MODEL', tasks: [fact('t1', '任务 A')] }));
  assert.equal(second.id, first.id, '第二份应该被判为重复，返回已有的那份');
  assert.equal((await onDisk()).length, 1);
});

test('同一批任务但正文不同 → 两份都留（不是"同一批任务就合并"）', async () => {
  await seed([]);
  const base = { tasks: [fact('t1', '任务 A')] };
  await appendReport(rawReport({ ...base, text: '第一次汇报：正在改登录模块。' }));
  await appendReport(rawReport({ ...base, text: '第二次汇报：已经在跑测试了。' }));
  assert.equal((await onDisk()).length, 2);
});

test('过了去重窗口那份就不再算重复（同一分钟连点两下之外是正常的两份）', async () => {
  // 手写一条 30 秒前的报告，再用相同内容 append —— 窗口（10s）已经过去
  const stale = rawReport({ id: 'stale', at: iso(30_000), errorCode: 'NO_MODEL', tasks: [fact('t1', '任务 A')] });
  await seed([stale]);
  const saved = await appendReport(rawReport({ errorCode: 'NO_MODEL', tasks: [fact('t1', '任务 A')] }));
  assert.notEqual(saved.id, 'stale');
  assert.equal((await onDisk()).length, 2);
});

test('触发的来源不同（手动 vs 自动）不算重复', async () => {
  await seed([]);
  const tasks = [fact('t1', '任务 A')];
  await appendReport(rawReport({ trigger: 'manual', tasks }));
  await appendReport(rawReport({ trigger: 'auto', tasks }));
  assert.equal((await onDisk()).length, 2);
});

test('上限仍然生效：多余的报告按时间从旧到新丢掉', async () => {
  await seed([]);
  for (let i = 0; i < 23; i++) {
    // 每份正文都不同，绕开去重窗口
    await appendReport(rawReport({ text: `第 ${i} 次汇报`, tasks: [fact('t1', '任务 A')] }));
  }
  assert.equal((await onDisk()).length, 20);
});

// ── 百分比（模型给的进度）────────────────────────────────────────────────
//
// 读回来这一侧要守的只有一条：**盘上是什么就是什么**。脏值 / 老记录一律 null
// （界面据此不画进度条），不许出现"读一次变成 0"或"写 130 读回 100"这种事 ——
// 那等于替模型说了一句它没说过的话。

test('百分比原样进出：报告整体与每个任务各自的都留着', async () => {
  await seed([]);
  await appendReport(rawReport({
    text: '正在改登录模块。',
    percent: 62,
    tasks: [{ ...fact('t1', '任务 A'), percent: 70 }, { ...fact('t2', '任务 B'), percent: 30 }],
  }));
  const [r] = await readReports();
  assert.equal(r.percent, 62);
  assert.deepEqual(r.tasks.map(t => t.percent), [70, 30]);
});

test('脏百分比不会变成 0 / 100：越界与非法值一律 null', async () => {
  await seed([
    rawReport({
      id: 'dirty',
      tasks: [
        { ...fact('t1', '越界'), percent: 130 },
        { ...fact('t2', '负数'), percent: -5 },
        { ...fact('t3', '不是数'), percent: 'abc' },
        { ...fact('t4', '显式 null'), percent: null },
      ],
    }),
  ]);
  const [r] = await readReports();
  // 报告本身的 percent 压根没写（老记录）—— 同样是 null
  assert.equal(r.percent, null);
  // 显式 null 那条是**模型没给**时落盘的样子：读回来必须是 null，
  // 不能变成 0（`Number(null)` 是 0）—— 那会让界面上多出一条 0% 的条
  assert.deepEqual(r.tasks.map(t => t.percent), [null, null, null, null]);
});

test('老报告（没有 percent 这个字段）读出来是 null，不是 0', async () => {
  await seed([rawReport({ id: 'legacy', tasks: [fact('t1', '老任务')] })]);
  const [r] = await readReports();
  assert.equal(r.percent, null);
  assert.equal(r.tasks[0].percent, null);
  // 字段本身得在：前端拿 undefined 和拿 null 是两种分支，缺字段会让"不画"那条路走不到
  assert.ok('percent' in r.tasks[0]);
});
