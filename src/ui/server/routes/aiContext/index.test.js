// aiContext/index.js 单元测试：按板块生成、定向刷新、落盘、缓存、失败隔离、**非阻塞**。
//
// 全部 IO 走注入的假实现 + mkdtemp 出来的临时目录，不联网、不 spawn、
// 不碰 ~/.zen-gitsync 里的真实数据。
//
// 两条最重要的契约：
//   ① 读路径（getSnapshot / getBlock）**永不等待生成** —— 最初的实现 await 生成，
//      结果"用户按下发送"到"模型吐第一个字"之间被 gh/gitee/PowerShell 串起来拖了十几秒，
//      直接挂掉了一个既有回归测试。
//   ② **按板块刷新** —— 七个板块成本差两个数量级，刷 git 不该顺带联网拉仓库列表。
//      所以每个板块有自己的 ttl / force 地板，且只重写自己那个文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAiContextSnapshotter } from './index.js';
import { INDEX_FILE, sectionTtl } from './render.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'zen-ai-context-'));
}

/** 一组"全都正常"的假依赖；单个用例用 over 覆盖其中一项来制造故障 */
function makeDeps(over = {}) {
  const calls = { github: 0, gitee: 0, git: 0 };
  const deps = {
    configManager: {
      loadConfig: async () => ({ customCommands: [{ id: '1', name: 'dev', command: 'npm run dev' }], ui: { mindmapDirs: ['D:/ws/mm'] } }),
      getRecentDirectories: async () => ['D:/ws/a'],
    },
    getCurrentProjectPath: () => 'D:/ws/a',
    readTasks: async () => [{ id: 't1', title: '任务一', projectPath: 'D:/ws/a', updatedAt: '2026-09-28T10:00:00Z' }],
    readJobs: async () => [],
    probeGit: async () => {
      calls.git += 1;
      return { exists: true, isGitRepo: true, branch: 'main', hasUpstream: true, ahead: 1, behind: 0, changed: 2, staged: 1, unstaged: 1, untracked: 0 };
    },
    loadRemoteReposState: async (provider) => {
      if (provider === 'github') calls.github += 1;
      if (provider === 'gitee') calls.gitee += 1;
      return { installed: false };
    },
    getMonitorOverview: async () => ({ cpu: { usage: 1.2 }, memory: { usagePercent: 50 }, disks: null, system: { hostname: 'H' } }),
    listPorts: async () => [],
    listMindmapFiles: async () => [],
    truthFiles: { tasksFile: 'C:/u/.zen-gitsync/tasks.json', jobsFile: 'C:/u/.zen-gitsync/jobs.json', configFile: 'C:/u/.zen-gitsync/config.json' },
    now: () => 1000,
    ...over,
  };
  return { deps, calls };
}

const readFile = (dir, name) => fs.readFile(path.join(dir, name), 'utf-8');

test('生成:写出七个板块文件 + INDEX，文件头都带采集时间与实时查询方法', async () => {
  const dir = await tmpDir();
  const { deps } = makeDeps();
  const snap = createAiContextSnapshotter({ ...deps, dir });

  const state = await snap.refreshAll({ force: true });
  assert.equal(state.sections.length, 7);
  assert.ok(state.sections.every(s => s.collectedAt), '每块都要有自己的采集时间');

  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ['INDEX.md', 'custom-commands.md', 'git-current.md', 'mindmap.md', 'remote-gitee.md', 'remote-github.md', 'system.md', 'workbench-tasks.md']);

  for (const name of files) {
    const text = await readFile(dir, name);
    assert.match(text, /快照/, `${name} 缺"这是快照"的声明`);
    if (name === INDEX_FILE) {
      // INDEX 是汇总,写的是"本次汇总";各板块的采集时间在下面每行里
      assert.match(text, /本次汇总: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'INDEX 缺本次汇总时间');
      continue;
    }
    assert.match(text, /采集时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `${name} 缺采集时间`);
  }

  const gitText = await readFile(dir, 'git-current.md');
  assert.match(gitText, /分支: main/);
  assert.match(gitText, /未提交改动: 2 个文件/);
  assert.match(gitText, /要实时值: .*git status --porcelain/, '板块文件里也要带实时查询方法');

  const index = await readFile(dir, INDEX_FILE);
  assert.match(index, /## 实时查询方法/);
  assert.match(index, /gh repo list/);
});

test('定向刷新:只重跑并重写指定的板块，其它板块文件原地不动', async () => {
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  const gitBefore = await readFile(dir, 'git-current.md');
  const ghBefore = await readFile(dir, 'remote-github.md');
  assert.equal(calls.git, 1);

  // 越过 github 的强制刷新地板（60s）—— 在那之前 force 也不该让它重跑（见下一条用例）
  clock += 60_001;
  await snap.refreshSections(['github'], { force: true });

  assert.equal(calls.github, 2, 'github 应该被重跑');
  assert.equal(calls.git, 1, 'git 不该被顺带重跑');
  assert.equal(await readFile(dir, 'git-current.md'), gitBefore, 'git 文件不该被重写');
  assert.notEqual(await readFile(dir, 'remote-github.md'), ghBefore, 'github 文件应该被重写');
  // git 板块的采集时间没变，github 的变了 —— 这正是"各板块独立刷新"的可观测证据
  const state = snap.getState();
  assert.equal(state.sections.find(s => s.id === 'git').ageMs, 60_001);
  assert.equal(state.sections.find(s => s.id === 'github').ageMs, 0);
});

test('软 TTL:没过期的板块在 refreshAll 里不会被重跑，只有过期的才跑', async () => {
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  assert.equal(calls.git, 1);
  assert.equal(calls.github, 1);

  // 越过 git 的软 TTL（15s），但远没到 github 的（300s）
  clock += sectionTtl('git') + 1;
  await snap.refreshAll();

  assert.equal(calls.git, 2, 'git 过期了应该重跑');
  assert.equal(calls.github, 1, 'github 还没过期，不该重跑（联网板块不能被拖着刷）');
});

test('强制刷新地板:force 也刷不动刚拉过的联网板块，本地板块不受限', async () => {
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  assert.equal(calls.github, 1);
  assert.equal(calls.git, 1);

  // 5 秒后用户切了个面板：git 重跑，github 被地板挡住
  clock += 5000;
  await snap.refreshAll({ force: true });
  assert.equal(calls.git, 2, '本地板块 force 就该真跑');
  assert.equal(calls.github, 1, 'github 有 60s 地板，force 也不该穿透');

  // 过了地板再 force，才允许
  clock += 60_000;
  await snap.refreshAll({ force: true });
  assert.equal(calls.github, 2);
});

test('冷启动:getBlock 立即返回（不等待生成），但块里已经有实时查询方法', async () => {
  const dir = await tmpDir();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { deps } = makeDeps({
    probeGit: async () => {
      await gate; // 模拟"卡在 gh 拉列表 / PowerShell 查磁盘"上
      return { exists: true, isGitRepo: true, branch: 'main', hasUpstream: true, ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0 };
    },
  });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  // 刻意**不 await**：这两个板块正卡在闸门上。若这里 await，本用例会在取块之前就挂住，
  // 后面的用例会被级联报成 "Promise resolution is still pending"（踩过一次）。
  void snap.refreshSections(['git', 'system']);

  const block = await Promise.race([
    snap.getBlock(),
    new Promise(resolve => setTimeout(() => resolve('__TIMEOUT__'), 500)),
  ]);
  assert.notEqual(block, '__TIMEOUT__', '取块不许等生成');
  assert.match(block, /要查实时值就照下面来/, '冷启动也要给实时查询方法');
  assert.match(block, /本轮快照还没生成好/, '并说明快照还没好');

  release();
  await snap.refreshSections(['git', 'system']);
  const after = await snap.getBlock();
  assert.match(after, /各板块摘要/);
});

test('读路径:过期板块先回旧的，同时在后台定向补刷', async () => {
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  const gitAt1 = snap.getState().sections.find(s => s.id === 'git').collectedAt;

  clock += sectionTtl('git') + 1;
  const snap1 = await snap.getSnapshot();
  assert.ok(snap1, '过期也要先回旧的，不能回空');
  assert.equal(snap1.results.find(r => r.id === 'git').collectedAt, gitAt1, '回的应该是旧的那份');

  // 后台那次刷新的 Promise 与显式调用共享，await 一下让它落地
  await snap.refreshSections(['git']);
  assert.equal(calls.git, 2);
  assert.notEqual(snap.getState().sections.find(s => s.id === 'git').collectedAt, gitAt1);
});

test('并发:同一板块的并发生成只跑一次（几个时机同时触发时不会各拉一次网络）', async () => {
  const dir = await tmpDir();
  const { deps, calls } = makeDeps();
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await Promise.all([
    snap.refreshAll({ force: true }),
    snap.refreshAll({ force: true }),
    snap.warm({ force: true }),
  ]);
  assert.equal(calls.git, 1);
  assert.equal(calls.github, 1);
});

test('warm:没传 sections 就是全部；已有新鲜板块时不重复生成', async () => {
  const dir = await tmpDir();
  const { deps, calls } = makeDeps();
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  await snap.warm();
  assert.equal(calls.git, 1, 'warm 不该在新鲜时重跑');
  assert.equal(calls.github, 1);
});

test('warm:一次预热就把七个板块全采集了 —— 不依赖任何面板挂载', async () => {
  // 为什么钉这条:快照采集**不能**跟 UI 挂载绑在一起。前端各 view 是 v-show 外壳 +
  // KeepAlive 内 v-if 懒挂载(见 App.vue),没点过的板块组件根本不存在 —— 采集若依赖面板,
  // "用户一次都没切板块 → g ai 看不到任何板块"就成了默认状态。
  // 采集挂在服务端 listening 后的一次 warm() 上,所以这条保证必须成立。
  const dir = await tmpDir();
  const { deps, calls } = makeDeps();
  // 覆盖实现时要把原来那个"计数版"接着调上,否则 calls 永远停在 0 —— 断言会误报
  const baseLoadRemoteRepos = deps.loadRemoteReposState;
  const snap = createAiContextSnapshotter({
    ...deps,
    loadRemoteReposState: async (provider) => {
      await baseLoadRemoteRepos(provider);
      return { installed: true, version: '1.0.0', authenticated: true, user: 'u', repos: [{ name: `${provider}-repo` }] };
    },
    dir,
  });

  await snap.warm();

  const state = snap.getState();
  assert.equal(state.sections.length, 7, '七个板块都要在');
  for (const s of state.sections) {
    assert.equal(s.ok, true, `${s.id} 没被采集 —— 没切面板就拿不到数据: ${s.summary}`);
  }
  assert.equal(calls.github, 1, 'github 要被拉一次');
  assert.equal(calls.gitee, 1, 'gitee 要被拉一次(用户问的就是这个)');

  // 文件要真落盘 —— 模型读的是文件,不只是内存缓存
  for (const f of ['git-current.md', 'remote-github.md', 'remote-gitee.md', 'custom-commands.md', 'workbench-tasks.md', 'system.md', 'mindmap.md', INDEX_FILE]) {
    const text = await readFile(dir, f);
    assert.ok(text.length > 0, `${f} 没落盘`);
  }

  // 块里要带"文件在哪"的绝对路径示例:只给裸文件名时模型会拿 cwd 当基准拼错,然后回"我看不到"
  const block = await snap.getBlock();
  assert.match(block, /完整路径例：/);
  assert.ok(block.includes(dir), '块里要出现真实的快照目录');
});

test('失败隔离:一个板块抛错不影响其它板块，且失败要写到文件与块里', async () => {
  const dir = await tmpDir();
  const { deps } = makeDeps({
    loadRemoteReposState: async (provider) => {
      if (provider === 'github') throw new Error('gh CLI 挂了');
      return { installed: false };
    },
  });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  const state = await snap.refreshAll({ force: true });
  const github = state.sections.find(s => s.id === 'github');
  assert.equal(github.ok, false);
  assert.equal(state.sections.find(s => s.id === 'git').ok, true);
  assert.equal(state.sections.find(s => s.id === 'gitee').ok, true);

  const text = await readFile(dir, 'remote-github.md');
  assert.match(text, /取数失败: gh CLI 挂了/);

  const block = await snap.getBlock();
  assert.match(block, /暂时取不到: gh CLI 挂了/);
  assert.match(block, /当前项目 Git 状态/, '其它板块仍在块里');
});

test('失败隔离:配置读不到时不整体失败，自定义命令与思维导图降级为空', async () => {
  const dir = await tmpDir();
  const { deps } = makeDeps({
    configManager: { loadConfig: async () => { throw new Error('config.json 损坏'); }, getRecentDirectories: async () => { throw new Error('读不到'); } },
  });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  const state = await snap.refreshAll({ force: true });
  assert.equal(state.sections.length, 7);
  assert.equal(state.sections.find(s => s.id === 'commands').summary, '共 0 条');
  assert.equal(state.sections.find(s => s.id === 'tasks').ok, true);
});

test('陈旧文件清理:目录里不属于任何已知板块的 .md 会被删掉，非 .md 一律不碰', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'legacy-section.md'), '上一个版本留下的板块文件');
  await fs.writeFile(path.join(dir, 'notes.txt'), '用户自己的东西');

  const { deps } = makeDeps();
  await createAiContextSnapshotter({ ...deps, dir }).refreshAll({ force: true });

  const left = (await fs.readdir(dir)).sort();
  assert.ok(!left.includes('legacy-section.md'), '陈旧板块文件应被清掉');
  assert.ok(left.includes('notes.txt'), '非 .md 不碰');
  assert.ok(left.includes(INDEX_FILE));
});

test('invalidate:可以只失效某一个板块，其余保持已采集', async () => {
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  assert.equal(snap.getState().sections.every(s => s.fresh), true);

  snap.invalidate(['github']);
  const state = snap.getState();
  assert.equal(state.sections.find(s => s.id === 'github').fresh, false);
  assert.equal(state.sections.find(s => s.id === 'git').fresh, true);

  clock += 1;
  await snap.refreshAll({ force: true });
  assert.equal(calls.github, 2, '失效的板块应重跑');
});

test('invalidate:不传参数时全部失效', async () => {
  const dir = await tmpDir();
  const { deps } = makeDeps();
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  snap.invalidate();
  assert.equal(snap.getState().sections.every(s => s.collectedAt === null), true);
  assert.equal(await snap.getSnapshot(), null, '全失效后没有旧的可回');
});

/** 轮询等待某个条件成立（后台刷新是 fire-and-forget，只能等） */
async function waitFor(fn, timeoutMs = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

test('getSectionResult:原样取某块缓存（含结构化 data），且**不**触发其它板块的后台刷新', async () => {
  // 这条守的是 envContext 那条链路：派发任务时只要 tasks 板块，
  // 没理由因此去拉 gh/gitee。对比 getSnapshot() —— 它会把过期的板块全推去后台刷。
  const dir = await tmpDir();
  let clock = 1000;
  const { deps, calls } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshSections(['tasks'], { force: true });
  assert.equal(calls.github, 0, '只刷 tasks 不该联网');
  assert.equal(calls.git, 0, '只刷 tasks 也不该探 git');

  const tasks = snap.getSectionResult('tasks');
  assert.ok(tasks, 'tasks 板块应当能在缓存里取到');
  assert.equal(tasks.ok, true);
  assert.ok(tasks.data, 'tasks 板块必须带结构化 data（envContext 的唯一数据来源）');
  assert.equal(tasks.data.total.total, 1);
  assert.equal(snap.getSectionResult('git'), null, '没采过的板块回 null');
  assert.equal(snap.getSectionResult('不存在'), null);

  // 把时间推到所有板块都过期，再调 getSectionResult：不该有任何后台刷新被触发
  clock += 10 * 60_000;
  snap.getSectionResult('tasks');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls.git, 0, 'getSectionResult 是纯读，不该顺手补刷别的板块');
  assert.equal(calls.github, 0);

  // 反证：同一时刻 getSnapshot 会去后台补刷过期的板块（这正是两者的区别）
  await snap.getSnapshot();
  assert.ok(await waitFor(() => calls.git >= 1), 'getSnapshot 应当把过期的 git 推去后台刷新');
});

test('getState:报出每个板块的采集时间、年龄、新鲜度与摘要', async () => {
  const dir = await tmpDir();
  let clock = 1_000_000;
  const { deps } = makeDeps({ now: () => clock });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  await snap.refreshAll({ force: true });
  clock += 5000;
  const state = snap.getState();

  assert.equal(state.sections.length, 7);
  const git = state.sections.find(s => s.id === 'git');
  assert.equal(git.file, 'git-current.md');
  assert.equal(git.ageMs, 5000);
  assert.equal(git.fresh, true, 'git ttl 15s，5 秒后仍新鲜');
  assert.equal(git.ok, true);
  assert.match(git.summary, /分支 main/);
  assert.ok(git.ttlMs > 0);
  assert.ok(state.persistedAt);
});

test('全部板块失败:仍然返回一份完整快照（七块都写明取不到），不是空壳', async () => {
  const dir = await tmpDir();
  const { deps } = makeDeps({
    probeGit: async () => { throw new Error('boom'); },
    loadRemoteReposState: async () => { throw new Error('boom'); },
    readTasks: async () => { throw new Error('boom'); },
    readJobs: async () => { throw new Error('boom'); },
    getMonitorOverview: async () => { throw new Error('boom'); },
    listPorts: async () => { throw new Error('boom'); },
    listMindmapFiles: async () => { throw new Error('boom'); },
  });
  const snap = createAiContextSnapshotter({ ...deps, dir });

  const state = await snap.refreshAll({ force: true });
  assert.equal(state.sections.length, 7);
  assert.equal(state.sections.find(s => s.id === 'git').ok, false);
  // 自定义命令读的是配置（这里正常），所以它是七块里唯一成功的
  assert.equal(state.sections.find(s => s.id === 'commands').ok, true);
  assert.equal(state.sections.filter(s => !s.ok).length, 6);
});
