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
// 单目录 fetch 单元测试(node:test 内置)。
//
// 最重要的一条是"真实远端"那组:先复现列表误报的现象(远端有新提交,但本地
// remote-tracking 引用还没更新 → 探测出的 behind 仍是 0),再证明 fetch 之后
// 能读到真实落后数 —— 这正是「刷新全部」按钮存在的理由,退化回去必须报红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  fetchDirectoryRemotes,
  buildFetchEnv,
  firstErrorLine,
  isNotARepoMessage,
  describeFetchError,
  clearFetchInFlight,
  DEFAULT_FETCH_TIMEOUT_MS,
  FETCH_STATUS,
  SKIP_REASON,
} from './directoryFetch.js';
import { probeDirectoryGitState } from './directoryGitState.js';

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

// ── 纯函数 ──────────────────────────────────────────────────────────────
test('buildFetchEnv: 关掉交互式凭据提示,且不覆盖用户自己的 GIT_SSH_COMMAND', () => {
  const withOwn = buildFetchEnv({ PATH: '/usr/bin', GIT_SSH_COMMAND: 'ssh -i /my/key' });
  assert.equal(withOwn.GIT_TERMINAL_PROMPT, '0', '批量刷新绝不能停在终端等输密码');
  assert.equal(withOwn.GIT_SSH_COMMAND, 'ssh -i /my/key', '用户自己的 ssh 配置不能被顶掉');
  assert.equal(withOwn.PATH, '/usr/bin', '原有环境变量要带过去');
  assert.match(withOwn.GIT_CONFIG_PARAMETERS, /core\.quotepath=false/);

  const injected = buildFetchEnv({ PATH: '/usr/bin' });
  assert.match(injected.GIT_SSH_COMMAND, /BatchMode=yes/, 'ssh 的 passphrase 提示也要变成明确报错');
});

test('isNotARepoMessage: 认得 git 的两种措辞', () => {
  assert.equal(isNotARepoMessage('fatal: not a git repository (or any of the parent directories): .git'), true);
  assert.equal(isNotARepoMessage('fatal: not a git repo'), true);
  assert.equal(isNotARepoMessage('fatal: unable to access ... Could not resolve host'), false);
  assert.equal(isNotARepoMessage(''), false);
  assert.equal(isNotARepoMessage(undefined), false);
});

test('firstErrorLine: 跳过空行与 \\r 进度条,并截断过长内容', () => {
  assert.equal(firstErrorLine('Receiving objects: 1%\rReceiving objects: 50%\r\n\nfatal: boom\nsecond line'), 'Receiving objects: 1%');
  assert.equal(firstErrorLine('', 10), '');
  const long = firstErrorLine('x'.repeat(500), 20);
  assert.equal(long.length, 21, '20 个字符 + 省略号');
  assert.ok(long.endsWith('…'));
});

test('describeFetchError: 超时被单独标出来(前端据此换成中文文案)', () => {
  const timedOut = describeFetchError({ killed: true, signal: 'SIGTERM', stderr: '' }, 30000);
  assert.equal(timedOut.timeout, true);
  assert.match(timedOut.error, /30s/);

  const netFail = describeFetchError({ stderr: 'fatal: unable to access ...', message: 'Command failed' }, 30000);
  assert.equal(netFail.timeout, undefined);
  assert.equal(netFail.error, 'fatal: unable to access ...');

  // 什么都没有时给一句兜底文案,不能返回空串(tooltip 上会是空的一行)
  assert.equal(describeFetchError({}, 30000).error.length > 0, true);
});

// ── 真实文件系统 + git ───────────────────────────────────────────────────
test('不存在的目录 / 普通目录 → skipped,不抛错也不联网', async () => {
  const missing = path.join(os.tmpdir(), 'zen-fetch-missing-' + Date.now());
  const missingResult = await fetchDirectoryRemotes(missing);
  assert.equal(missingResult.status, FETCH_STATUS.SKIPPED);
  assert.equal(missingResult.reason, SKIP_REASON.MISSING);

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-fetch-plain-'));
  try {
    const plainResult = await fetchDirectoryRemotes(plain);
    assert.equal(plainResult.status, FETCH_STATUS.SKIPPED);
    assert.equal(plainResult.reason, SKIP_REASON.NOT_A_REPO);
  } finally {
    await fs.rm(plain, { recursive: true, force: true });
  }
});

test('空参数 → skipped(missing),不碰文件系统', async () => {
  for (const input of ['', '   ', undefined, null]) {
    const r = await fetchDirectoryRemotes(input);
    assert.equal(r.status, FETCH_STATUS.SKIPPED);
    assert.equal(r.reason, SKIP_REASON.MISSING);
  }
});

test('仓库没配 remote → skipped(no-remote):fetch 无事可做', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-fetch-noremote-'));
  try {
    await git(['init', '-q', '-b', 'main'], dir);
    const r = await fetchDirectoryRemotes(dir);
    assert.equal(r.status, FETCH_STATUS.SKIPPED);
    assert.equal(r.reason, SKIP_REASON.NO_REMOTE);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('远端不可达 → failed 且带一句可读的报错,不抛异常', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-fetch-dead-'));
  try {
    await git(['init', '-q', '-b', 'main'], dir);
    // 指向一个不存在的本地路径:git 会立刻报 "does not appear to be a git repository",
    // 从而稳定地覆盖 failed 分支(不用真实网络,也就不会 flaky)
    await git(['remote', 'add', 'origin', asRemote(path.join(dir, 'nope.git'))], dir);
    const r = await fetchDirectoryRemotes(dir);
    assert.equal(r.status, FETCH_STATUS.FAILED);
    assert.equal(r.timeout, undefined);
    assert.ok(r.error && r.error.length > 0, '必须带回非空的报错文案');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('同一目录并发 fetch → 不出现 FETCH_HEAD.lock 互撞的失败', async () => {
  clearFetchInFlight();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-fetch-race-'));
  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const workDir = path.join(root, 'work');
  try {
    await git(['init', '-q', '--bare', '-b', 'main', originDir], root);
    await git(['init', '-q', '-b', 'main', seedDir], root);
    await fs.writeFile(path.join(seedDir, 'README.md'), 'seed\n');
    await git(['add', '.'], seedDir);
    await gitCommit(seedDir, 'init');
    await git(['remote', 'add', 'origin', asRemote(originDir)], seedDir);
    await git(['push', '-q', '-u', 'origin', 'main'], seedDir);
    await git(['clone', '-q', asRemote(originDir), workDir], root);

    const results = await Promise.all([
      fetchDirectoryRemotes(workDir),
      fetchDirectoryRemotes(workDir),
    ]);
    assert.ok(results.some(r => r.status === FETCH_STATUS.OK), '其中一个应该真的执行了 fetch');
    assert.ok(
      results.every(r => r.status !== FETCH_STATUS.FAILED),
      '并发时必须被 in-flight 拦下,而不是让两个 git 去抢 FETCH_HEAD.lock'
    );
  } finally {
    clearFetchInFlight();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ── 核心回归:按钮存在的理由 ────────────────────────────────────────────────
// 复现"列表看不到真实状态"的现场:别人推了新提交,本地 remote-tracking 引用
// 还停在旧位置 → 探测出的 behind 是 0(列表显示"已同步",其实该 pull 了)。
// fetch 之后必须能读到真实的落后数。
test('真实远端:fetch 之前 behind 滞后,fetch 之后读到真实落后数', async () => {
  clearFetchInFlight();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-fetch-real-'));
  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const workDir = path.join(root, 'work');
  const otherDir = path.join(root, 'other');
  try {
    // 1) 造一个已有 main 的裸远端
    await git(['init', '-q', '--bare', '-b', 'main', originDir], root);
    await git(['init', '-q', '-b', 'main', seedDir], root);
    await fs.writeFile(path.join(seedDir, 'README.md'), 'seed\n');
    await git(['add', '.'], seedDir);
    await gitCommit(seedDir, 'init');
    await git(['remote', 'add', 'origin', asRemote(originDir)], seedDir);
    await git(['push', '-q', '-u', 'origin', 'main'], seedDir);

    // 2) work 克隆出来与远端同步
    await git(['clone', '-q', asRemote(originDir), workDir], root);
    const synced = await probeDirectoryGitState(workDir);
    assert.equal(synced.behind, 0);

    // 3) 另一个人推了两个提交,work 还没 fetch
    await git(['clone', '-q', asRemote(originDir), otherDir], root);
    await fs.writeFile(path.join(otherDir, 'a.txt'), 'a\n');
    await git(['add', '.'], otherDir);
    await gitCommit(otherDir, 'remote work 1');
    await fs.writeFile(path.join(otherDir, 'b.txt'), 'b\n');
    await git(['add', '.'], otherDir);
    await gitCommit(otherDir, 'remote work 2');
    await git(['push', '-q'], otherDir);

    const stale = await probeDirectoryGitState(workDir);
    assert.equal(stale.behind, 0, 'fetch 之前本地引用还是旧的 —— 列表就是在这一步误报"已同步"');

    // 4) 刷新这个目录
    const result = await fetchDirectoryRemotes(workDir);
    assert.equal(result.status, FETCH_STATUS.OK);

    const fresh = await probeDirectoryGitState(workDir);
    assert.equal(fresh.behind, 2, 'fetch 之后必须读出真实的落后提交数');
    assert.equal(fresh.ahead, 0);
    assert.equal(fresh.hasUpstream, true);
  } finally {
    clearFetchInFlight();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DEFAULT_FETCH_TIMEOUT_MS: 比状态探测宽松(网络操作)', () => {
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 30000);
});
