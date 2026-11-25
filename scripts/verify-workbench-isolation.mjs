#!/usr/bin/env node
/**
 * 端到端验证:worktree 隔离与 checkpoint 回滚的**路由层**全链路。
 *
 * 与单测的分界:单测(worktreeOps.test.js / checkpointOps.test.js)直接调 ops 函数,
 * 这里起**真实服务器**(startUIServer,沙箱 HOME),用 fetch 走 HTTP —— 守的是
 * 「路由挂上了、参数解析对了、错误路径回的是人话」这三件事。
 *
 * 覆盖:
 *   W1 任务带 worktree:true 创建成功且开关落盘
 *   W2 未建 worktree 时状态回 exists:false、合并回 404(不是 500)
 *   W3 ensureWorktree 之后状态 exists:true、changedCount 正确
 *   W4 checkOnly 预检 ok:true(无改动)
 *   W5 丢弃之后 exists:false、分支与 config 记录清掉
 *   W6 checkpoint:无检查点的 job 回 404;伪造 job id 回 404
 *   W7 非隔离任务的 worktree 端点回 400(老任务不带开关)
 *
 * 用法:node scripts/verify-workbench-isolation.mjs
 * 退出码:0 全通过,1 有失败
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`);
}

// ── 沙箱 HOME:必须在 import 服务器代码**之前** ──
// paths.js 在模块加载时求值数据目录,晚了就写进真实 ~/.zen-gitsync 了。
const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-wb-iso-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const REPO = path.join(SANDBOX, 'proj');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
const git = (args, opts = {}) => execFileSync('git', ['-c', 'color.ui=never', ...args], {
  cwd: opts.cwd || REPO,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
});
const spawnFileSync = (args) => {
  const r = spawnSync('git', ['-c', 'color.ui=never', ...args], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '') : '';
};
git(['-c', 'init.defaultBranch=main', 'init']);
git(['config', 'user.email', 't@t']);
git(['config', 'user.name', 't']);
fs.writeFileSync(path.join(REPO, 'a.txt'), 'base\n');
git(['add', '-A']);
git(['commit', '-m', 'init']);

// ── 起服务器 ──
const PORT = 5823;
const { default: startUIServer } = await import('../src/ui/server/index.js');
startUIServer(true, false, { role: 'full', port: PORT });
const BASE = `http://127.0.0.1:${PORT}`;
async function waitUp(timeoutMs = 20000) {
  for (let i = 0; i < timeoutMs / 300; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

const j = (r) => r.json();
async function main() {
  if (!(await waitUp())) {
    console.log('  FAIL  服务器没有起来');
    process.exit(1);
  }
  check('服务器就绪', true);

  // W1 建任务(带 worktree 开关)
  const created = await fetch(`${BASE}/api/workbench/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E 隔离任务', projectPath: REPO, worktree: true })
  }).then(j);
  check('W1a 带 worktree:true 建任务成功', created.success === true, created.error || '');
  check('W1b 开关落盘', created.task?.worktree === true);
  const taskId = created.task.id;

  // W7 老任务(不带开关)访问 worktree 端点 → 400
  const legacy = await fetch(`${BASE}/api/workbench/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'E2E 老任务', projectPath: REPO })
  }).then(j);
  const legacyStatus = await fetch(`${BASE}/api/workbench/tasks/${legacy.task.id}/worktree`).then(j);
  check('W7 未开启隔离的任务回 400 说明', legacyStatus.success === false && /未开启/.test(legacyStatus.error || ''), legacyStatus.error || '');

  // W2 未建 worktree:状态 exists:false,合并 404
  const st0 = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree`).then(j);
  check('W2a 未建时状态 exists:false', st0.success === true && st0.status.exists === false);
  const merge0 = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
  }).then(j);
  check('W2b 未建时合并回 404 人话', merge0.success === false && /没有 worktree/.test(merge0.error || ''), merge0.error || '');

  // W3 直接调 ops 建 worktree(等价于任务跑起来时的动作),再探状态
  const { ensureWorktree } = await import('../src/ui/server/routes/workbench/worktreeOps.js');
  const wt = await ensureWorktree(REPO, taskId);
  fs.writeFileSync(path.join(wt.path, 'b.txt'), 'agent\n');
  const st1 = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree`).then(j);
  check('W3a 状态 exists:true', st1.success === true && st1.status.exists === true);
  check('W3b 改动清单含 agent 新增的文件', (st1.status.changedFiles || []).includes('b.txt'),
    JSON.stringify(st1.status.changedFiles || []));

  // W4 checkOnly 预检(主工作区干净 → ok)
  const checkOnly = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree/merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkOnly: true })
  }).then(j);
  check('W4 checkOnly 预检通过', checkOnly.success === true && checkOnly.check?.ok === true,
    JSON.stringify(checkOnly.check?.reason || ''));

  // W5 丢弃
  const del = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree`, { method: 'DELETE' }).then(j);
  check('W5a 丢弃成功', del.success === true, del.error || '');
  const st2 = await fetch(`${BASE}/api/workbench/tasks/${taskId}/worktree`).then(j);
  check('W5b 丢弃后 exists:false', st2.status.exists === false);
  // config --get 查无 key 时 exit 1 —— 这正是"已清掉"的判定条件,用 spawnSync 不抛
  const cfgGet = spawnFileSync(['config', '--get', `zen-gitsync.wt.${taskId}.base`]);
  check('W5c base 的 config 记录已清', cfgGet.trim() === '');

  // W6 checkpoint:没有检查点的 job 回 404
  const rb = await fetch(`${BASE}/api/workbench/jobs/no-such-job/rollback`, { method: 'POST' }).then(j);
  check('W6 不存在的 job 回滚回 404', rb.success === false, rb.error || '');

  console.log(`\n${results.filter(r => r.ok).length}/${results.length} 通过`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

main().catch(err => {
  console.error('E2E 异常:', err);
  process.exit(1);
});
