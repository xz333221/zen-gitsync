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
} from './projectRegistry.js';
import { normalizeOrchestrator, buildActivityFeed, buildRunningAgents } from './orchestratorStore.js';

const sub = (id, status) => ({ id, title: id, desc: '', status, promptOverride: '' });
const job = (id, taskId, status, startedAt, endedAt = null) => ({
  id, taskId, subId: `${taskId}__${id}`, title: '', status, startedAt, endedAt,
});

// ── 路径归一 ────────────────────────────────────────────────────────

test('canonicalProjectPath: 盘符转大写 + Windows 斜杠归一（与前端同口径）', () => {
  assert.equal(canonicalProjectPath('e:\\workspace\\x'), 'E:\\workspace\\x');
  assert.equal(canonicalProjectPath('  D:/ws/y  '), 'D:\\ws\\y');
  // 同一目录的两种斜杠写法必须落到同一个 key，否则项目列表里出现重复项
  // （实测 article-generator 就同时存在于 D:/... 与 D:\... 两种常用目录里）
  assert.equal(canonicalProjectPath('D:/ws/y'), canonicalProjectPath('D:\\ws\\y'));
  // POSIX 路径原样返回，不能被改写成反斜杠
  assert.equal(canonicalProjectPath('/home/me/proj'), '/home/me/proj');
  assert.equal(canonicalProjectPath('/home/me/proj/nested'), '/home/me/proj/nested');
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
  // 一半完成 → 跑过但没收尾，落在评审中
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'done'), sub('s2', 'todo')] }, []), 'review');
  // 有子任务报错也算"需要人看一眼"
  assert.equal(deriveTaskColumn({ subtasks: [sub('s1', 'error'), sub('s2', 'todo')] }, []), 'review');
});

test('deriveTaskColumn: 无子任务的任务只能看执行记录', () => {
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'done', '2026-01-01T00:00:00Z')]), 'done');
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'cancelled', '2026-01-01T00:00:00Z')]), 'review');
  assert.equal(deriveTaskColumn({ subtasks: [], type: 'simple' }, [job('j1', 't1', 'error', '2026-01-01T00:00:00Z')]), 'review');
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

test('buildProjectEntries: 最近目录与任务路径取并集去重，盘符大小写归一', () => {
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
  assert.equal(byKey.get('E:\\ws\\proj-a').source, 'both');
  assert.equal(byKey.get('D:\\ws\\proj-b').source, 'recent');
  assert.equal(byKey.get('D:\\ws\\proj-c').source, 'task');
  assert.equal(byKey.get('D:\\ws\\proj-c').name, 'proj-c');
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

  const a = stats.get('D:\\a');
  assert.equal(a.total, 2);
  assert.equal(a.done, 1);
  assert.equal(a.doing, 1);
  assert.equal(a.progress, 50);
  assert.equal(a.runningJobs, 1);
  // 最后活跃时间要把 job 的起止也算进来（任务体本身可能很久没改）
  assert.equal(a.lastActiveAt, '2026-01-04T00:00:00Z');

  const b = stats.get('D:\\b');
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
  assert.equal(card.column, 'review');
  assert.equal(card.type, 'complex');
  assert.equal(card.subtaskCount, 2);
  assert.equal(card.subtaskDoneCount, 1);
  assert.equal(card.subtaskErrorCount, 1);
  assert.equal(card.attachmentCount, 1);
  assert.equal(card.runningJobs, 0);
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
