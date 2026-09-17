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
// 目录 Git 状态探测 单元测试(node:test 内置)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parsePorcelainStatus,
  parseBranchTracking,
  normalizeDirKey,
  probeDirectoryGitState,
  probeDirectoryGitStates,
  clearGitStateCache,
} from './directoryGitState.js';

const execFileAsync = promisify(execFile);
const git = (args, cwd) => execFileAsync('git', args, { cwd, windowsHide: true });
// 提交必须显式给身份并关掉签名,否则依赖开发机的全局 git 配置 → CI 上必挂
const gitCommit = (dir, msg) => git([
  '-c', 'user.name=zen-test',
  '-c', 'user.email=zen-test@example.invalid',
  '-c', 'commit.gpgsign=false',
  'commit', '-q', '-m', msg,
], dir);
// 本地路径当 remote 时统一成正斜杠,免得 Windows 反斜杠被当转义
const asRemote = p => p.replace(/\\/g, '/');

// ── 纯函数:porcelain 解析 ────────────────────────────────────────────────
test('parsePorcelainStatus: 空输入返回全零', () => {
  assert.deepEqual(parsePorcelainStatus(''), { changed: 0, staged: 0, unstaged: 0, untracked: 0 });
  assert.deepEqual(parsePorcelainStatus(undefined), { changed: 0, staged: 0, unstaged: 0, untracked: 0 });
});

test('parsePorcelainStatus: 分别统计已暂存 / 未暂存 / 未跟踪', () => {
  const out = [
    ' M src/a.js',      // 工作区改动
    'M  src/b.js',      // 已暂存
    '?? notes.txt',     // 未跟踪
    'A  src/c.js',      // 新文件已暂存
  ].join('\n');
  const r = parsePorcelainStatus(out);
  assert.equal(r.staged, 2);
  assert.equal(r.unstaged, 1);
  assert.equal(r.untracked, 1);
  assert.equal(r.changed, 4);
});

test('parsePorcelainStatus: 同一文件既暂存又改动(MM)只算 1 项,但两边各计一次', () => {
  const r = parsePorcelainStatus('MM src/both.js');
  assert.equal(r.changed, 1, 'changed 按条目数,不能重复计数');
  assert.equal(r.staged, 1);
  assert.equal(r.unstaged, 1);
});

test('parsePorcelainStatus: 冲突(UU)两侧都计数,条目仍为 1', () => {
  const r = parsePorcelainStatus('UU src/conflict.js');
  assert.equal(r.changed, 1);
  assert.equal(r.staged, 1);
  assert.equal(r.unstaged, 1);
});

test('parsePorcelainStatus: 重命名算 1 项(已暂存)', () => {
  const r = parsePorcelainStatus('R  old.js -> new.js');
  assert.equal(r.changed, 1);
  assert.equal(r.staged, 1);
  assert.equal(r.unstaged, 0);
});

test('parsePorcelainStatus: 忽略条目(!!)与 CRLF / 空行不计数', () => {
  const out = '!! dist/bundle.js\r\n\r\n M a.js\r\n';
  const r = parsePorcelainStatus(out);
  assert.equal(r.changed, 1);
  assert.equal(r.unstaged, 1);
});

// 回归:加了 --branch 之后 `## main...origin/main` 会出现在输出首行。
// 它的前两个字符是 `#`,既不是 `!!` 也不是 `??`,漏判就会被算成
// 1 个"已暂存 + 未暂存"的文件 —— 于是"干净仓库"凭空多出 1 项未提交。
test('parsePorcelainStatus: 分支头(##)不计入改动', () => {
  const withHeader = parsePorcelainStatus('## main...origin/main [ahead 1, behind 2]\n M a.js');
  assert.equal(withHeader.changed, 1, '只有真实改动那条才算');
  assert.equal(withHeader.staged, 0);
  assert.equal(withHeader.unstaged, 1);

  const cleanWithHeader = parsePorcelainStatus('## main...origin/main');
  assert.deepEqual(cleanWithHeader, { changed: 0, staged: 0, unstaged: 0, untracked: 0 });
});

// ── 纯函数:分支头解析 ────────────────────────────────────────────────────
test('parseBranchTracking: 有上游且有领先/落后', () => {
  assert.deepEqual(parseBranchTracking('## main...origin/main [ahead 1, behind 2]'), {
    branch: 'main', upstream: 'origin/main', hasUpstream: true, detached: false, ahead: 1, behind: 2,
  });
  assert.deepEqual(parseBranchTracking('## develop...origin/develop [behind 17]'), {
    branch: 'develop', upstream: 'origin/develop', hasUpstream: true, detached: false, ahead: 0, behind: 17,
  });
  assert.deepEqual(parseBranchTracking('## main...origin/main [ahead 3]'), {
    branch: 'main', upstream: 'origin/main', hasUpstream: true, detached: false, ahead: 3, behind: 0,
  });
});

test('parseBranchTracking: 有上游但已同步 → 全零', () => {
  const r = parseBranchTracking('## main...origin/main');
  assert.equal(r.hasUpstream, true);
  assert.equal(r.upstream, 'origin/main');
  assert.equal(r.ahead, 0);
  assert.equal(r.behind, 0);
});

test('parseBranchTracking: 没设上游 → hasUpstream=false 且不带上游名', () => {
  const r = parseBranchTracking('## feature/foo-bar');
  assert.equal(r.branch, 'feature/foo-bar', '带斜杠/短横线的分支名要完整保留');
  assert.equal(r.upstream, null);
  assert.equal(r.hasUpstream, false);
  assert.equal(r.ahead, 0);
  assert.equal(r.behind, 0);
});

test('parseBranchTracking: 上游被删([gone])不算有上游', () => {
  const r = parseBranchTracking('## main...origin/main [gone]');
  assert.equal(r.branch, 'main');
  assert.equal(r.hasUpstream, false);
  assert.equal(r.ahead, 0);
  assert.equal(r.behind, 0);
});

test('parseBranchTracking: 分离 HEAD 与空仓库', () => {
  const detached = parseBranchTracking('## HEAD (no branch)');
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.hasUpstream, false);

  assert.equal(parseBranchTracking('## No commits yet on main').branch, 'main');
  assert.equal(parseBranchTracking('## Initial commit on trunk').branch, 'trunk');
});

test('parseBranchTracking: 无分支头 / 空输入 → 中性零值,不抛错', () => {
  for (const input of ['', undefined, null, ' M a.js\n?? b.txt']) {
    assert.deepEqual(parseBranchTracking(input), {
      branch: null, upstream: null, hasUpstream: false, detached: false, ahead: 0, behind: 0,
    });
  }
});

test('normalizeDirKey: Windows 大小写 / 斜杠 / 尾斜杠写法归一', () => {
  const a = normalizeDirKey('D:\\Workspace\\Proj\\');
  const b = normalizeDirKey('d:/workspace/proj');
  assert.equal(a, b);
});

// ── 真实文件系统 + git 进程 ────────────────────────────────────────────────
test('probeDirectoryGitState: 不存在的目录 → exists=false', async () => {
  const missing = path.join(os.tmpdir(), 'zen-gitsync-not-exist-' + Date.now());
  const state = await probeDirectoryGitState(missing);
  assert.equal(state.exists, false);
  assert.equal(state.isGitRepo, false);
});

test('probeDirectoryGitState: 普通目录 → exists=true 且 isGitRepo=false', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-plain-'));
  try {
    const state = await probeDirectoryGitState(dir);
    assert.equal(state.exists, true);
    assert.equal(state.isGitRepo, false);
    assert.equal(state.changed, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeDirectoryGitState: 真实仓库 → 干净 0 项,加文件后计数递增', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-repo-'));
  try {
    await git(['init', '-q'], dir);
    const clean = await probeDirectoryGitState(dir);
    assert.equal(clean.isGitRepo, true);
    assert.equal(clean.changed, 0);

    await fs.writeFile(path.join(dir, 'new-file.txt'), 'hello\n');
    const untracked = await probeDirectoryGitState(dir);
    assert.equal(untracked.isGitRepo, true);
    assert.equal(untracked.changed, 1);
    assert.equal(untracked.untracked, 1);

    await git(['add', 'new-file.txt'], dir);
    const staged = await probeDirectoryGitState(dir);
    assert.equal(staged.staged, 1);
    assert.equal(staged.changed, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 端到端验证 --branch 真的生效、领先/落后数字是真的:
// 建一个裸仓库当远端,克隆两个副本,一个本地提交(领先)、另一个提交后推送再 fetch(落后)。
test('probeDirectoryGitState: 真实远端 → 读出上游分支与领先/落后', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-track-'));
  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const workDir = path.join(root, 'work');
  const otherDir = path.join(root, 'other');
  try {
    // 1) 造一个已有 main 的裸远端(空裸仓库克隆出来没有上游,必须先有提交)
    await git(['init', '-q', '--bare', '-b', 'main', originDir], root);
    await git(['init', '-q', '-b', 'main', seedDir], root);
    await fs.writeFile(path.join(seedDir, 'README.md'), 'seed\n');
    await git(['add', '.'], seedDir);
    await gitCommit(seedDir, 'init');
    await git(['remote', 'add', 'origin', asRemote(originDir)], seedDir);
    await git(['push', '-q', '-u', 'origin', 'main'], seedDir);

    // 2) 克隆出来就自带上游,且与远端同步
    await git(['clone', '-q', asRemote(originDir), workDir], root);
    const synced = await probeDirectoryGitState(workDir);
    assert.equal(synced.isGitRepo, true);
    assert.equal(synced.hasUpstream, true);
    assert.equal(synced.upstream, 'origin/main');
    assert.equal(synced.branch, 'main');
    assert.equal(synced.ahead, 0);
    assert.equal(synced.behind, 0);
    assert.equal(synced.changed, 0, '同步且干净时不能凭空多出改动(分支头误计的回归)');

    // 3) 本地提交 → 领先 1
    await fs.writeFile(path.join(workDir, 'local.txt'), 'local\n');
    await git(['add', '.'], workDir);
    await gitCommit(workDir, 'local work');
    const ahead = await probeDirectoryGitState(workDir);
    assert.equal(ahead.ahead, 1);
    assert.equal(ahead.behind, 0);
    assert.equal(ahead.changed, 0, '提交后工作区应该是干净的');

    // 4) 另一个人推了新提交,再 fetch → 同时领先 1 / 落后 1
    await git(['clone', '-q', asRemote(originDir), otherDir], root);
    await fs.writeFile(path.join(otherDir, 'remote.txt'), 'remote\n');
    await git(['add', '.'], otherDir);
    await gitCommit(otherDir, 'remote work');
    await git(['push', '-q'], otherDir);
    await git(['fetch', '-q', 'origin'], workDir);

    const diverged = await probeDirectoryGitState(workDir);
    assert.equal(diverged.ahead, 1);
    assert.equal(diverged.behind, 1);
    assert.equal(diverged.hasUpstream, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('probeDirectoryGitStates: 结果按调用方原始路径字符串为键,重复路径只探一次', async () => {  clearGitStateCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-batch-'));
  try {
    await git(['init', '-q'], dir);
    const results = await probeDirectoryGitStates([dir, dir, 'not-a-real-path-xyz'], { useCache: false });
    assert.deepEqual(Object.keys(results).sort(), [dir, 'not-a-real-path-xyz'].sort());
    assert.equal(results[dir].isGitRepo, true);
    assert.equal(results['not-a-real-path-xyz'].exists, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('probeDirectoryGitStates: 命中缓存时不重新扫盘,useCache:false 可绕过', async () => {
  clearGitStateCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cache-'));
  try {
    await git(['init', '-q'], dir);
    const first = await probeDirectoryGitStates([dir]);
    assert.equal(first[dir].changed, 0);

    // 缓存期内新增文件,结果应仍是缓存的旧值
    await fs.writeFile(path.join(dir, 'later.txt'), 'x\n');
    const cached = await probeDirectoryGitStates([dir]);
    assert.equal(cached[dir].changed, 0, 'TTL 内应命中缓存');

    const fresh = await probeDirectoryGitStates([dir], { useCache: false });
    assert.equal(fresh[dir].changed, 1, 'useCache:false 必须重新探测');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
