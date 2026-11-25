// checkpointOps 单测:快照/回滚在临时仓库里真跑。
//
// 最要紧的三条:
//   1. 快照**不碰用户的 git 状态**:分支、HEAD、暂存区、status 输出在快照前后
//      必须一字不差——这是"隐藏 ref"方案的全部意义;
//   2. 回滚是**三向**的:快照后改的要还原、删的要恢复、新增的要清掉;
//   3. 未跟踪文件在快照时就要收进来——agent 生成的多半是没跟踪的新文件,
//      只快照已跟踪文件等于没做。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  createCheckpoint,
  checkpointDiff,
  rollbackToCheckpoint,
  checkpointExists,
  isGitRepo,
  MAX_CHECKPOINTS_PER_REPO,
} from './checkpointOps.js';

let repo = null;
let seq = 0;

function gitSync(args, opts = {}) {
  return execFileSync('git', ['-c', 'color.ui=never', ...args], {
    cwd: opts.cwd || repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

async function write(file, content) {
  const abs = path.join(repo, file);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

const norm = s => String(s).replace(/\r/g, '');

beforeEach(async () => {
  repo = await fsp.mkdtemp(path.join(os.tmpdir(), `zen-ckpt-test-${++seq}-`));
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo });
  gitSync(['config', 'user.email', 't@t']);
  gitSync(['config', 'user.name', 't']);
  await write('a.txt', 'base\n');
  gitSync(['add', '-A']);
  gitSync(['commit', '-m', 'init']);
});

afterEach(async () => {
  await fsp.rm(repo, { recursive: true, force: true }).catch(() => {});
  repo = null;
});

test('非 git 目录返回 null(照常跑任务,只是没有回滚)', async () => {
  const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-ckpt-plain-'));
  try {
    assert.equal(await createCheckpoint(plain, 'job-x'), null);
  } finally {
    await fsp.rm(plain, { recursive: true, force: true }).catch(() => {});
  }
});

test('快照不碰用户的 git 状态', async () => {
  // 用户有一份未提交改动 + 一个未跟踪文件,快照前后 status 必须一致
  await write('a.txt', 'user edit\n');
  await write('untracked.txt', 'u\n');
  const statusBefore = gitSync(['status', '--porcelain']);
  const headBefore = gitSync(['rev-parse', 'HEAD']).trim();

  const cp = await createCheckpoint(repo, 'job-1');
  assert.ok(cp, 'git 仓库上必须拿到检查点');

  assert.equal(gitSync(['status', '--porcelain']), statusBefore);
  assert.equal(gitSync(['rev-parse', 'HEAD']).trim(), headBefore);
  // 隐藏 ref 不进分支清单
  assert.equal(gitSync(['branch', '--list']).trim(), '* main');
  // ref 确实存在
  assert.equal(await checkpointExists(repo, cp.ref), true);
  // 未跟踪文件也进了快照
  const files = await checkpointDiff(repo, cp.ref);
  assert.equal(files.length, 0, '快照当下与工作区无差异');
});

test('回滚还原「改的」和「删的」,清掉「新增的」', async () => {
  const cp = await createCheckpoint(repo, 'job-2');
  assert.ok(cp);

  // agent 这一轮:改 a.txt、删 a.txt 同目录的邻居、新增 generated.txt
  await write('a.txt', 'agent broke it\n');
  await write('generated.txt', 'junk\n');
  const diff = await checkpointDiff(repo, cp.ref);
  const paths = diff.map(d => d.path).sort();
  assert.deepEqual(paths, ['a.txt', 'generated.txt']);
  assert.equal(diff.find(d => d.path === 'generated.txt').status, 'A');

  const result = await rollbackToCheckpoint(repo, cp.ref);
  assert.equal(norm(await fsp.readFile(path.join(repo, 'a.txt'), 'utf8')), 'base\n', '被改的文件要还原');
  assert.equal(await fsp.readFile(path.join(repo, 'generated.txt'), 'utf8').then(() => true, () => false), false,
    '这轮新增的文件要删掉');
  assert.ok(result.removed >= 1);
});

test('快照时删掉的文件,回滚要恢复', async () => {
  await write('temp.txt', 'doomed\n');
  gitSync(['add', '-A']);
  gitSync(['commit', '-m', 'add temp']);
  const cp = await createCheckpoint(repo, 'job-3');
  await fsp.rm(path.join(repo, 'temp.txt'));
  const diff = await checkpointDiff(repo, cp.ref);
  assert.deepEqual(diff.map(d => [d.path, d.status]), [['temp.txt', 'D']]);

  await rollbackToCheckpoint(repo, cp.ref);
  assert.equal(norm(await fsp.readFile(path.join(repo, 'temp.txt'), 'utf8')), 'doomed\n', '被删的文件要恢复');
});

test('回滚不碰用户的暂存区(只还原磁盘)', async () => {
  const cp = await createCheckpoint(repo, 'job-4');
  await write('a.txt', 'agent edit\n');
  gitSync(['add', '-A']);
  // 用户在 agent 改完后把别的东西放进了暂存区
  await write('staged-by-user.txt', 's\n');
  gitSync(['add', 'staged-by-user.txt']);
  const stagedBefore = gitSync(['diff', '--name-only', '--cached']).trim();

  await rollbackToCheckpoint(repo, cp.ref);
  assert.equal(gitSync(['diff', '--name-only', '--cached']).trim(), stagedBefore,
    '暂存区是用户的账本,回滚不许动');
  assert.equal(norm(await fsp.readFile(path.join(repo, 'a.txt'), 'utf8')), 'base\n');
});

test('检查点 ref 按仓库封顶滚动清理', async () => {
  for (let i = 0; i < MAX_CHECKPOINTS_PER_REPO + 5; i++) {
    const cp = await createCheckpoint(repo, `job-prune-${i}`);
    assert.ok(cp);
  }
  const refs = gitSync(['for-each-ref', '--format=%(refname)', 'refs/zen-checkpoints'])
    .trim().split('\n').filter(Boolean);
  assert.equal(refs.length, MAX_CHECKPOINTS_PER_REPO);
});

test('失效/伪造的 ref 拒绝回滚', async () => {
  await assert.rejects(
    () => rollbackToCheckpoint(repo, 'refs/zen-checkpoints/no-such-job'),
    /不存在或已失效/
  );
  await assert.rejects(
    () => rollbackToCheckpoint(repo, 'refs/heads/main'),
    /不存在或已失效/
  );
});
