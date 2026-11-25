// worktreeOps 单测:临时仓库里真跑 git,验证隔离/合并/丢弃的全链路。
//
// 最要紧的三条:
//   1. agent 不 commit(常态)时,合并前的固化提交必须把它的改动带进分支;
//   2. 主工作区脏文件**与合并不相交时不许拦**——拦错把正常用户挡在门外;
//   3. 相交时必须拦,且列出撞名文件——笼统一句"失败"用户没法处理。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  ensureWorktree,
  worktreePath,
  worktreeStatus,
  precheckMerge,
  mergeWorktree,
  discardWorktree,
  isGitRepo,
} from './worktreeOps.js';

let repo = null;
let seq = 0;

function gitSync(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

/** 允许失败的 git(config --get 查无 key 时 exit 1,不该炸测试) */
function spawnFileSync(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd || repo, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : '';
}

async function write(file, content) {
  const abs = path.join(repo, file);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-wt-test-'));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo });
  gitSync(['config', 'user.email', 't@t']);
  gitSync(['config', 'user.name', 't']);
  await write('a.txt', 'base\n');
  await write('src/one.txt', 'one\n');
  gitSync(['add', '-A']);
  gitSync(['commit', '-m', 'init']);
});

afterEach(async () => {
  await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
  repo = null;
});

const TASK = `test-task-${++seq}`;

test('非 git 目录上 ensureWorktree 直接报错', async () => {
  const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-wt-plain-'));
  try {
    await assert.rejects(() => ensureWorktree(plain, 't1'), /不是 git 仓库/);
    assert.equal(await isGitRepo(plain), false);
  } finally {
    await fsp.rm(plain, { recursive: true, force: true }).catch(() => {});
  }
});

test('ensureWorktree 创建带分支的 worktree,二次调用复用同一个', async () => {
  const wt1 = await ensureWorktree(repo, TASK);
  assert.equal(wt1.reused, false);
  assert.equal(await isGitRepo(wt1.path), true);
  const branch = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt1.path }).trim();
  assert.equal(branch, `zen-gitsync/task-${TASK}`);

  const wt2 = await ensureWorktree(repo, TASK);
  assert.equal(wt2.reused, true);
  assert.equal(wt2.path, wt1.path, '续聊轮必须拿到同一个路径,否则 CLI 会话续不上');
  assert.equal(wt2.base, wt1.base, '复用时 base 读 config 记录,不能漂移成分支尖端');
});

test('agent 不 commit 的改动也能合并进主干;合并后 worktree 清干净', async () => {
  const wt = await ensureWorktree(repo, TASK);
  // agent 在 worktree 里改文件、加文件,**不 commit**
  await fsp.writeFile(path.join(wt.path, 'a.txt'), 'agent edit\n', 'utf8');
  await fsp.writeFile(path.join(wt.path, 'src/new.txt'), 'new\n', 'utf8');

  const status = await worktreeStatus(repo, TASK);
  assert.equal(status.exists, true);
  assert.ok(status.changedCount >= 2, `改动清单应含修改与新增,实际 ${status.changedCount}`);

  const precheck = await precheckMerge(repo, wt.path, wt.base, wt.branch);
  assert.equal(precheck.ok, true, `主工作区干净时不应拦: ${precheck.reason || ''}`);

  const result = await mergeWorktree(repo, wt.path, wt.base, wt.branch);
  assert.ok(result.files.includes('a.txt'));
  assert.equal((await fsp.readFile(path.join(repo, 'a.txt'), 'utf8')).replace(/\r/g, ''), 'agent edit\n');
  assert.equal((await fsp.readFile(path.join(repo, 'src/new.txt'), 'utf8')).replace(/\r/g, ''), 'new\n');

  // 合并后的收摊是调用方做(discardWorktree),这里验证它把现场清干净
  await discardWorktree(repo, TASK);
  const gone = await worktreeStatus(repo, TASK);
  assert.equal(gone.exists, false);
  assert.equal(await isGitRepo(worktreePath(repo, TASK)), false);
  const branches = gitSync(['branch', '--list', `zen-gitsync/task-${TASK}`]);
  assert.equal(branches.trim(), '', '任务分支要删掉');
  const cfg = spawnFileSync(['config', '--get', `zen-gitsync.wt.${TASK}.base`]);
  assert.equal(cfg, '', 'base 的 config 记录要一并清掉');
});

test('主工作区脏文件与合并不相交 → 不拦,合并成功且不碰用户改动', async () => {
  const wt = await ensureWorktree(repo, TASK);
  await fsp.writeFile(path.join(wt.path, 'src/one.txt'), 'agent edit\n', 'utf8');

  // 用户在主工作区改了**另一个**文件,没提交
  await fsp.writeFile(path.join(repo, 'a.txt'), 'user edit\n', 'utf8');

  const precheck = await precheckMerge(repo, wt.path, wt.base, wt.branch);
  assert.equal(precheck.ok, true, `不相交的脏文件不该拦: ${precheck.reason || ''}`);

  await mergeWorktree(repo, wt.path, wt.base, wt.branch);
  assert.equal((await fsp.readFile(path.join(repo, 'a.txt'), 'utf8')).replace(/\r/g, ''), 'user edit\n', '用户的未提交改动必须原样保留');
  assert.equal((await fsp.readFile(path.join(repo, 'src/one.txt'), 'utf8')).replace(/\r/g, ''), 'agent edit\n');
});

test('主工作区脏文件与合并重叠 → 拦下并列出撞名文件', async () => {
  const wt = await ensureWorktree(repo, TASK);
  await fsp.writeFile(path.join(wt.path, 'a.txt'), 'agent edit\n', 'utf8');
  await fsp.writeFile(path.join(repo, 'a.txt'), 'user edit\n', 'utf8');

  const precheck = await precheckMerge(repo, wt.path, wt.base, wt.branch);
  assert.equal(precheck.ok, false);
  assert.deepEqual(precheck.overlap, ['a.txt']);
  assert.ok(precheck.reason.includes('a.txt'), '拦的时候要把撞名文件列出来');

  // 拦下之后谁都不许动:用户改动还在,worktree 改动也还在
  assert.equal(await fsp.readFile(path.join(repo, 'a.txt'), 'utf8'), 'user edit\n');
  assert.equal(await fsp.readFile(path.join(wt.path, 'a.txt'), 'utf8'), 'agent edit\n');
});

test('合并本身有冲突时预检拦下并给出冲突文件', async () => {
  const wt = await ensureWorktree(repo, TASK);
  await fsp.writeFile(path.join(wt.path, 'a.txt'), 'agent edit\n', 'utf8');
  // 用户**先 commit**了同一个文件的不同内容 → 真冲突(脏文件预检抓不到)
  await fsp.writeFile(path.join(repo, 'a.txt'), 'user committed\n', 'utf8');
  gitSync(['add', '-A']);
  gitSync(['commit', '-m', 'user change']);

  const precheck = await precheckMerge(repo, wt.path, wt.base, wt.branch);
  assert.equal(precheck.ok, false);
  assert.ok(precheck.conflictFiles.includes('a.txt'), `冲突清单要有 a.txt,实际 ${JSON.stringify(precheck.conflictFiles)}`);
});

test('worktree 残尸(目录被手删)能自愈', async () => {
  const wt = await ensureWorktree(repo, TASK);
  await fsp.rm(wt.path, { recursive: true, force: true });
  const wt2 = await ensureWorktree(repo, TASK);
  assert.equal(wt2.reused, false, '残尸之后要重建而不是报错');
  assert.equal(await isGitRepo(wt2.path), true);
});
