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

// 「运行中 job 的跨实例广播」(live-jobs/<pid>.json) 的回归测试(2026-09-28)。
//
// 背景:jobStore 里的 scheduleJobsSave() 一直是死代码,运行中的 job 从头到尾只活在
// 跑它的那个进程内存里 —— 于是同机开两个 g ui 时,「已完成」两边一致,「进行中」
// 只有跑的那个实例看得到。修法见 liveJobs.js 文件头。本文件钉住它的四条口径:
//   1. 写进去的活跃记录,别的实例扫得到
//   2. owner 进程没了 → 跳过并自愈删文件(不留幽灵「进行中」)
//   3. 没有活跃 job → 文件直接删掉(不能留个空壳让读者白扫)
//   4. 正文/思考/工具流水**截尾**,别让一份跑了几小时的任务把广播文件撑成 MB 级
//
// 隔离策略与 jobStore.test.js 一致:在 import 之前把 USERPROFILE/HOME 指向 mkdtemp。

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import liveJobs.js 之前完成 ----

const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-livejobs-test-'));
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

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await fs.rm(fakeHome, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
});

const modUrl = (rel) => pathToFileURL(path.join(projectRoot, rel)).href;
const {
  LIVE_JOBS_DIR,
} = await import(modUrl('src/ui/server/routes/workbench/shared.js'));
const {
  projectJob,
  toLiveRecord,
  writeLiveJobsFile,
  removeLiveJobsFile,
  scanLiveJobsDir,
  liveJobsFilePath,
  LIVE_OUTPUT_TAIL_CHARS,
  LIVE_THINKING_TAIL_CHARS,
  LIVE_TOOL_CALL_LIMIT,
} = await import(modUrl('src/ui/server/routes/workbench/liveJobs.js'));

/** 一个"正在跑"的 job。字段照 taskRunner 里那个对象形状给。 */
const runningJob = (id, extra = {}) => ({
  id,
  taskId: 't1',
  subId: 't1__simple',
  title: `job-${id}`,
  status: 'running',
  pid: 4242,
  startedAt: '2026-09-28T14:56:51.650Z',
  endedAt: null,
  agent: 'claude',
  prompt: 'p',
  output: 'out',
  thinking: 'think',
  thinkingStartedAt: '2026-09-28T14:56:52.000Z',
  thinkingEndedAt: '2026-09-28T14:56:58.500Z',
  toolCalls: [],
  claudeSessionId: null,
  // 不该被广播出去的内部字段（白名单投影必须剥掉）
  child: { pid: 4242 },
  ...extra,
});

// 每个用例从干净的目录开始：上一轮的 owner 文件会让 scan 结果不可预期
beforeEach(async () => {
  await fs.rm(LIVE_JOBS_DIR, { recursive: true, force: true });
});

// ── 沙箱自检 ────────────────────────────────────────────────────────
test('沙箱:live-jobs 目录落在 mkdtemp 里,不是用户真实 home', () => {
  assert.ok(LIVE_JOBS_DIR.startsWith(fakeHome), `LIVE_JOBS_DIR 应落在沙箱内,实际: ${LIVE_JOBS_DIR}`);
});

// ── 投影 ────────────────────────────────────────────────────────────
test('projectJob:白名单投影剥掉 child 等不可序列化字段,保留前端要的字段', () => {
  const rec = projectJob(runningJob('j1'));
  assert.equal(rec.id, 'j1');
  assert.equal(rec.status, 'running');
  assert.equal(rec.agent, 'claude');
  assert.equal(rec.claudeSessionId, null);
  assert.deepEqual(rec.toolCalls, []);
  // 思考段计时必须过白名单:漏了它 = 本实例看得见「想了多久」、别的实例永远看不见
  assert.equal(rec.thinkingStartedAt, '2026-09-28T14:56:52.000Z');
  assert.equal(rec.thinkingEndedAt, '2026-09-28T14:56:58.500Z');
  assert.ok(!('child' in rec), 'child 必须先剥掉,否则 JSON.stringify 直接抛');
  // 投影结果要能真的序列化
  assert.doesNotThrow(() => JSON.stringify(rec));
});

test('projectJob:老 job 没有计时字段时归成 null(不是 undefined,前端不用判两种空)', () => {
  const rec = projectJob(runningJob('j-old', { thinkingStartedAt: undefined, thinkingEndedAt: undefined }));
  assert.equal(rec.thinkingStartedAt, null);
  assert.equal(rec.thinkingEndedAt, null);
});

test('toLiveRecord:正文/思考截尾,工具流水只留最近若干条', () => {
  const toolCalls = Array.from({ length: LIVE_TOOL_CALL_LIMIT + 5 }, (_, i) => ({
    id: `c${i}`,
    name: 'Bash',
    argsPreview: 'a'.repeat(10),
    arguments: 'b'.repeat(5000),
    result: 'r'.repeat(5000),
    status: 'completed',
    error: null,
  }));
  const rec = toLiveRecord(runningJob('j2', {
    output: 'o'.repeat(LIVE_OUTPUT_TAIL_CHARS + 1000) + 'TAIL',
    thinking: 't'.repeat(LIVE_THINKING_TAIL_CHARS + 500),
    toolCalls,
  }));
  assert.equal(rec.output.length, LIVE_OUTPUT_TAIL_CHARS);
  assert.ok(rec.output.endsWith('TAIL'), '截的必须是尾巴(最新的那段)');
  assert.equal(rec.thinking.length, LIVE_THINKING_TAIL_CHARS);
  assert.equal(rec.toolCalls.length, LIVE_TOOL_CALL_LIMIT);
  // 留下的是最近的:最后一条 id 应等于原数组最后一条
  assert.equal(rec.toolCalls.at(-1).id, `c${LIVE_TOOL_CALL_LIMIT + 4}`);
  assert.ok(rec.toolCalls[0].arguments.length <= 2 * 1024);
  assert.ok(rec.toolCalls[0].result.length <= 2 * 1024);
});

// ── 写 / 读 ─────────────────────────────────────────────────────────
test('写进去的活跃记录:别的实例扫得到,且字段完整', async () => {
  await writeLiveJobsFile(4242, [toLiveRecord(runningJob('j-live'))]);
  const { signature, jobs: found } = await scanLiveJobsDir({ isProcessAlive: () => true });
  assert.ok(signature.length > 0, 'signature 非空才能让读者用 mtime+size 短路');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'j-live');
  assert.equal(found[0].status, 'running');
  assert.equal(found[0].taskId, 't1');
  assert.ok(!('child' in found[0]));
});

test('owner 进程已消失:跳过该文件并顺手删掉(不留幽灵「进行中」)', async () => {
  // 2147483647 是不存在的 pid(沿用 jobStore.test.js 的取法),这条分支不依赖机器状态
  await writeLiveJobsFile(2147483647, [toLiveRecord(runningJob('j-ghost'))]);
  const { jobs: found } = await scanLiveJobsDir();
  assert.equal(found.length, 0);
  await assert.rejects(
    fs.stat(liveJobsFilePath(2147483647)),
    (err) => err.code === 'ENOENT',
    'owner 死了的文件应当被自愈删除'
  );
});

test('没有活跃 job:写空数组 = 直接删文件,不留空壳', async () => {
  await writeLiveJobsFile(4242, [toLiveRecord(runningJob('j-live'))]);
  await writeLiveJobsFile(4242, []);
  await assert.rejects(fs.stat(liveJobsFilePath(4242)), (err) => err.code === 'ENOENT');
  const { signature, jobs: found } = await scanLiveJobsDir({ isProcessAlive: () => true });
  assert.equal(found.length, 0);
  assert.equal(signature, '');
});

test('removeLiveJobsFile 幂等:文件不在也不抛', async () => {
  await removeLiveJobsFile(999999);
  await removeLiveJobsFile(999999);
});

test('目录里的垃圾文件(写中间的 .tmp / 非 pid 名)不参与扫描', async () => {
  await writeLiveJobsFile(4242, [toLiveRecord(runningJob('j-live'))]);
  await fs.writeFile(path.join(LIVE_JOBS_DIR, '4242.json.tmp'), '{ 半截', 'utf-8');
  await fs.writeFile(path.join(LIVE_JOBS_DIR, 'notes.txt'), 'x', 'utf-8');
  await fs.writeFile(path.join(LIVE_JOBS_DIR, '.migrated'), 'x', 'utf-8');
  const { jobs: found } = await scanLiveJobsDir({ isProcessAlive: () => true });
  assert.deepEqual(found.map(j => j.id), ['j-live']);
});

test('损坏的 JSON 文件只跳过,不把整次扫描搞崩', async () => {
  await writeLiveJobsFile(4242, [toLiveRecord(runningJob('j-ok'))]);
  await fs.mkdir(LIVE_JOBS_DIR, { recursive: true });
  await fs.writeFile(path.join(LIVE_JOBS_DIR, '7777.json'), 'not json at all', 'utf-8');
  const { jobs: found } = await scanLiveJobsDir({ isProcessAlive: () => true });
  assert.deepEqual(found.map(j => j.id), ['j-ok']);
});

test('ownerPid 与文件名对不上(被谁改过)的记录不采信', async () => {
  await fs.mkdir(LIVE_JOBS_DIR, { recursive: true });
  await fs.writeFile(
    path.join(LIVE_JOBS_DIR, '4242.json'),
    JSON.stringify({ version: 1, ownerPid: 1, updatedAt: Date.now(), jobs: [runningJob('j-x')] }),
    'utf-8'
  );
  const { jobs: found } = await scanLiveJobsDir({ isProcessAlive: () => true });
  assert.equal(found.length, 0);
});

test('目录不存在时扫描返回空,不抛', async () => {
  const { signature, jobs: found } = await scanLiveJobsDir();
  assert.equal(signature, '');
  assert.deepEqual(found, []);
});
