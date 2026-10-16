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
// 「推荐添加的项目」扫描的回归测试。
//
// 守三件事：
//   1. isIgnoredDirName —— 构建产物 / 依赖 / 系统目录 / 点目录都不进候选；
//      大小写不敏感（Windows 上 `Node_Modules` 与 `node_modules` 是同一个东西）。
//   2. buildRecommendRoots —— roots 取的是**父目录**（找的是"旁边的仓库"）、
//      去重、拒盘根（否则等于全盘扫描）、当前项目的父目录排第一。
//   3. scanRecommendedProjects —— 只认含 .git 的目录、已在清单里的不推荐、
//      用户显式移除过的不推荐回来、**只下一层**、忽略名单生效、按 mtime 倒序、
//      预算到了会停（不会因为某个 root 特别大而把磁盘读爆）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_ROOTS,
  buildRecommendRoots,
  isIgnoredDirName,
  scanRecommendedProjects,
} from './projectRecommend.js';

// ── isIgnoredDirName ──────────────────────────────────────────────────────

test('isIgnoredDirName: 依赖 / 构建产物 / 点目录 / 系统目录一律跳过', () => {
  for (const name of ['node_modules', 'dist', 'build', 'target', '__pycache__',
    '.git', '.cache', '.next', 'AppData', '$Recycle.Bin', 'System Volume Information',
    'Program Files (x86)', 'windows']) {
    assert.equal(isIgnoredDirName(name), true, `${name} 应当被跳过`);
  }
});

test('isIgnoredDirName: 大小写不敏感,普通目录名放行', () => {
  assert.equal(isIgnoredDirName('Node_Modules'), true);
  assert.equal(isIgnoredDirName('DIST'), true);
  assert.equal(isIgnoredDirName('zen-gitsync'), false);
  assert.equal(isIgnoredDirName('my-project'), false);
  assert.equal(isIgnoredDirName(''), true);
  assert.equal(isIgnoredDirName(null), true);
});

// ── buildRecommendRoots ───────────────────────────────────────────────────

test('buildRecommendRoots: 取父目录、去重、当前项目父目录排第一', () => {
  // 用真实绝对路径铺夹具（跨平台成立），而不是写死 `d:\...`
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-recommend-roots-'));
  const roots = buildRecommendRoots([
    path.join(base, 'ws', 'a', 'p1'),
    path.join(base, 'ws', 'a', 'p2'),
    path.join(base, 'ws', 'b', 'p3'),
  ], path.join(base, 'ws', 'b', 'p3'));

  // 当前项目父目录（ws/b）第一；ws/a 把两个项目收敛成一条
  assert.equal(roots[0], path.join(base, 'ws', 'b'));
  assert.deepEqual(roots.slice(1), [path.join(base, 'ws', 'a')]);
  assert.ok(roots.length <= MAX_ROOTS);
});

test('buildRecommendRoots: 盘根被拒(扫它等于全盘),相对路径也没有意义', () => {
  // 盘根的父目录还是它自己（Windows 的 `d:\`、POSIX 的 `/`）—— 不能当扫描根
  assert.deepEqual(buildRecommendRoots([path.parse(process.cwd()).root]), []);
  // 相对路径 dirname 收敛到 '.'，同样不产出 root
  assert.deepEqual(buildRecommendRoots(['foo', './bar']), []);
});

test('buildRecommendRoots: 不同父目录各自成根,条数封顶', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-recommend-cap-'));
  const many = Array.from({ length: 20 }, (_, i) => path.join(base, `p${i}`, `repo${i}`));
  const roots = buildRecommendRoots(many);
  assert.equal(roots.length, MAX_ROOTS);
  assert.ok(roots.every(r => r.startsWith(base)));
});

// ── scanRecommendedProjects ───────────────────────────────────────────────

/** 铺一棵真实的目录树：只要 .git 存在就算仓库（不跑 git 命令，与实现同口径） */
function makeTree(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-recommend-'));
  for (const [rel, kind] of Object.entries(layout)) {
    const full = path.join(root, rel);
    if (kind === 'file') {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x', 'utf8');
    } else {
      fs.mkdirSync(full, { recursive: true });
    }
  }
  return root;
}

test('scanRecommendedProjects: 只认含 .git 的目录,清单里/忽略名单里的都排除', async () => {
  const root = makeTree({
    'alpha/.git': 'dir',
    'beta/.git': 'dir',            // 已在清单里
    'gamma/.git': 'dir',           // 用户显式移除过
    'delta/readme.md': 'file',     // 没有 .git
    'node_modules/dep/.git': 'dir', // 依赖目录里的残留，不该推荐
    '.hidden/.git': 'dir',         // 点目录
  });

  const found = await scanRecommendedProjects({
    roots: [root],
    knownKeys: new Set([path.join(root, 'beta')]),
    hiddenKeys: new Set([path.join(root, 'gamma')]),
  });

  assert.deepEqual(found.map(f => f.name).sort(), ['alpha']);
  assert.equal(found[0].path, path.join(root, 'alpha'));
  assert.ok(found[0].mtime > 0, 'mtime 用于排序，应当是真实值');
});

test('scanRecommendedProjects: 只下一层,嵌套两层的仓库不进来', async () => {
  const root = makeTree({
    'alpha/.git': 'dir',
    'alpha/nested-repo/.git': 'dir',   // 第二层：不扫
    'alpha/vendor-app/src': 'dir',
  });

  const found = await scanRecommendedProjects({ roots: [root], knownKeys: new Set() });
  assert.deepEqual(found.map(f => f.name), ['alpha']);
});

test('scanRecommendedProjects: 按 mtime 倒序(最近动过的排前面)', async () => {
  const root = makeTree({
    'older/.git': 'dir',
    'newer/.git': 'dir',
  });
  const past = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(root, 'older'), past, past);

  const found = await scanRecommendedProjects({ roots: [root], knownKeys: new Set() });
  assert.deepEqual(found.map(f => f.name), ['newer', 'older']);
});

test('scanRecommendedProjects: 目录总量预算到了就停,不会把磁盘读爆', async () => {
  const layout = {};
  for (let i = 0; i < 30; i++) layout[`repo-${String(i).padStart(2, '0')}/.git`] = 'dir';
  const root = makeTree(layout);

  const found = await scanRecommendedProjects({
    roots: [root],
    knownKeys: new Set(),
    maxDirs: 5,
  });
  assert.ok(found.length <= 5, `预算 5 个目录时不该扫出 ${found.length} 条`);
});

test('scanRecommendedProjects: 读不动的 root 当空目录,不影响其它 root', async () => {
  const root = makeTree({ 'alpha/.git': 'dir' });
  const found = await scanRecommendedProjects({
    roots: [path.join(root, 'does-not-exist'), root],
    knownKeys: new Set(),
  });
  assert.deepEqual(found.map(f => f.name), ['alpha']);
});

test('scanRecommendedProjects: 结果条数封顶 50', async () => {
  const layout = {};
  for (let i = 0; i < 60; i++) layout[`r${String(i).padStart(3, '0')}/.git`] = 'dir';
  const root = makeTree(layout);

  const found = await scanRecommendedProjects({ roots: [root], knownKeys: new Set() });
  assert.equal(found.length, 50);
});
