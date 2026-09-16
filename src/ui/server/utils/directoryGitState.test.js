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
  normalizeDirKey,
  probeDirectoryGitState,
  probeDirectoryGitStates,
  clearGitStateCache,
} from './directoryGitState.js';

const execFileAsync = promisify(execFile);
const git = (args, cwd) => execFileAsync('git', args, { cwd, windowsHide: true });

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

test('probeDirectoryGitStates: 结果按调用方原始路径字符串为键,重复路径只探一次', async () => {
  clearGitStateCache();
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
