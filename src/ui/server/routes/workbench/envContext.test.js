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
// 这里守的是三件事：
//   1. 注入出去的块里**真的**有项目名/路径/计数与真相源文件路径 ——
//      否则"Agent 知道我有哪些项目"就是空话（旧行为：prompt 里只有用户原话）；
//   2. 计数口径与看板列一致 —— 而且**数据是从 aiContext 的 tasks 板块来的**
//      （不再有第二份 buildProjectEntries + summarizeProjectTasks 实现）；
//   3. 快照取不到时**降级但不丢关键信息**：项目清单可以没有，
//      但"克隆优先 SSH"这条偏好必须还在。
//
// ⚠️ board 一律用**真实的** collectWorkbenchTasks 产出，不手搓：
// 手搓的话，第 2 条就变成了"测试自己跟自己对"，把口径分叉放走。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvContextBlock, ENV_CONTEXT_MAX_PROJECTS } from './envContext.js';
import { TASK_COLUMNS } from './projectRegistry.js';
import { TRUTH_FILES } from './shared.js';
import { collectWorkbenchTasks } from '../aiContext/collectors.js';

/** 用真实的 collector 造 board —— envContext 在生产里吃到的就是它 */
const boardOf = ({ tasks = [], jobs = [], recentDirs = [] } = {}) => {
  const r = collectWorkbenchTasks({ tasks, jobs, recentDirs });
  assert.equal(r.ok, true, 'collectWorkbenchTasks 应当成功');
  assert.ok(r.data, 'tasks 板块必须带上结构化 data（envContext 的唯一数据来源）');
  return r.data;
};

const job = (id, taskId, status) => ({
  id, taskId, subId: `${taskId}__x`, title: '', status,
  startedAt: '2026-09-18T02:00:00.000Z',
  endedAt: status === 'running' ? null : '2026-09-18T02:01:00.000Z',
});

const build = (opts) => buildEnvContextBlock({ truthFiles: TRUTH_FILES, ...opts });

test('取不到 board 时**不返回 null**：偏好与真相源照给（项目清单整体省掉）', () => {
  // 这一条是刻意的行为变更。老版本"没有项目就返回 null"，但块里那两条**不需要取数**
  // 的内容（克隆优先 SSH、真相源路径）恰恰是最不该丢的 —— SSH 那条少一次，
  // 任务克隆仓库时就会退回 https、弹出凭据窗口把自己停在半路。
  for (const board of [null, undefined, {}, { projects: [] }, { projects: [{ name: 'x' }] }]) {
    const block = build({ currentProjectPath: 'D:\\ws\\a', board });
    assert.ok(block, 'board 缺失也必须产出块');
    assert.match(block, /优先使用 SSH/);
    for (const p of Object.values(TRUTH_FILES)) assert.ok(block.includes(p), `缺少路径 ${p}`);
    // 但项目那段不能硬编一个空清单（模型会把"没列出来"读成"没有项目"）
    assert.doesNotMatch(block, /项目清单（共 0 个/);
    if (!board || !board.projects || board.projects.length === 0) {
      assert.match(block, /项目清单：本次未能取到/);
    }
  }
});

test('项目清单带名称、路径与三列计数，并标出当前项目', () => {
  const board = boardOf({
    recentDirs: ['D:\\ws\\zen-gitsync', 'D:\\ws\\article-generator'],
    tasks: [
      // 已完成：simple 任务跑过一次且 job 是 done
      { id: 't1', projectPath: 'D:\\ws\\zen-gitsync', type: 'simple' },
      // 进行中：有 job 处于 running
      { id: 't2', projectPath: 'D:\\ws\\article-generator', type: 'simple' },
      // 待处理：没子任务也没执行过
      { id: 't3', projectPath: 'D:\\ws\\article-generator', type: 'simple' },
    ],
    jobs: [job('j1', 't1', 'done'), job('j2', 't2', 'running')],
  });

  const block = build({ currentProjectPath: 'D:\\ws\\zen-gitsync', board });

  // 项目名 + 路径都在
  assert.match(block, /zen-gitsync/);
  assert.match(block, /article-generator/);
  assert.match(block, /D:\\ws\\article-generator/);
  // 三列计数：zen-gitsync 1 条已完成 → 0/0/1；article-generator 1 进行中 1 待处理 → 1/1/0
  assert.match(block, /- zen-gitsync \| D:\\ws\\zen-gitsync \| 0\/0\/1\s+← 当前/);
  assert.match(block, /- article-generator \| D:\\ws\\article-generator \| 1\/1\/0/);
  // 合计：3 条，各列各一条；顺带带上"正在执行 1 个"
  assert.match(block, /全部项目合计 3 条 —— 待处理 1 \/ 进行中 1 \/ 已完成 1/);
  assert.match(block, /正在执行 1 个/);
  // 真相源路径：这是"够得着"的关键，缺了 Agent 还是只能猜
  for (const p of Object.values(TRUTH_FILES)) assert.ok(block.includes(p), `缺少路径 ${p}`);
  // 明确要求它去读文件，而不是回"我看不到"
  assert.match(block, /不要回答"我看不到\/无法访问"/);
});

test('当前项目标记必须归一化后比较（大小写不同也算同一个）', () => {
  // 条目 key 是归一化过的（小写 + 反斜杠），而 cwd 常常是另一种写法 ——
  // 直接拿 path 跟 key 比会永远不相等，表现为"当前项目"标记丢失。
  const board = boardOf({
    recentDirs: ['C:\\Users\\xuze3', 'D:\\ws\\other'],
    tasks: [],
    jobs: [],
  });
  const block = build({
    // 不只盘符：目录段大小写也不一样（左栏重复项那个 bug 的同款写法差异）
    currentProjectPath: 'c:/users/XUZE3',
    board,
  });
  assert.match(block, /- xuze3 \| C:\\Users\\xuze3 \| 0\/0\/0\s+← 当前/);
  assert.match(block, /- other \| D:\\ws\\other \| 0\/0\/0\n/);
});

test('项目数超过上限时只列前 N 个，但合计仍按全量算', () => {
  const total = ENV_CONTEXT_MAX_PROJECTS + 5;
  const recentDirs = [];
  const tasks = [];
  for (let i = 0; i < total; i += 1) {
    const p = `D:\\ws\\p${i}`;
    recentDirs.push(p);
    tasks.push({ id: `t${i}`, projectPath: p, type: 'simple' });
  }

  const block = build({ currentProjectPath: '', board: boardOf({ recentDirs, tasks }) });

  const listed = block.split('\n').filter(l => l.startsWith('- p') && l.includes('| D:'));
  assert.equal(listed.length, ENV_CONTEXT_MAX_PROJECTS);
  assert.match(block, new RegExp(`共 ${total} 个`));
  assert.match(block, /还有 5 个未列出/);
  // 合计不受截断影响：另外 5 个也要算进去
  assert.match(block, new RegExp(`全部项目合计 ${total} 条`));
});

test('maxProjects 可覆盖，且非法值回落到默认上限', () => {
  const board = boardOf({ recentDirs: ['D:\\ws\\a', 'D:\\ws\\b', 'D:\\ws\\c'], tasks: [] });
  const short = build({ board, maxProjects: 1 });
  assert.equal(short.split('\n').filter(l => l.startsWith('- a') || l.startsWith('- b') || l.startsWith('- c')).length, 1);

  const bad = build({ board, maxProjects: 0 });
  assert.equal(bad.split('\n').filter(l => l.startsWith('- ') && l.includes('| D:')).length, 3);
});

test('没关联项目的任务不计入项目行，但计入合计', () => {
  const board = boardOf({
    recentDirs: ['D:\\ws\\a'],
    tasks: [
      { id: 't1', projectPath: 'D:\\ws\\a', type: 'simple' },
      { id: 't2', projectPath: '', type: 'simple' },
    ],
  });
  const block = build({ board });
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
  const board = boardOf({
    recentDirs: ['D:\\ws\\a'],
    tasks: [
      { id: 't1', projectPath: 'D:\\ws\\a', type: 'simple' },
      { id: 't2', projectPath: 'D:\\ws\\a', type: 'simple' },
    ],
  });
  const block = build({ board });

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

// ── 口径同源：这一条守的是"别再长出第二份实现"────────────────────────
//
// 改动前 envContext 自己读 tasks.json、自己做 buildProjectEntries + summarizeProjectTasks，
// 与 aiContext 的 tasks 板块是同一口径的两个副本。两份实现分叉时**不会报错**，
// 只会让 Agent 在编排台里和智能体页里看到不同的项目数。这条断言把两份绑在一起：
// envContext 渲染出来的每个数字，都必须能在 collector 的摘要里找到。
test('口径同源：envContext 的数字必须与 tasks 板块的摘要逐项对上', () => {
  const tasks = [
    { id: 't1', projectPath: 'D:\\ws\\a', type: 'simple' },
    { id: 't2', projectPath: 'D:\\ws\\a', type: 'simple' },
    { id: 't3', projectPath: 'D:\\ws\\b', type: 'simple' },
    { id: 't4', projectPath: '', type: 'simple' },
  ];
  const jobs = [job('j1', 't3', 'done')];
  const section = collectWorkbenchTasks({ tasks, jobs, recentDirs: ['D:\\ws\\a', 'D:\\ws\\b'] });
  const block = buildEnvContextBlock({
    currentProjectPath: 'D:\\ws\\b',
    board: section.data,
    truthFiles: TRUTH_FILES,
  });

  // ① 合计那一句：collector 的 summary 里是「全部项目合计 4 条 —— 待处理 3 / 进行中 0 / 已完成 1」，
  //    envContext 必须复现出同样的数字（前缀文案相同，直接整句比对最省事）。
  const totals = section.summary.match(/全部项目合计 \d+ 条 —— [^，]+/)[0];
  assert.ok(block.includes(totals), `envContext 的合计与板块摘要不一致:\n${block}`);

  // ② 项目数：摘要里的项目行数与 envContext 列出的行数一致
  const collectorRows = section.lines.filter(l => /^- .+ \| .+ \| \d+\/\d+\/\d+$/.test(l));
  const envRows = block.split('\n').filter(l => /^- .+ \| .+ \| \d+\/\d+\/\d+/.test(l));
  assert.equal(envRows.length, collectorRows.length, '两份视图列出的项目数应一致');
  assert.ok(collectorRows.length > 0, '这个用例应当至少有一个项目');

  // ③ 结构化 data 自己也得自洽：statsByKey 的合计 == total
  const sum = { total: 0 };
  for (const k of TASK_COLUMNS) sum[k] = 0;
  for (const s of Object.values(section.data.statsByKey)) {
    sum.total += s.total || 0;
    for (const k of TASK_COLUMNS) sum[k] += s[k] || 0;
  }
  assert.equal(sum.total, section.data.total.total);
  for (const k of TASK_COLUMNS) assert.equal(sum[k], section.data.total[k]);
});

// ── 用户偏好：克隆仓库优先 SSH ────────────────────────────────────────
//
// 这条只对**工作台任务**起作用（执行器是外部 CLI claude / opencode，系统提示词不归我们写，
// envContext 是唯一能把偏好递进去的地方）。断言钉住两个平台的地址都写全 —— 用户实际踩的
// 那个坑就是 Gitee 走 https 弹了凭据窗口；只留 GitHub 一条等于只覆盖一半场景。
test('注入块带上「克隆优先 SSH」这条用户偏好', () => {
  const block = build({ board: boardOf({ recentDirs: ['D:\\ws\\a'], tasks: [] }) });
  assert.match(block, /优先使用 SSH/);
  assert.match(block, /git@github\.com:owner\/repo\.git/);
  assert.match(block, /git@gitee\.com:owner\/repo\.git/);
  // 退回条件也得在：没写清"什么时候可以退回"，模型会在 SSH 失败后来回重试
  assert.match(block, /Permission denied \(publickey\)/);
});

test('真相源清单来自唯一的 TRUTH_FILES（四个路径一个不落，且不多写）', () => {
  const block = build({ board: boardOf({ recentDirs: ['D:\\ws\\a'], tasks: [] }) });
  const listed = block.split('\n').filter(l => l.startsWith('- ') && l.includes(' —— ') && l.includes('json'));
  assert.equal(listed.length, Object.keys(TRUTH_FILES).length);
  // 编排台指令流水必须在这份清单里 —— 它是 envContext 相对七个板块视图**多**出来的那一条
  assert.ok(block.includes(TRUTH_FILES.orchestratorFile));
  assert.match(block, /调度台发过的指令流水/);
});
