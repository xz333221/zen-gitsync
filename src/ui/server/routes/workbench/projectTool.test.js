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
// list_projects 工具输出（projectTool.js formatProjectList）纯函数单测。
//
// 这里守的是三件事：
//   1. 模型**真的**能读到项目名/路径/Git 状态/任务进度 —— 用户最初的问题
//      ("我哪些项目需要 pull")就靠这几个字段回答，少一个都答不了；
//   2. 领先/落后在没刷新时必须被明确标注为"本地快照"，并且要提示 refresh=true
//      —— 否则模型会把"上次 fetch 时的状态"当成实时值，给出相反的结论；
//   3. 各种边界（非仓库 / 目录不存在 / 探测超时 / 无 upstream / detached / 无任务）
//      都有可读的说法，而不是抛出 undefined。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatProjectList } from './projectTool.js';

/** 造一条 listProjects() 口径的项目 */
function project(overrides = {}) {
  const baseGit = {
    isGitRepo: true,
    branch: 'main',
    upstream: 'origin/main',
    hasUpstream: true,
    detached: false,
    ahead: 0,
    behind: 0,
    changed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  const baseStats = { total: 0, todo: 0, doing: 0, done: 0, progress: 0, runningJobs: 0, errorSubtasks: 0 };
  const merged = {
    path: 'D:\\ws\\proj',
    key: 'd:\\ws\\proj',
    name: 'proj',
    source: 'recent',
    isCurrent: false,
    exists: true,
    git: baseGit,
    stats: baseStats,
    ...overrides,
  };
  // git / stats 是"部分覆盖"语义,但 git: null 表示"探测超时、没探到",不能被默认值吃掉
  if ('git' in overrides) merged.git = overrides.git === null ? null : { ...baseGit, ...overrides.git };
  if ('stats' in overrides) merged.stats = { ...baseStats, ...overrides.stats };
  return merged;
}

test('未刷新时明确标注"本地快照"并提示 refresh=true', () => {
  const text = formatProjectList([project()]);
  assert.match(text, /共 1 个/);
  assert.match(text, /上次 fetch 时的快照/);
  assert.match(text, /refresh=true/);
});

test('刷新过之后不再出现快照警告，改为报出三态计数', () => {
  const text = formatProjectList([project()], {
    refreshed: true,
    fetchStats: { ok: 2, skipped: 1, failed: 1, failures: ['D:\\ws\\bad: fetch 失败'] },
  });
  assert.doesNotMatch(text, /上次 fetch 时的快照/);
  assert.match(text, /成功 2 · 跳过 1.*失败 1/);
  assert.match(text, /D:\\ws\\bad: fetch 失败/);
});

test('落后/领先/未提交都出现在 Git 行里，且当前项目被标出', () => {
  const text = formatProjectList([
    project({ isCurrent: true, git: { branch: 'main', behind: 4, ahead: 2, changed: 3, staged: 1, unstaged: 1, untracked: 1 } }),
  ]);
  assert.match(text, /← 当前所在项目/);
  assert.match(text, /分支 main/);
  assert.match(text, /origin\/main（落后 4 · 领先 2）/);
  assert.match(text, /工作区 3 项未提交（已暂存 1 · 未暂存 1 · 未跟踪 1）/);
});

test('已同步 / 无 upstream / detached 各有说法，不出现 undefined', () => {
  const synced = formatProjectList([project({ git: { ahead: 0, behind: 0 } })]);
  assert.match(synced, /origin\/main（已同步）/);

  const noUpstream = formatProjectList([project({ git: { upstream: null, hasUpstream: false } })]);
  assert.match(noUpstream, /未配置上游分支/);

  const detached = formatProjectList([project({ git: { detached: true, branch: null } })]);
  assert.match(detached, /detached/);
  assert.doesNotMatch(detached, /undefined/);
});

test('非仓库 / 目录不存在 / 探测超时都能区分，不谎报成"干净"', () => {
  const notRepo = formatProjectList([project({ git: { isGitRepo: false } })]);
  assert.match(notRepo, /不是 Git 仓库/);
  assert.doesNotMatch(notRepo, /工作区干净/);

  const missing = formatProjectList([project({ exists: false })]);
  assert.match(missing, /目录不存在/);

  const unknown = formatProjectList([project({ git: null })]);
  assert.match(unknown, /Git 状态未探到/);
});

test('任务进度按看板三列报出，无任务时说"无"', () => {
  const withTasks = formatProjectList([project({ stats: { total: 9, todo: 1, doing: 2, done: 6, runningJobs: 1, errorSubtasks: 1 } })]);
  assert.match(withTasks, /待处理 1 \/ 进行中 2 \/ 已完成 6/);
  assert.match(withTasks, /正在执行 1/);
  assert.match(withTasks, /子任务报错 1/);

  assert.match(formatProjectList([project()]), /任务: 无/);
});

test('多个项目按顺序编号，条目之间不串行', () => {
  const text = formatProjectList([
    project({ path: 'D:\\ws\\a', name: 'a' }),
    project({ path: 'D:\\ws\\b', name: 'b' }),
  ]);
  assert.match(text, /1\. a/);
  assert.match(text, /2\. b/);
  assert.equal(text.match(/路径: /g).length, 2);
});

test('失败条目过多时截断，但保留总数', () => {
  const failures = Array.from({ length: 8 }, (_, i) => `D:\\ws\\p${i}: fetch 失败`);
  const text = formatProjectList([project()], {
    refreshed: true,
    fetchStats: { ok: 0, skipped: 0, failed: 8, failures },
  });
  assert.match(text, /还有 3 条失败未列出/);
  assert.doesNotMatch(text, /D:\\ws\\p7/);
});

test('给了 tasks.json 路径时把它带给模型（要细节自己读）', () => {
  const text = formatProjectList([project()], { tasksFile: 'C:\\Users\\u\\.zen-gitsync\\tasks.json' });
  assert.match(text, /C:\\Users\\u\\\.zen-gitsync\\tasks\.json/);
});

test('空清单也是一个合法回答（不抛异常、不说"共 undefined 个"）', () => {
  const text = formatProjectList([]);
  assert.match(text, /共 0 个/);
  assert.doesNotMatch(text, /undefined/);
});
