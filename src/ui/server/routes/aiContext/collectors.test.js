// aiContext/collectors.js 单元测试。
//
// IO 全部走注入的假实现，不联网、不 spawn、不碰真实用户数据。
// 重点覆盖的是**误读路径**：CLI 没装 / 没登录 / 拉取报错时，
// 快照文件必须把"取不到"写清楚，绝不能留一片空白 —— 空白会被模型读成"用户没有仓库"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKS_FILE_LIMIT,
  collectCustomCommands,
  collectGit,
  collectMindmap,
  collectRemote,
  collectSystem,
  collectWorkbenchTasks,
} from './collectors.js';
import { TASK_COLUMNS } from '../workbench/projectRegistry.js';

// ── ① Git ────────────────────────────────────────────────────
test('collectGit:干净仓库 → 摘要点明"工作区干净"', async () => {
  const r = await collectGit({
    repoPath: 'D:/ws/x',
    probe: async () => ({ exists: true, isGitRepo: true, branch: 'main', upstream: 'origin/main', hasUpstream: true, ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0 }),
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /分支 main/);
  assert.match(r.summary, /工作区干净/);
  assert.match(r.lines.join('\n'), /未提交改动: 0/);
});

test('collectGit:有改动 / 非仓库 / 探测抛错 三条降级路径', async () => {
  const dirty = await collectGit({
    repoPath: 'D:/ws/x',
    probe: async () => ({ exists: true, isGitRepo: true, branch: 'dev', hasUpstream: false, changed: 3, staged: 1, unstaged: 1, untracked: 1 }),
  });
  assert.equal(dirty.ok, true);
  assert.match(dirty.summary, /未提交 3 个文件/);
  assert.match(dirty.summary, /无上游分支/);

  const notRepo = await collectGit({ repoPath: 'D:/ws/x', probe: async () => ({ exists: true, isGitRepo: false }) });
  assert.equal(notRepo.ok, true);
  assert.match(notRepo.summary, /不是 git 仓库/);

  const boom = await collectGit({ repoPath: 'D:/ws/x', probe: async () => { throw new Error('git 不存在'); } });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /git 不存在/);
});

test('collectGit:没有项目路径时不硬编造，直接标失败', async () => {
  const r = await collectGit({ repoPath: '', probe: async () => ({}) });
  assert.equal(r.ok, false);
  assert.match(r.error, /未拿到当前项目路径/);
});

// ── ②③ 远程仓库 ──────────────────────────────────────────────
test('collectRemote:CLI 没装 → 必须显式写明"取不到"，且点明不是"没有仓库"', () => {
  const r = collectRemote({ provider: 'github', state: { installed: false } });
  assert.equal(r.ok, true);
  assert.match(r.summary, /未检测到 gh CLI/);
  const body = r.lines.join('\n');
  assert.match(body, /未安装/);
  assert.match(body, /不是"用户没有仓库"/);
});

test('collectRemote:装了没登录 → 给出登录命令', () => {
  const r = collectRemote({ provider: 'gitee', state: { installed: true, version: '0.3.1', authenticated: false } });
  assert.match(r.summary, /未登录/);
  const body = r.lines.join('\n');
  assert.match(body, /gitee auth login/);
  assert.match(body, /不要索要 token/);
});

test('collectRemote:已登录 → 列仓库，并把拉取报错带出来', () => {
  const r = collectRemote({
    provider: 'github',
    state: {
      installed: true, version: '2.101.0', authenticated: true, user: 'xz333221', truncated: false,
      repos: [
        { name: 'zen-gitsync', visibility: 'public', language: 'JavaScript', updatedAt: '2026-09-27T10:00:00Z', description: 'Git GUI' },
        { name: 'flow-mindmap', visibility: 'private' },
      ],
    },
  });
  assert.match(r.summary, /2 个仓库/);
  assert.match(r.summary, /账号 xz333221/);
  assert.match(r.summary, /如 zen-gitsync、flow-mindmap/, '摘要要带前几个仓库名 —— 用户问的就是"有哪些项目"');
  const body = r.lines.join('\n');
  assert.match(body, /- zen-gitsync \| public \| JavaScript \| 更新于 2026-09-27/);
  assert.match(body, /- flow-mindmap \| private/);

  const withError = collectRemote({
    provider: 'github',
    state: { installed: true, authenticated: true, user: 'u', repos: [], error: '网络超时' },
  });
  assert.match(withError.lines.join('\n'), /上次拉取报错: 网络超时（清单可能不完整）/);
});

test('collectRemote:空清单要写明"该账号下没有可见仓库"，而不是留空', () => {
  const r = collectRemote({ provider: 'github', state: { installed: true, authenticated: true, user: 'u', repos: [] } });
  assert.match(r.lines.join('\n'), /该账号下没有可见仓库/);
  // 没有仓库时不许留下"（如 等）"这种半截预览 —— 那会被读成"有仓库但名字是空的"
  assert.ok(!r.summary.includes('如 '), `空清单的摘要不该有预览: ${r.summary}`);
});

test('collectRemote:摘要预览最多带 REPOS_SUMMARY_PREVIEW 个，超出用"等"收尾', () => {
  const repos = Array.from({ length: 12 }, (_, i) => ({ name: `repo-${String(i).padStart(2, '0')}` }));
  const r = collectRemote({ provider: 'gitee', state: { installed: true, authenticated: true, user: 'xuze333221', repos } });
  assert.match(r.summary, /12 个仓库/);
  assert.match(r.summary, /如 repo-00、repo-01、repo-02、repo-03、repo-04 等/);
  assert.ok(!r.summary.includes('repo-05'), '第 6 个开始就不该出现在摘要里（全量在文件里）');
  // 摘要天生要短:注入块每次对话都带着它,不能变成仓库清单的副本
  assert.ok(r.summary.length <= 200, `摘要 ${r.summary.length} 字符，太长了`);
});

// ── ④ 自定义命令 ─────────────────────────────────────────────
test('collectCustomCommands:列出名称与命令，空配置给出明确说明', () => {
  const r = collectCustomCommands({
    config: { customCommands: [{ id: '1', name: 'dev', command: 'npm run dev', description: '起开发服务' }] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '共 1 条');
  assert.match(r.lines[0], /- dev → `npm run dev` — 起开发服务/);

  const empty = collectCustomCommands({ config: {} });
  assert.equal(empty.summary, '共 0 条');
  assert.match(empty.lines[0], /没有配置自定义命令/);
});

// ── ⑤ 工作台任务 ─────────────────────────────────────────────
test('collectWorkbenchTasks:统计口径与看板一致（复用的就是同一份实现）', () => {
  const tasks = [
    { id: 't1', title: '待办任务', projectPath: 'D:/ws/a', updatedAt: '2026-09-28T10:00:00Z' },
    { id: 't2', title: '跑着的任务', description: '描述内容', projectPath: 'D:/ws/a', updatedAt: '2026-09-28T11:00:00Z' },
    { id: 't3', title: '做完了', projectPath: 'D:/ws/b', updatedAt: '2026-09-27T10:00:00Z' },
  ];
  const jobs = [
    { id: 'j1', taskId: 't2', status: 'running', startedAt: '2026-09-28T11:00:00Z' },
    { id: 'j2', taskId: 't3', status: 'done', endedAt: '2026-09-27T11:00:00Z' },
  ];
  const r = collectWorkbenchTasks({ tasks, jobs, recentDirs: ['D:/ws/a'] });
  assert.equal(r.ok, true);
  assert.match(r.summary, /全部项目合计 3 条 —— 待处理 1 \/ 进行中 1 \/ 已完成 1/);
  assert.match(r.summary, /正在执行 1 个/);

  const body = r.lines.join('\n');
  assert.match(body, /## 项目清单（共 2 个）/);
  assert.match(body, /## 任务明细（共 3 条）/);
  assert.match(body, /\[跑着的任务\]/);
  assert.match(body, /最近执行 running/);
  assert.match(body, /描述内容/);
});

test('collectWorkbenchTasks:无任务时也给出完整骨架（不返回 undefined 字段）', () => {
  const r = collectWorkbenchTasks({});
  assert.equal(r.ok, true);
  assert.match(r.summary, /全部项目合计 0 条/);
  assert.match(r.summary, /当前无执行中的任务/);
});

test('collectWorkbenchTasks:任务过多时截断并写明还有多少条', () => {
  const tasks = Array.from({ length: TASKS_FILE_LIMIT + 5 }, (_, i) => ({
    id: `t${i}`, title: `任务${i}`, projectPath: 'D:/ws/a', updatedAt: `2026-09-28T${String(i % 24).padStart(2, '0')}:00:00Z`,
  }));
  const r = collectWorkbenchTasks({ tasks });
  assert.match(r.lines.join('\n'), /…还有 5 条未列出/);
});

// ── tasks 板块的结构化 data：envContext（编排台视角）唯一的数据来源 ──────
//
// 这一条守的是"别再长出第二份实现"：项目清单 / 各列计数 / 合计只算一遍，
// 结构化结果随板块一起交出去，envContext 拿它渲染，而不再自己读一遍 tasks.json。
test('collectWorkbenchTasks:带上结构化 data（项目/计数/合计只在算一遍）', () => {
  const tasks = [
    { id: 't1', projectPath: 'D:/ws/a' },
    { id: 't2', projectPath: 'D:/ws/a' },
    { id: 't3', projectPath: 'D:/ws/b' },
    { id: 't4', projectPath: '' },      // 无归属 → 只进合计，不造项目行
  ];
  const jobs = [
    { id: 'j1', taskId: 't3', status: 'done', endedAt: '2026-09-27T11:00:00Z' },
    { id: 'j2', taskId: 't1', status: 'running', startedAt: '2026-09-28T11:00:00Z' },
  ];
  const r = collectWorkbenchTasks({ tasks, jobs, recentDirs: ['D:/ws/a'] });

  assert.ok(r.data, '必须带 data');
  // 必须是**纯对象**：它会跟着快照缓存一路传下去，Map 一旦被 JSON.stringify 就静默变 {}
  assert.equal(r.data.statsByKey instanceof Map, false);
  assert.equal(typeof r.data.statsByKey, 'object');

  // 项目：a 来自任务 + 最近目录，b 只来自任务
  assert.equal(r.data.projects.length, 2);
  // 合计把无归属的 t4 也算上
  assert.equal(r.data.total.total, 4);
  assert.equal(r.data.runningJobs, 1);
  assert.equal(r.data.taskCount, 4);

  // data 与摘要同源：合计那一段文字里的数字必须能对上
  const [, todo, doing, done] = (r.summary.match(/待处理 (\d+) \/ 进行中 (\d+) \/ 已完成 (\d+)/) || []).map(Number);
  assert.equal(r.data.total.todo, todo);
  assert.equal(r.data.total.doing, doing);
  assert.equal(r.data.total.done, done);

  // statsByKey 求和 == total（结构性自洽）
  const sum = { total: 0 };
  for (const k of TASK_COLUMNS) sum[k] = 0;
  for (const s of Object.values(r.data.statsByKey)) {
    sum.total += s.total || 0;
    for (const k of TASK_COLUMNS) sum[k] += s[k] || 0;
  }
  assert.equal(sum.total, r.data.total.total);
  for (const k of TASK_COLUMNS) assert.equal(sum[k], r.data.total[k]);
});

test('collectWorkbenchTasks:失败/无数据时 data 缺席（envContext 据此降级）', () => {
  // 空入参也要给出 data（不是 undefined），否则 envContext 会误判成"取数失败"
  const r = collectWorkbenchTasks({});
  assert.ok(r.data);
  assert.deepEqual(r.data.projects, []);
  assert.equal(r.data.total.total, 0);
  assert.equal(r.data.runningJobs, 0);

  // 其余板块不该被塞 data —— 只有 tasks 需要
  assert.equal(collectCustomCommands({ config: {} }).data, undefined);
  assert.equal(collectSystem({}).data, undefined);
});

// ── ⑥ 系统状态 ───────────────────────────────────────────────
test('collectSystem:CPU / 内存 / 磁盘 / 端口都要落到文件里', () => {
  const r = collectSystem({
    overview: {
      cpu: { usage: 7.72, cores: 16, model: 'i9' },
      memory: { total: 32 * 1024 ** 3, used: 20 * 1024 ** 3, usagePercent: 62.3 },
      disks: { total: 1, free: 1, used: 1, usagePercent: 1, drives: [{ mount: 'C:', total: 952 * 1024 ** 3, used: 173.9 * 1024 ** 3, usagePercent: 18.2 }] },
      system: { hostname: 'XUZE-QICAHONG', platform: 'win32', arch: 'x64', nodeVersion: 'v24.20.0' },
    },
    ports: [{ protocol: 'TCP', localAddress: '127.0.0.1', port: 4502, pid: 27088, process: 'node.exe' }],
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /CPU 7\.7%/);
  assert.match(r.summary, /内存 62\.3%/);
  assert.match(r.summary, /1 个监听端口/);
  const body = r.lines.join('\n');
  assert.match(body, /- CPU 占用: 7\.7%（16 核 · i9）/);
  assert.match(body, /- C: 已用 173\.9GB/);
  assert.match(body, /TCP 127\.0\.0\.1:4502 PID 27088 node\.exe/);
});

test('collectSystem:磁盘为 null（查询失败降级）时不炸', () => {
  const r = collectSystem({ overview: { cpu: {}, memory: {}, disks: null, system: {} }, ports: [] });
  assert.equal(r.ok, true);
  assert.match(r.lines.join('\n'), /没有查到监听端口/);
});

test('collectSystem:拿不到概览 → 标失败', () => {
  const r = collectSystem({});
  assert.equal(r.ok, false);
  assert.match(r.error, /未拿到系统概览/);
});

// ── ⑦ 思维导图 ───────────────────────────────────────────────
test('collectMindmap:按目录分组列出导图，单目录失败不影响其它目录', async () => {
  const r = await collectMindmap({
    dirs: ['D:/ws/mm', 'D:/gone'],
    listDir: async (dir) => {
      if (dir === 'D:/gone') throw new Error('目录不存在');
      return [{ title: '智能体', name: '智能体.mindmap.json', size: 2048, mtime: Date.parse('2026-09-08T00:41:00Z') }];
    },
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /2 个目录 · 1 个导图（1 个目录读取失败）/);
  const body = r.lines.join('\n');
  assert.match(body, /## D:\/ws\/mm（1 个）/);
  assert.match(body, /- 智能体 \| 2026-09-08/);
  assert.match(body, /- D:\/gone: 目录不存在/);
});

test('collectMindmap:目录全部读不到 → 整块判失败，不能报成"0 个导图"', async () => {
  const r = await collectMindmap({
    dirs: ['D:/gone', 'D:/gone2'],
    listDir: async () => { throw new Error('目录不存在'); },
  });
  assert.equal(r.ok, false, '全失败必须是失败态，否则会被读成"没有思维导图"');
  assert.match(r.error, /全部 2 个目录都读取失败/);
  assert.match(r.lines.join('\n'), /- D:\/gone: 目录不存在/, '细节仍要留在文件里');
});

test('collectMindmap:没配目录时给明确说明，不是空白', async () => {
  const r = await collectMindmap({ dirs: [] });
  assert.equal(r.ok, true);
  assert.match(r.summary, /未配置思维导图目录/);
});

test('collectMindmap:目录为空时也说明"这个目录下没有"', async () => {
  const r = await collectMindmap({ dirs: ['D:/ws/mm'], listDir: async () => [] });
  assert.match(r.summary, /1 个目录 · 0 个导图/);
  assert.match(r.lines.join('\n'), /这个目录下没有 \.mindmap\.json/);
});
