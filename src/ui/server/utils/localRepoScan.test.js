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
// 全盘仓库扫描 单元测试(node:test 内置)。
//
// 手法参照 directoryGitState.test.js:临时目录造真实文件树 + 真跑 git。
// **不扫真实磁盘**:所有用例都显式传 roots 指到临时目录,唯一走 listDrives() 的
// 用例只断言"返回值形状"(本机有几个盘无所谓)。
//
// 缓存必须指到临时文件:否则会写进用户真实的 ~/.zen-gitsync/local-repos.json,
// 用真实数据覆盖掉,还会让后一个用例读到前一个的残留。见 cacheFilePath()。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// env 必须在 import 模块前设好 —— 不为别的,是为了万一将来有人把 cacheFilePath
// 改成模块级常量时不至于悄悄写进用户家目录。
const CACHE_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), 'zen-localrepos-cache-'));
process.env.ZEN_LOCAL_REPOS_CACHE = path.join(CACHE_DIR, 'local-repos.json');

const {
  listDrives,
  walkGitDirs,
  refreshLocalRepos,
  getLocalRepos,
  rememberRepo,
  resetLocalRepoScan,
  CACHE_TTL_MS,
} = await import('./localRepoScan.js');

const git = (args, cwd) => execFileAsync('git', args, { cwd, windowsHide: true });

/** 造一个「像仓库」的目录:有 .git 就够了,walkGitDirs 不看内容 */
async function fakeRepo(dir) {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
}

/** 造一个真仓库(带真实 git 元数据,给读 origin 的用例用) */
async function realRepo(dir, originUrl) {
  await fs.mkdir(dir, { recursive: true });
  await git(['init', '-q'], dir);
  if (originUrl) await git(['remote', 'add', 'origin', originUrl], dir);
}

/** 临时根目录。每个用例一个,互不干扰 */
const makeRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'zen-scan-'));

/** 清缓存文件,让"首次运行"这一前提在每个用例里都成立 */
async function clearCacheFile() {
  await fs.rm(process.env.ZEN_LOCAL_REPOS_CACHE, { force: true });
  resetLocalRepoScan();
}

/** 轮询到条件成立(或超时),给"等后台那一趟扫描收尾"用 */
async function waitUntil(fn, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('waitUntil 超时');
}

after(async () => {
  await fs.rm(CACHE_DIR, { recursive: true, force: true });
});

// ── listDrives ───────────────────────────────────────────────────────────

test('listDrives: 只回存在的盘符,格式是 X:/', () => {
  const drives = listDrives();
  assert.ok(Array.isArray(drives));
  // 跑测试的机器至少有一个盘;不存在的软驱/空光驱被 accessSync 挡掉
  assert.ok(drives.length > 0, '至少应有一个盘符');
  for (const d of drives) assert.match(d, /^[A-Z]:\/$/);
  // 同一个盘不会出现两次
  assert.equal(new Set(drives).size, drives.length);
});

// ── walkGitDirs:纯遍历 ───────────────────────────────────────────────────

test('walkGitDirs: 找出各级仓库;仓库内部不再下探;跳过名单与 $-前缀不进入', async () => {
  const root = await makeRoot();
  try {
    await fakeRepo(path.join(root, 'a-project'));
    await fakeRepo(path.join(root, 'b-project'));
    // 三层深度的仓库也要找到
    await fakeRepo(path.join(root, 'nested', 'deep', 'c-project'));
    // 普通目录不产生"仓库"
    await fs.mkdir(path.join(root, 'plain', 'just-files'), { recursive: true });

    // 外层是仓库 → 内层的仓库不该被当成独立仓库(否则一个 monorepo 会刷出一堆重复)
    await fakeRepo(path.join(root, 'outer'));
    await fakeRepo(path.join(root, 'outer', 'inner'));

    // 跳过名单 / $ 前缀:目录真的存在,但一律不下探
    await fakeRepo(path.join(root, 'node_modules', 'fake'));
    await fakeRepo(path.join(root, '$RECYCLE.BIN', 'fake'));
    await fakeRepo(path.join(root, 'temp', 'fake'));

    const { dirs, scannedDirs, truncated } = await walkGitDirs({ roots: [root] });
    const names = dirs.map(d => path.relative(root, d).split(path.sep).join('/')).sort();

    assert.deepEqual(names, ['a-project', 'b-project', 'nested/deep/c-project', 'outer']);
    assert.equal(truncated, false);
    // 扫过的目录数 = 实际 readdir 过的目录数,用来给界面报进度
    assert.ok(scannedDirs > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkGitDirs: .git 是文件也算仓库(git worktree 出来的工作区)', async () => {
  const root = await makeRoot();
  try {
    const wt = path.join(root, 'wt-repo');
    await fs.mkdir(wt, { recursive: true });
    // worktree 里 .git 是指向主仓 gitdir 的文件,不是目录
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: /somewhere/.git/worktrees/wt\n');

    const { dirs } = await walkGitDirs({ roots: [root] });
    assert.deepEqual(dirs, [wt]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkGitDirs: 超预算就提前收工并标记 truncated,不抛错', async () => {
  const root = await makeRoot();
  try {
    await fakeRepo(path.join(root, 'a-project'));
    // 负预算 = 第一轮 worker 就发现已过期(死线算不出来,只能靠负值保证确定性)
    const { dirs, truncated } = await walkGitDirs({ roots: [root], budgetMs: -1 });
    assert.equal(truncated, true);
    assert.deepEqual(dirs, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('walkGitDirs: 根目录不存在也不抛错(空光驱 / 刚被拔掉的移动盘)', async () => {
  const { dirs, truncated } = await walkGitDirs({ roots: [path.join(os.tmpdir(), 'zen-scan-ghost-xyz')] });
  assert.deepEqual(dirs, []);
  assert.equal(truncated, false);
});

// ── refreshLocalRepos:遍历 + 读 origin + 落盘 ─────────────────────────────

test('refreshLocalRepos: 只收有 origin 的仓库,key 是仓库目录原样', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    const withOrigin = path.join(root, 'has-origin');
    const noOrigin = path.join(root, 'local-only');
    await realRepo(withOrigin, 'https://gitee.com/xz_web/xiangqi.git');
    await realRepo(noOrigin); // 本地 init、没 remote:对「已克隆」没有信息量

    const snap = await refreshLocalRepos({ roots: [root] });

    assert.equal(snap.scanning, false);
    assert.deepEqual(Object.keys(snap.repos), [withOrigin]);
    assert.equal(snap.repos[withOrigin], 'https://gitee.com/xz_web/xiangqi.git');
    assert.deepEqual(snap.roots, [root]);
    assert.ok(snap.scannedAt > 0);
    assert.equal(snap.error, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('refreshLocalRepos: 同一时刻只有一个扫描在跑,并发调用复用同一个 Promise', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    await realRepo(path.join(root, 'has-origin'), 'git@github.com:xz333221/zen-gitsync.git');

    const [a, b] = await Promise.all([refreshLocalRepos({ roots: [root] }), refreshLocalRepos({ roots: [root] })]);
    // 同一个 Promise → 同一个对象;若各扫一遍会得到两个不同的 snapshot 对象
    assert.equal(a, b);
    assert.equal(Object.keys(a.repos).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── getLocalRepos:永不阻塞 ───────────────────────────────────────────────

test('getLocalRepos: 有新鲜缓存时直接回,不触发重扫', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    const repo = path.join(root, 'has-origin');
    await realRepo(repo, 'https://gitee.com/xz_web/xiangqi.git');
    await refreshLocalRepos({ roots: [root] });

    const snap = await getLocalRepos({ ttlMs: CACHE_TTL_MS });
    assert.equal(snap.scanning, false);
    assert.equal(snap.repos[repo], 'https://gitee.com/xz_web/xiangqi.git');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('getLocalRepos: 缓存过期时仍在后台重扫 —— 本次调用立刻拿到旧快照', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    const repo = path.join(root, 'has-origin');
    await realRepo(repo, 'https://gitee.com/xz_web/xiangqi.git');
    await refreshLocalRepos({ roots: [root] });

    // ttlMs:0 → 视为过期,于是本次调用会 void 触发一次重扫。关键断言是
    // **不 await 它**:返回时状态已经是 scanning,但 repos 里旧数据还在。
    // 传 roots 是为了让那一趟后台重扫只走临时目录(不传就真去遍历全盘)。
    const snap = await getLocalRepos({ ttlMs: 0, roots: [root] });
    assert.equal(snap.scanning, true, '重扫应在后台进行,被调用方看到的就是 scanning');
    assert.equal(snap.repos[repo], 'https://gitee.com/xz_web/xiangqi.git', '旧快照不能被清空');

    // 等后台那一趟收尾,免得它跨到下一个用例里去写缓存
    await waitUntil(async () => !(await getLocalRepos({ ttlMs: CACHE_TTL_MS })).scanning);
    const after = await getLocalRepos({ ttlMs: CACHE_TTL_MS });
    assert.equal(after.repos[repo], 'https://gitee.com/xz_web/xiangqi.git');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── rememberRepo:克隆后就地登记 ──────────────────────────────────────────

test('rememberRepo: 立刻进快照并落盘,不覆盖缓存里已有的其它仓库', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    const existing = path.join(root, 'has-origin');
    await realRepo(existing, 'https://gitee.com/xz_web/xiangqi.git');
    await refreshLocalRepos({ roots: [root] });

    // 模拟"用户刚 clone 到另一个目录":那个目录还没被扫到
    const fresh = path.join(root, 'just-cloned');
    await fs.mkdir(fresh, { recursive: true });
    await rememberRepo(fresh, 'git@github.com:xz333221/zen-gitsync.git');

    const snap = await getLocalRepos({ ttlMs: CACHE_TTL_MS });
    assert.equal(snap.repos[fresh], 'git@github.com:xz333221/zen-gitsync.git');
    assert.equal(snap.repos[existing], 'https://gitee.com/xz_web/xiangqi.git', '旧记录必须还在');

    // 落盘了 → 服务重启后徽标依然是亮的(读文件而不是读内存)
    const raw = JSON.parse(await fs.readFile(process.env.ZEN_LOCAL_REPOS_CACHE, 'utf8'));
    assert.equal(raw.repos[fresh], 'git@github.com:xz333221/zen-gitsync.git');
    assert.equal(raw.repos[existing], 'https://gitee.com/xz_web/xiangqi.git');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rememberRepo: 空目录 / 空地址直接忽略,不写坏缓存', async () => {
  await clearCacheFile();
  const root = await makeRoot();
  try {
    // 先扫一个空目录把状态置成"新鲜" —— 否则下面的 getLocalRepos 会因为
    // "没有缓存"去后台触发一次全盘扫描,测试就跑到真实磁盘上去了。
    await refreshLocalRepos({ roots: [root] });

    await rememberRepo('', 'git@github.com:x/y.git');
    await rememberRepo('D:/tmp/x', '');
    await rememberRepo('   ', '   ');

    const snap = await getLocalRepos({ ttlMs: CACHE_TTL_MS });
    assert.deepEqual(snap.repos, {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
