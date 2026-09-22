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
// 多项目编排台的纯函数单测：任务列推导、项目合并去重、执行目录解析、活动流拼装。
// 这些规则前后端只实现一次（后端），所以口径漂移的代价全压在这里的断言上。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalProjectPath,
  projectName,
  resolveTaskRepoPath,
  deriveTaskColumn,
  latestJob,
  summarizeProjectTasks,
  buildProjectEntries,
  decorateTaskForBoard,
  OUTPUT_TAIL_CHARS,
  trimJobForDetail,
  buildTaskDetail,
} from './projectRegistry.js';
import { normalizeOrchestrator, buildActivityFeed, buildRunningAgents } from './orchestratorStore.js';

const sub = (id, status) => ({ id, title: id, desc: '', status, promptOverride: '' });
const job = (id, taskId, status, startedAt, endedAt = null) => ({
  id, taskId, subId: `${taskId}__${id}`, title: '', status, startedAt, endedAt,
});

// ── 路径归一 ────────────────────────────────────────────────────────

test('canonicalProjectPath: Windows 形式转小写 + 斜杠归一（与前端同口径）', () => {
  assert.equal(canonicalProjectPath('e:\\workspace\\x'), 'e:\\workspace\\x');
  assert.equal(canonicalProjectPath('E:\\Workspace\\X'), 'e:\\workspace\\x');
  assert.equal(canonicalProjectPath('  D:/ws/y  '), 'd:\\ws\\y');
  // 同一目录的两种斜杠写法必须落到同一个 key，否则项目列表里出现重复项
  // （实测 article-generator 就同时存在于 D:/... 与 D:\... 两种常用目录里）
  assert.equal(canonicalProjectPath('D:/ws/y'), canonicalProjectPath('D:\\ws\\y'));
  // 目录段大小写也必须归一：常用目录里手输的 c:\users\xuze3 与任务带出的
  // C:\Users\xuze3 是同一个目录，旧口径只转盘符 → 左栏两条同名项目。
  assert.equal(
    canonicalProjectPath('C:\\Users\\xuze3'),
    canonicalProjectPath('c:\\users\\xuze3'),
  );
  // 小写化是**纯字符串**规则，只看 `X:` 这个形状，不看 process.platform ——
  // 所以 Windows 形态的断言在任何平台上都成立（POSIX 上跑测试也守得住）。
  assert.equal(canonicalProjectPath('C:\\Users\\xuze3'), 'c:\\users\\xuze3');
  // POSIX 路径原样返回，**不能**被小写化，也不能被改写成反斜杠：
  // /home/Me/A 与 /home/me/a 是两个真目录，归一就是数据错误
  assert.equal(canonicalProjectPath('/home/me/proj'), '/home/me/proj');
  assert.equal(canonicalProjectPath('/home/me/proj/nested'), '/home/me/proj/nested');
  assert.equal(canonicalProjectPath('/home/Me/A'), '/home/Me/A');
  assert.equal(canonicalProjectPath(''), '');
  assert.equal(canonicalProjectPath(null), '');
});

test('projectName 取末级目录名，空路径返回空串', () => {
  assert.equal(projectName('D:\\ws\\zen-gitsync'), 'zen-gitsync');
  assert.equal(projectName('/home/me/proj/'), 'proj');
  assert.equal(projectName(''), '');
});

// ── 执行目录 ────────────────────────────────────────────────────────

test('resolveTaskRepoPath 优先用任务自己的项目，空则回退当前项目', () => {
  assert.equal(resolveTaskRepoPath({ projectPath: 'D:\\proj-a' }, 'D:\\proj-b'), 'D:\\proj-a');
  assert.equal(resolveTaskRepoPath({ projectPath: '   ' }, 'D:\\proj-b'), 'D:\\proj-b');
  assert.equal(resolveTaskRepoPath({}, 'D:\\proj-b'), 'D:\\proj-b');
  // 目录不存在也不回退：宁可执行报错，也不能把改动悄悄落到另一个仓库
  assert.equal(resolveTaskRepoPath({ projectPath: 'Z:\\gone' }, 'D:\\proj-b'), 'Z:\\gone');
});

// ── 看板列推导 ──────────────────────────────────────────────────────

test('deriveTaskColumn: 从没动过的任务在待处理', () => {
  assert.equal(deriveTaskColumn({ subtasks: [] }, []), 'todo');
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'todo')] }, []), 'todo');
});

test('deriveTaskColumn: 有 job 在跑或子任务 running 就是进行中', () => {
  assert.equal(deriveTaskColumn({ subtasks: [] }, [job('j1', 't1', 'running', '2026-01-01T00:00:00Z')]), 'doing');
  assert.equal(deriveTaskColumn({ subtasks: [] }, [job('j1', 't1', 'pending', '2026-01-01T00:00:00Z')]), 'doing');
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'running')] }, []), 'doing');
});

test('deriveTaskColumn: 子任务全部完成才算已完成', () => {
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'done'), sub('s2', 'done')] }, []), 'done');
  // 一半完成 → 仍待处理，错误与进度由卡片标记展示
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'done'), sub('s2', 'todo')] }, []), 'todo');
  // 有子任务报错也算"需要人看一眼"
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'error'), sub('s2', 'todo')] }, []), 'todo');
});

test('deriveTaskColumn: 无子任务的任务只能看执行记录', () => {
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'done', '2026-01-01T00:00:00Z')]), 'done');
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'cancelled', '2026-01-01T00:00:00Z')]), 'todo');
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'error', '2026-01-01T00:00:00Z')]), 'todo');
});

test('latestJob 按 startedAt 取最新的一条', () => {
  const list = [
    job('j1', 't1', 'error', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
    job('j2', 't1', 'done', '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z'),
  ];
  assert.equal(latestJob(list).id, 'j2');
  assert.equal(latestJob([]), null);
});

// ── 项目合并去重 ────────────────────────────────────────────────────

test('buildProjectEntries: 最近目录与任务路径取并集去重，大小写与斜杠都归一', () => {
  const entries = buildProjectEntries({
    recentDirs: ['e:\\ws\\proj-a', 'D:\\ws\\proj-b'],
    tasks: [
      { id: 't1', projectPath: 'E:\\ws\\proj-a' }, // 与最近目录同一项目（盘符大小写不同）
      { id: 't2', projectPath: 'D:\\ws\\proj-c' }, // 只在任务里出现
      { id: 't3', projectPath: '' },               // 未关联项目，不进清单
    ],
  });
  const byKey = new Map(entries.map(e => [e.key, e]));
  assert.equal(entries.length, 3);
  assert.equal(byKey.get('e:\\ws\\proj-a').source, 'both');
  assert.equal(byKey.get('d:\\ws\\proj-b').source, 'recent');
  assert.equal(byKey.get('d:\\ws\\proj-c').source, 'task');
  assert.equal(byKey.get('d:\\ws\\proj-c').name, 'proj-c');
  // path 保留首次出现的原始写法（前端要拿它跟其它列表对齐、也要显示出来），
  // 只有 key 被归一 —— 别顺手把 path 也小写了
  assert.equal(byKey.get('d:\\ws\\proj-b').path, 'D:\\ws\\proj-b');
});

test('buildProjectEntries: 目录段大小写不同也是同一个项目（旧口径会裂成两条）', () => {
  // 复现现场：常用目录里手输的小写盘符（saveRecentDirectory 落盘原始串）
  // + 任务带出的 C:\Users\xuze3 —— 旧口径只转盘符，这里会得到两条 "xuze3"。
  const entries = buildProjectEntries({
    recentDirs: ['c:\\users\\xuze3'],
    tasks: [{ id: 't1', projectPath: 'C:\\Users\\xuze3' }],
  });
  assert.equal(entries.length, 1, '同一目录的不同大小写写法不应分裂成两个项目');
  assert.equal(entries[0].key, 'c:\\users\\xuze3');
  assert.equal(entries[0].source, 'both', '应当被认成"既在常用目录、又有任务"，而不是两个项目');
  assert.equal(entries[0].name, 'xuze3');
  // 项目行只认这个 key 的任务，key 分叉会连带把任务计数拆到两行上去
  const stats = summarizeProjectTasks(
    [{ id: 't1', projectPath: 'C:\\Users\\xuze3', subtasks: [] }],
    [],
  );
  assert.equal(stats.get('c:\\users\\xuze3').total, 1);
  assert.equal(stats.size, 1);

  // 常用目录里同一个目录也可能历史累积出两种写法。此时只留**首次**那条：
  // 否则界面上的路径会随常用目录的顺序跳变，`source` 也会从 both 退化掉。
  const dup = buildProjectEntries({
    recentDirs: ['C:\\Users\\xuze3', 'c:/users/xuze3'],
    tasks: [{ id: 't1', projectPath: 'c:\\users\\xuze3' }],
  });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].path, 'C:\\Users\\xuze3', 'path 应取首次出现的写法');
  assert.equal(dup[0].source, 'both', '重复的第二种写法不该抹掉已命中的来源');
});

test('summarizeProjectTasks: 按项目汇总列数量、进度、活跃执行与最后活跃时间', () => {
  const tasks = [
    // A 项目：1 个已完成
    { id: 'a1', projectPath: 'D:\\a', subtasks: [sub('a1s', 'done')], updatedAt: '2026-01-01T00:00:00Z' },
    // A 项目：1 个在跑（job running）
    { id: 'a2', projectPath: 'D:\\a', subtasks: [sub('a2s', 'running')], updatedAt: '2026-01-02T00:00:00Z' },
    // B 项目：1 个待处理
    { id: 'b1', projectPath: 'D:\\b', subtasks: [sub('b1s', 'todo')], updatedAt: '2026-01-03T00:00:00Z' },
  ];
  const jobs = [
    job('j1', 'a2', 'running', '2026-01-04T00:00:00Z'),
    job('j2', 'a1', 'done', '2026-01-01T01:00:00Z', '2026-01-01T01:30:00Z'),
  ];
  const stats = summarizeProjectTasks(tasks, jobs);

  const a = stats.get('d:\\a');
  assert.equal(a.total, 2);
  assert.equal(a.done, 1);
  assert.equal(a.doing, 1);
  assert.equal(a.progress, 50);
  assert.equal(a.runningJobs, 1);
  // 最后活跃时间要把 job 的起止也算进来（任务体本身可能很久没改）
  assert.equal(a.lastActiveAt, '2026-01-04T00:00:00Z');

  const b = stats.get('d:\\b');
  assert.equal(b.total, 1);
  assert.equal(b.todo, 1);
  assert.equal(b.progress, 0);
  assert.equal(b.runningJobs, 0);
  assert.equal(b.lastActiveAt, '2026-01-03T00:00:00Z');
});

test('decorateTaskForBoard: 只回卡片需要的字段', () => {
  const card = decorateTaskForBoard({
    id: 't1', title: '标题', desc: '描述', projectPath: 'D:\\a',
    subtasks: [sub('s1', 'done'), sub('s2', 'error')],
    attachments: [{ id: 'at1' }],
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
  }, []);
  assert.equal(card.column, 'todo');
  assert.equal(card.type, 'complex');
  assert.equal(card.subtaskCount, 2);
  assert.equal(card.subtaskDoneCount, 1);
  assert.equal(card.subtaskErrorCount, 1);
  assert.equal(card.attachmentCount, 1);
  assert.equal(card.runningJobs, 0);
  // 没跑过就没有完成时间——看板「已完成」列的排序靠它，空值必须显式是 null
  // 而不是 undefined（前端 doneAt 的回退链要能一路退到 updatedAt）
  assert.equal(card.lastJobEndedAt, null);
});

test('decorateTaskForBoard: lastJobEndedAt 取最近一条 job 的结束时间（已完成列排序用）', () => {
  const jobs = [
    job('j1', 't1', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z'),
    job('j2', 't1', 'done', '2026-01-03T00:00:00Z', '2026-01-03T00:20:00Z'),
    job('j3', 't1', 'error', '2026-01-02T00:00:00Z', '2026-01-02T00:05:00Z'),
  ];
  const base = { id: 't1', title: '', desc: '', subtasks: [], createdAt: '2025-12-31T00:00:00Z' };

  // 只有 j2 是"最近"的，即使它的结束时间排在 startedAt 序里也是最后
  assert.equal(decorateTaskForBoard(base, jobs).lastJobEndedAt, '2026-01-03T00:20:00Z');

  // 简单任务执行完成不写 tasks.json 的 updatedAt，所以完成时间只能由 job 给——
  // 这条断言守的就是"卡片时间不能退化成创建时间"这个坑
  assert.equal(decorateTaskForBoard(base, jobs).updatedAt, null);

  // 还在跑（没有 endedAt）时退到 startedAt，卡片至少有个时间可显示
  const running = [job('j9', 't1', 'running', '2026-02-01T00:00:00Z')];
  assert.equal(decorateTaskForBoard(base, running).lastJobEndedAt, '2026-02-01T00:00:00Z');
});

// ── 编排状态与活动流 ────────────────────────────────────────────────

test('normalizeOrchestrator: 缺字段/脏数据都要能起来', () => {
  const fresh = normalizeOrchestrator(null);
  assert.equal(fresh.active, true); // 缺省是"调度中"
  assert.deepEqual(fresh.instructions, []);

  assert.equal(normalizeOrchestrator({ active: false }).active, false);
  assert.equal(normalizeOrchestrator({ active: 'no' }).active, true); // 只有显式 false 才算暂停

  const withJunk = normalizeOrchestrator({ instructions: [null, 5, { text: 'hi' }] });
  assert.equal(withJunk.instructions.length, 1);
  assert.equal(withJunk.instructions[0].text, 'hi');
  assert.equal(withJunk.instructions[0].status, 'created');
});

test('buildActivityFeed: job 起止合成两条记录，与人类指令一起按时间倒序', () => {
  const jobs = [{
    id: 'j1', taskId: 't1', subId: 's1', status: 'done', pid: 123,
    startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z', exitCode: 0,
  }];
  const tasks = [{
    id: 't1', projectPath: 'D:\\ws\\proj-a',
    subtasks: [{ id: 's1', title: '子任务一', status: 'done' }],
    title: '任务一',
  }];
  const instructions = [{
    id: 'i1', text: '把这些重构一下', projectPath: 'D:\\ws\\proj-a',
    at: '2026-01-01T00:10:00Z', status: 'accepted',
  }];

  const feed = buildActivityFeed({ jobs, tasks, instructions });
  assert.equal(feed.length, 3);
  assert.deepEqual(feed.map(r => r.kind), ['user', 'done', 'dispatch']);
  assert.equal(feed[1].taskTitle, '任务一');
  assert.equal(feed[1].subTitle, '子任务一');
  assert.equal(feed[1].projectName, 'proj-a');
  assert.equal(feed[2].pid, 123);
  assert.equal(feed[0].instructionStatus, 'accepted');
});

test('buildActivityFeed: 指令带起来的起跑并进指令行，不再重复出一遍「派发」', () => {
  const jobs = [{
    id: 'j1', taskId: 't1', status: 'done',
    startedAt: '2026-01-01T00:00:01Z', endedAt: '2026-01-01T00:05:00Z',
  }];
  // 任务标题就是指令首行，所以派发行和指令行本来长得一模一样
  const tasks = [{ id: 't1', title: '把这些重构一下', projectPath: 'D:\\ws\\proj-a', subtasks: [] }];
  const instructions = [{
    id: 'i1', text: '把这些重构一下', taskId: 't1', projectPath: 'D:\\ws\\proj-a',
    at: '2026-01-01T00:00:00Z', status: 'accepted',
  }];

  const feed = buildActivityFeed({ jobs, tasks, instructions });
  assert.deepEqual(feed.map(r => r.kind), ['done', 'user']);
  // 落点没丢：指令行自己带着项目名，前端据此渲染「落点「proj-a」」
  assert.equal(feed[1].projectName, 'proj-a');
});

test('buildActivityFeed: 只吸收指令后的首次起跑，手动重跑仍保留派发行', () => {
  const jobs = [
    { id: 'j1', taskId: 't1', status: 'done', startedAt: '2026-01-01T00:00:01Z', endedAt: '2026-01-01T00:05:00Z' },
    { id: 'j2', taskId: 't1', status: 'done', startedAt: '2026-01-01T00:10:00Z', endedAt: '2026-01-01T00:15:00Z' },
  ];
  const tasks = [{ id: 't1', title: '跑一下', projectPath: 'D:\\ws\\proj-a', subtasks: [] }];
  const instructions = [{
    id: 'i1', text: '跑一下', taskId: 't1', projectPath: 'D:\\ws\\proj-a',
    at: '2026-01-01T00:00:00Z', status: 'accepted',
  }];

  const feed = buildActivityFeed({ jobs, tasks, instructions });
  assert.deepEqual(feed.map(r => r.kind), ['done', 'dispatch', 'done', 'user']);
  assert.equal(feed[1].jobId, 'j2'); // 留下的是第二次（重跑）那次
});

test('buildActivityFeed: 指令还没跑起来时，起跑行照旧保留给别的 job', () => {
  // 指令建了任务但没执行（调度暂停）——此时该任务的任何起跑都不是它带起来的
  const jobs = [{ id: 'j1', taskId: 't1', status: 'done', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:05:00Z' }];
  const tasks = [{ id: 't1', title: '手跑的', projectPath: 'D:\\a', subtasks: [] }];
  const instructions = [{
    id: 'i1', text: '手跑的', taskId: 't1', projectPath: 'D:\\a',
    at: '2026-01-01T00:20:00Z', status: 'created',
  }];

  const feed = buildActivityFeed({ jobs, tasks, instructions });
  assert.deepEqual(feed.map(r => r.kind), ['user', 'done', 'dispatch']);
});

test('buildActivityFeed: 失败与取消分别落成 error / cancelled', () => {
  const jobs = [
    { id: 'j1', taskId: 't1', subId: 's1', status: 'error', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', error: 'boom' },
    { id: 'j2', taskId: 't1', subId: 's2', status: 'cancelled', startedAt: '2026-01-01T00:02:00Z', endedAt: '2026-01-01T00:03:00Z' },
  ];
  const feed = buildActivityFeed({ jobs, tasks: [{ id: 't1', projectPath: 'D:\\a', subtasks: [] }] });
  const kinds = feed.map(r => r.kind);
  assert.ok(kinds.includes('error'));
  assert.ok(kinds.includes('cancelled'));
  assert.equal(feed.find(r => r.kind === 'error').error, 'boom');
});

test('buildActivityFeed: 任务已被删除时仍能出记录（不留孤儿空白）', () => {
  const jobs = [{ id: 'j1', taskId: 'gone', subId: 's1', status: 'done', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' }];
  const feed = buildActivityFeed({ jobs, tasks: [] });
  assert.equal(feed.length, 2);
  assert.equal(feed[0].taskTitle, '');
  assert.equal(feed[0].projectName, '');
});

test('buildRunningAgents: 只列活跃 job，到 job 粒度而不是任务粒度', () => {
  const tasks = [{
    id: 't1', projectPath: 'D:\\ws\\proj-a', subtasks: [
      { id: 's1', title: '子任务一', status: 'running' },
      { id: 's2', title: '子任务二', status: 'running' },
    ],
  }];
  const jobs = [
    { id: 'j1', taskId: 't1', subId: 's1', status: 'running', pid: 111, startedAt: '2026-01-01T00:02:00Z' },
    { id: 'j2', taskId: 't1', subId: 's2', status: 'pending', pid: 222, startedAt: '2026-01-01T00:01:00Z' },
    { id: 'j3', taskId: 't1', subId: 's3', status: 'done', pid: 333, startedAt: '2026-01-01T00:00:00Z' },
  ];
  const running = buildRunningAgents({ jobs, tasks });
  assert.equal(running.length, 2);
  // 最新的排在前面
  assert.equal(running[0].jobId, 'j1');
  assert.equal(running[0].subTitle, '子任务一');
  assert.equal(running[0].projectName, 'proj-a');
  assert.equal(running[1].status, 'pending');
});

// ── 任务详情（点卡片弹窗用） ────────────────────────────────────────

test('trimJobForDetail: 丢 prompt/thinking，output 只留尾部并标记被截断', () => {
  const big = 'x'.repeat(OUTPUT_TAIL_CHARS + 500) + 'END';
  const j = {
    id: 'j1', taskId: 't1', subId: 's1', title: '跑一下', status: 'done',
    prompt: 'P'.repeat(10000), thinking: 'T'.repeat(10000),
    output: big, pid: 42, startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
    exitCode: 0, error: '',
  };
  const t = trimJobForDetail(j);
  assert.equal(t.outputTail.length, OUTPUT_TAIL_CHARS);
  assert.equal(t.outputTruncated, true);
  assert.equal(t.hasOutput, true);
  // 保留的是尾部，不是头部
  assert.equal(t.outputTail.endsWith('END'), true);
  assert.equal(t.outputTruncated === true && t.outputTail.startsWith('x'), true);
  // 大字段必须被丢掉，否则弹窗会把整份日志搬进 DOM
  assert.equal('prompt' in t, false);
  assert.equal('thinking' in t, false);
  assert.equal(t.pid, 42);
  assert.equal(t.exitCode, 0);
});

test('trimJobForDetail: 短输出原样保留且不谎报截断', () => {
  const t = trimJobForDetail({ id: 'j1', status: 'error', output: 'boom', error: '炸了' });
  assert.equal(t.outputTail, 'boom');
  assert.equal(t.outputTruncated, false);
  assert.equal(t.error, '炸了');
  assert.equal(t.pid, null);
  assert.equal(t.exitCode, null);
});

test('trimJobForDetail: null / 无 output 不炸', () => {
  assert.equal(trimJobForDetail(null), null);
  const t = trimJobForDetail({ id: 'j2', status: 'pending' });
  assert.equal(t.outputTail, '');
  assert.equal(t.outputTruncated, false);
  assert.equal(t.hasOutput, false);
});

test('buildTaskDetail: 任务缺失返回 null（交路由转 404）', () => {
  assert.equal(buildTaskDetail(null, []), null);
  assert.equal(buildTaskDetail({}, []), null);
});

test('buildTaskDetail: lastJob 取最新一条，recentJobs 倒序且被限制条数', () => {
  const task = {
    id: 't1', title: '任务', desc: '', type: 'complex',
    subtasks: [sub('s1', 'done'), sub('s2', 'running')],
    attachments: [{ id: 'a1' }],
  };
  const jobs = [
    job('j1', 't1', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
    job('j3', 't1', 'running', '2026-01-01T00:02:00Z'),
    job('j2', 't1', 'done', '2026-01-01T00:01:00Z', '2026-01-01T00:02:00Z'),
  ];
  const d = buildTaskDetail(task, jobs);
  assert.equal(d.task.id, 't1');
  assert.equal(d.jobCount, 3);
  // 最新的是 j3（有 startedAt 无 endedAt，时间戳取 startedAt）
  assert.equal(d.lastJob.id, 'j3');
  assert.equal(d.recentJobs[0].id, 'j3');
  assert.equal(d.recentJobs[1].id, 'j2');
  assert.equal(d.recentJobs[2].id, 'j1');
  // 有 job 在跑 → 进行中
  assert.equal(d.column, 'doing');
});

test('buildTaskDetail: recentJobLimit 生效；无 job 时 lastJob 为 null 而不是抛错', () => {
  const task = { id: 't2', title: '', desc: '', type: 'simple', subtasks: [] };
  const jobs = [1, 2, 3, 4, 5, 6].map(i => job('j' + i, 't2', 'done', `2026-01-0${i}T00:00:00Z`));
  const d = buildTaskDetail(task, jobs, { recentJobLimit: 2 });
  assert.equal(d.recentJobs.length, 2);
  assert.equal(d.jobCount, 6);
  assert.equal(d.lastJob.id, 'j6');

  const empty = buildTaskDetail(task, []);
  assert.equal(empty.lastJob, null);
  assert.deepEqual(empty.recentJobs, []);
  assert.equal(empty.jobCount, 0);
  assert.equal(empty.column, 'todo');
});
