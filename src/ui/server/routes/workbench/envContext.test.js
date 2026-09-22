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
// 运行环境上下文（envContext.js）纯函数单测。
//
// 这里守的是两件事：
//   1. 注入出去的块里**真的**有项目名/路径/计数与真相源文件路径 ——
//      否则"Agent 知道我有哪些项目"就是空话（旧行为：prompt 里只有用户原话）；
//   2. 计数口径与看板列一致（复用 summarizeProjectTasks，不另立一套）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvContextBlock, ENV_CONTEXT_MAX_PROJECTS } from './envContext.js';
import { canonicalProjectPath, TASK_COLUMNS } from './projectRegistry.js';

const entry = (path) => ({
  path,
  key: canonicalProjectPath(path),
  name: path.split(/[\\/]/).filter(Boolean).pop(),
  source: 'recent',
});

const job = (id, taskId, status) => ({
  id, taskId, subId: `${taskId}__x`, title: '', status,
  startedAt: '2026-09-18T02:00:00.000Z',
  endedAt: status === 'running' ? null : '2026-09-18T02:01:00.000Z',
});

const PATHS = {
  tasksFile: '/home/u/.zen-gitsync/tasks.json',
  jobsFile: '/home/u/.zen-gitsync/jobs.json',
  orchestratorFile: '/home/u/.zen-gitsync/orchestrator.json',
  configFile: '/home/u/.zen-gitsync/config.json',
};

test('没有任何项目时返回 null（不注入空块浪费 token）', () => {
  assert.equal(buildEnvContextBlock({}), null);
  assert.equal(buildEnvContextBlock(), null);
  assert.equal(buildEnvContextBlock({ projects: [] }), null);
  // 只有 key 缺项的脏条目也算没有项目
  assert.equal(buildEnvContextBlock({ projects: [{ name: 'x', path: '' }] }), null);
});

test('项目清单带名称、路径与三列计数，并标出当前项目', () => {
  const projects = [entry('D:\\ws\\zen-gitsync'), entry('D:\\ws\\article-generator')];
  const tasks = [
    // 已完成：simple 任务跑过一次且 job 是 done
    { id: 't1', projectPath: 'D:\\ws\\zen-gitsync', type: 'simple' },
    // 进行中：有 job 处于 running
    { id: 't2', projectPath: 'D:\\ws\\article-generator', type: 'simple' },
    // 待处理：没子任务也没执行过
    { id: 't3', projectPath: 'D:\\ws\\article-generator', type: 'simple' },
  ];
  const jobs = [job('j1', 't1', 'done'), job('j2', 't2', 'running')];

  const block = buildEnvContextBlock({
    currentProjectPath: 'D:\\ws\\zen-gitsync',
    projects, tasks, jobs, ...PATHS,
  });

  assert.ok(block, '应当产出上下文块');
  // 项目名 + 路径都在
  assert.match(block, /zen-gitsync/);
  assert.match(block, /article-generator/);
  assert.match(block, /D:\\ws\\article-generator/);
  // 三列计数：zen-gitsync 1 条已完成 → 0/0/1；article-generator 1 进行中 1 待处理 → 1/1/0
  assert.match(block, /- zen-gitsync \| D:\\ws\\zen-gitsync \| 0\/0\/1\s+← 当前/);
  assert.match(block, /- article-generator \| D:\\ws\\article-generator \| 1\/1\/0/);
  // 合计：3 条，各列各一条
  assert.match(block, /全部项目合计 3 条 —— 待处理 1 \/ 进行中 1 \/ 已完成 1/);
  // 真相源路径：这是"够得着"的关键，缺了 Agent 还是只能猜
  for (const p of Object.values(PATHS)) assert.ok(block.includes(p), `缺少路径 ${p}`);
  // 明确要求它去读文件，而不是回"我看不到"
  assert.match(block, /不要回答"我看不到\/无法访问"/);
});

test('当前项目标记必须归一化后比较（大小写不同也算同一个）', () => {
  // 条目 key 是归一化过的（小写 + 反斜杠），而 cwd 常常是另一种写法 ——
  // 直接拿 path 跟 key 比会永远不相等，表现为"当前项目"标记丢失。
  const projects = [entry('C:\\Users\\xuze3'), entry('D:\\ws\\other')];
  const block = buildEnvContextBlock({
    // 不只盘符：目录段大小写也不一样（左栏重复项那个 bug 的同款写法差异）
    currentProjectPath: 'c:/users/XUZE3',
    projects, tasks: [], jobs: [], ...PATHS,
  });
  assert.match(block, /- xuze3 \| C:\\Users\\xuze3 \| 0\/0\/0\s+← 当前/);
  assert.match(block, /- other \| D:\\ws\\other \| 0\/0\/0\n/);
});

test('项目数超过上限时只列前 N 个，但合计仍按全量算', () => {
  const projects = [];
  const tasks = [];
  const total = ENV_CONTEXT_MAX_PROJECTS + 5;
  for (let i = 0; i < total; i += 1) {
    const p = `D:\\ws\\p${i}`;
    projects.push(entry(p));
    tasks.push({ id: `t${i}`, projectPath: p, type: 'simple' });
  }

  const block = buildEnvContextBlock({
    currentProjectPath: '', projects, tasks, jobs: [], ...PATHS,
  });

  const listed = block.split('\n').filter(l => l.startsWith('- p') && l.includes('| D:'));
  assert.equal(listed.length, ENV_CONTEXT_MAX_PROJECTS);
  assert.match(block, new RegExp(`共 ${total} 个`));
  assert.match(block, /还有 5 个未列出/);
  // 合计不受截断影响：另外 5 个也要算进去
  assert.match(block, new RegExp(`全部项目合计 ${total} 条`));
});

test('maxProjects 可覆盖，且非法值回落到默认上限', () => {
  const projects = [entry('D:\\ws\\a'), entry('D:\\ws\\b'), entry('D:\\ws\\c')];
  const short = buildEnvContextBlock({ projects, tasks: [], jobs: [], maxProjects: 1, ...PATHS });
  assert.equal(short.split('\n').filter(l => l.startsWith('- a') || l.startsWith('- b') || l.startsWith('- c')).length, 1);

  const bad = buildEnvContextBlock({ projects, tasks: [], jobs: [], maxProjects: 0, ...PATHS });
  assert.equal(bad.split('\n').filter(l => l.startsWith('- ') && l.includes('| D:')).length, 3);
});

test('没关联项目的任务不计入项目行，但计入合计', () => {
  const projects = [entry('D:\\ws\\a')];
  const tasks = [
    { id: 't1', projectPath: 'D:\\ws\\a', type: 'simple' },
    { id: 't2', projectPath: '', type: 'simple' },
  ];
  const block = buildEnvContextBlock({ projects, tasks, jobs: [], ...PATHS });
  // 项目行只认 key 匹配得上的那条（t1）→ 待处理 1
  assert.match(block, /- a \| D:\\ws\\a \| 1\/0\/0/);
  // 而合计走 NO_PROJECT_KEY 那桶一起算 → 2 条；两者不相等正是这段断言要守的
  assert.match(block, /全部项目合计 2 条/);
  // 无项目归属的任务不该凭空造出一行项目
  assert.equal(block.split('\n').filter(l => l.startsWith('- ') && l.includes('|')).length, 1);
});

// ── 列数一致性：这一条是"改列别再漏一处"的守门员 ──────────────────────
//
// 去掉「评审中」那一轮，输出从四列变三列，但这个文件里是**逐条正则硬写的数字**，
// 只顺手改了最显眼的一行 → 另外三处照红。下面这条不比对具体数字，只守"段数 == 看板列数"，
// 下次增删列时它和上面几条会一起红，而不是让某一条孤零零地报一个对不上的字符串。
test('项目行/合计的段数必须与 TASK_COLUMNS 一致，且每列都有中文标签', () => {
  const projects = [entry('D:\\ws\\a')];
  const tasks = [
    { id: 't1', projectPath: 'D:\\ws\\a', type: 'simple' },
    { id: 't2', projectPath: 'D:\\ws\\a', type: 'simple' },
  ];
  const block = buildEnvContextBlock({ projects, tasks, jobs: [], ...PATHS });

  // 表头里的「待处理/进行中/已完成」：段数 = 列数，且不能有一列回落成 key 本身
  const headerLabels = block.match(/格式: 名称 \| 路径 \| ([^）]+)/)[1].split('/');
  assert.equal(headerLabels.length, TASK_COLUMNS.length, '表头标签数应与看板列数一致');
  TASK_COLUMNS.forEach((key, i) => {
    assert.notEqual(headerLabels[i], key, `列「${key}」缺中文标签（标签表里没这个名字）`);
  });

  // 项目行的计数组数
  const rowCounts = block.match(/- a \| D:\\ws\\a \| ([^\n]+)/)[1].trim().split('/');
  assert.equal(rowCounts.length, TASK_COLUMNS.length, '项目行的计数组数应与看板列数一致');

  // 合计行的段数
  const overview = block.match(/全部项目合计 \d+ 条 —— ([^\n]+)/)[1].split(' / ');
  assert.equal(overview.length, TASK_COLUMNS.length, '合计行的段数应与看板列数一致');

  // 两个任务都是待处理 → 第一段是 2，其余列是 0（顺序由 TASK_COLUMNS 决定，不是写死的下标）
  assert.equal(rowCounts[TASK_COLUMNS.indexOf('todo')], '2');
});
