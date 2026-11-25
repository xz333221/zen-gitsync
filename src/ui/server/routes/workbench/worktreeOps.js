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
// 板块:Workbench 任务的独立 worktree 隔离。
//
// ── 解决什么 ────────────────────────────────────────────────────
// 任务默认跑在项目目录本身,两个任务并行改同一个项目就会互相踩。
// 开了隔离的任务,执行前 `git worktree add` 出一个独立工作树,agent 在
// 里面随便改;跑完之后由**人**决定「合并回主干」还是「丢弃」——
// 自动合并等于替用户做决定,agent 改的东西该不该进主干不该默认为"该"。
//
// ── 约定 ───────────────────────────────────────────────────────
// · 一条任务 = 一个常驻 worktree(路径固定,见 worktreePath):续聊的
//   CLI 会话按 cwd 索引,每轮换目录会把会话续不上(resumeGuard 的坑);
//   合并/丢弃之后下一轮再重建,开新会话。
// · worktree 放 `<repo>/.zen-worktrees/<taskId>`,通过 `.git/info/exclude`
//   忽略(不碰用户自己的 .gitignore),目录被 status 扫到也不脏工作区。
// · 分支名 `zen-gitsync/task-<taskId>`:合并就是把这个分支 merge 进
//   主工作区当前分支,所以冲突语义全部继承 git 原生行为。
// · agent 通常**不 commit**:合并前先把 worktree 的全部改动(含未跟踪
//   文件)用临时 index 写成一棵树,commit-tree 挂到分支上,再回主工作区
//   merge——用户在 worktree 里手工 commit 过的也一样被带上。
//
// ── 合并前的脏工作区预检 ────────────────────────────────────────
// 主工作区有未提交改动 ≠ 不能合并:git 只在「改动与合并要写的文件相交」
// 时才拒绝。所以预检用 `git status --porcelain` 求出用户脏文件集合,用
// `git merge-tree`(内存合并,不碰工作区)求出这次合并会写的文件集合,
// 两者相交才拦;拦的时候把撞名的文件清单给出去,而不是一句笼统的失败。

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR_NAME = '.zen-worktrees';
/** 分支名前缀。合并/删除按这个前缀认领自己的分支,不碰用户的分支 */
const BRANCH_PREFIX = 'zen-gitsync/task-';
/** merge 预检允许的最大文件清单(防止一个巨型合并把响应撑爆) */
const MAX_LISTED_FILES = 50;

function gitArgsError(stderr, stdout) {
  const msg = String(stderr || stdout || '').trim().split('\n').filter(Boolean).pop();
  return new Error(msg || 'git 命令失败');
}

/**
 * 在指定目录跑一条 git 命令。
 * 刻意不用 gitOps 的 execGitCommand:那套绑定在 GUI 的 git 路由上下文上,
 * 这里要的是**纯函数**(测试直接拿临时仓库调用,不起 express)。
 */
export async function git(dir, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (err) {
    if (allowFail) return null;
    const e = gitArgsError(err.stderr, err.stdout);
    e.code = err.code;
    throw e;
  }
}

/** 是否一个可用的 git 仓库( worktree 的前提) */
export async function isGitRepo(dir) {
  const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return out?.trim() === 'true';
}

/** 任务在磁盘上的 worktree 路径(创建与否都返回它) */
export function worktreePath(repoPath, taskId) {
  return path.join(repoPath, WORKTREE_DIR_NAME, taskId);
}

/** 这个任务分支的 ref 名 */
export function worktreeBranchRef(taskId) {
  return `${BRANCH_PREFIX}${taskId}`;
}

async function ensureIgnored(repoPath) {
  // .git/info/exclude 只对本仓库生效,不污染用户自己的 .gitignore;
  // 追加前查重,别每次跑都写一行。
  const excludeFile = path.join(repoPath, '.git', 'info', 'exclude');
  let content = '';
  try { content = await fsp.readFile(excludeFile, 'utf8'); } catch { /* 没有就新建 */ }
  const line = `${WORKTREE_DIR_NAME}/`;
  if (content.split(/\r?\n/).some(l => l.trim() === line)) return;
  const next = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  await fsp.mkdir(path.dirname(excludeFile), { recursive: true });
  await fsp.writeFile(excludeFile, next, 'utf8');
}

/** 分叉点在 repo config 里的 key(worktree 建了多久都读得回来) */
function baseConfigKey(taskId) {
  return `zen-gitsync.wt.${taskId}.base`;
}

/**
 * 确保任务的 worktree 存在且指向给定分支,存在就原样复用。
 * @returns {Promise<{path:string, branch:string, base:string, reused:boolean}>}
 */
export async function ensureWorktree(repoPath, taskId) {
  if (!(await isGitRepo(repoPath))) {
    throw new Error('该项目不是 git 仓库,无法使用 worktree 隔离');
  }
  await ensureIgnored(repoPath);
  const wtPath = worktreePath(repoPath, taskId);
  const branch = worktreeBranchRef(taskId);

  // 已存在且健康 → 复用(续聊轮的会话库按 cwd 索引,路径必须稳定)
  const existingHead = await git(wtPath, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (existingHead) {
    const cfgBase = await git(repoPath, ['config', '--get', baseConfigKey(taskId)], { allowFail: true });
    return { path: wtPath, branch, base: (cfgBase || existingHead).trim(), reused: true };
  }

  // 残尸处理:目录在但不是 worktree(上次 remove 中断 / 用户手删了 .git 文件)
  await fsp.rm(wtPath, { recursive: true, force: true }).catch(() => {});
  // 注册表里可能还挂着指向同一路径的死条目,先 prune 再 add,否则 worktree add 拒绝执行
  await git(repoPath, ['worktree', 'prune'], { allowFail: true });
  await fsp.mkdir(path.dirname(wtPath), { recursive: true });

  // 基点 = 主工作区当前 HEAD(不跟分支名较劲——用户可能停在 detached 上)
  const base = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  // 分支已存在(目录被手删但分支还在)→ 直接挂到现有分支上,别 -b(会拒绝执行);
  // 分支上的既有提交原样保留——那是之前轮次固化过的成果,不该因为重建而丢
  const branchExists = await git(repoPath, ['rev-parse', '--verify', branch], { allowFail: true });
  if (branchExists) {
    await git(repoPath, ['worktree', 'add', wtPath, branch]);
  } else {
    await git(repoPath, ['worktree', 'add', '-b', branch, wtPath, base]);
  }
  // 分叉点记进 repo config:「改了哪些文件」的口径依赖它,不存的话
  // 重启后 merge-base 会算出分支尖端自己,清单就永远是空的
  const cfgBase = await git(repoPath, ['config', '--get', baseConfigKey(taskId)], { allowFail: true });
  if (!(cfgBase || '').trim()) {
    // 分支复用且没有记录时,用 merge-base 补——比"分支尖端"或"当前 HEAD"都接近真相
    const mb = branchExists
      ? ((await git(repoPath, ['merge-base', branch, base], { allowFail: true })) || base).trim()
      : base;
    await git(repoPath, ['config', baseConfigKey(taskId), mb], { allowFail: true });
  }
  const finalBase = ((await git(repoPath, ['config', '--get', baseConfigKey(taskId)], { allowFail: true })) || base).trim();
  return { path: wtPath, branch, base: finalBase, reused: false };
}

/**
 * 把 worktree 的全部改动(含未跟踪文件、含用户在 worktree 里手工 commit 的)
 * 固化成一个提交挂到任务分支上。agent 不 commit 是常态,合并前必须先做这步,
 * 否则 merge 分支合并的是一架空分支。
 * @returns {Promise<string>} 固化后的提交 sha
 */
export async function commitWorktreeChanges(wtPath, branch, message = 'zen-gitsync: 任务改动合并前固化') {
  const tmpIndex = path.join(wtPath, '..', `${path.basename(wtPath)}.index.tmp`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await execFileAsync('git', ['add', '-A'], { cwd: wtPath, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const tree = (await execFileAsync('git', ['write-tree'], { cwd: wtPath, env, windowsHide: true })).stdout.trim();
    const parent = (await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'],
      { cwd: wtPath, windowsHide: true })).stdout.trim();
    if (parent) {
      // 内容没变就别造空提交——预检和合并各调一次,重复固化只会堆出线性垃圾
      const parentTree = (await execFileAsync('git', ['rev-parse', `${parent}^{tree}`],
        { cwd: wtPath, windowsHide: true })).stdout.trim();
      if (parentTree === tree) return parent;
    }
    const args = parent
      ? ['commit-tree', tree, '-p', parent, '-m', message]
      : ['commit-tree', tree, '-m', message];
    const commit = (await execFileAsync('git', args, { cwd: wtPath, env, windowsHide: true })).stdout.trim();
    // 把分支指到固化提交(分支当前可能落后于 HEAD,直接 move,不产生 reflog 噪音)
    await execFileAsync('git', ['update-ref', `refs/heads/${branch}`, commit], { cwd: wtPath, windowsHide: true });
    return commit;
  } finally {
    await fsp.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** worktree 里改了哪些文件(相对 base,含未提交的; 用于合并预检与确认框) */
export async function worktreeChangedFiles(wtPath, base) {
  const committed = await git(wtPath, ['diff', '--name-only', `${base}..HEAD`], { allowFail: true }) || '';
  // 未提交改动相对 HEAD 的文件集(含未跟踪,porcelain 里 ? 开头的)
  const status = await git(wtPath, ['status', '--porcelain'], { allowFail: true }) || '';
  const uncommitted = status.split('\n')
    .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return [...new Set([...committed.split('\n').filter(Boolean), ...uncommitted])];
}

/**
 * 合并预检:主工作区的脏文件与这次合并要写的文件**相交才拦**。
 * @returns {Promise<{ok:boolean, reason?:string, dirtyFiles:string[], mergeFiles:string[], overlap:string[], conflictFiles:string[]}>}
 */
export async function precheckMerge(repoPath, wtPath, base, branch) {
  const status = await git(repoPath, ['status', '--porcelain'], { allowFail: true }) || '';
  const dirtyFiles = [...new Set(status.split('\n')
    .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter(l => l && !l.startsWith('.zen-worktrees/')))];

  // 这次合并会写主工作区的哪些文件 = 分支侧相对合并基改动的文件集
  // (`head...fixed` 三点 diff,与 merge 的语义同款口径)。merge-tree 拿不到
  // 这个清单——它干净合并时只回一个 tree oid,文件列表只在冲突时才有。
  const head = (await git(repoPath, ['rev-parse', 'HEAD'], { allowFail: true }) || '').trim();
  const fixed = await commitWorktreeChanges(wtPath, branch);
  const approx = await git(repoPath, ['diff', '--name-only', `${head}...${fixed}`], { allowFail: true });
  const mergeFiles = (approx || '').split('\n').map(l => l.trim()).filter(Boolean);
  // 冲突检测另走 merge-tree(内存合并,不碰工作区);git < 2.38 没有这命令,
  // 跳过检测——冲突由 merge 执行时的 --abort 兜底,工作区不受影响。
  let conflictFiles = [];
  const mt = await execFileAsync('git', ['merge-tree', '--write-tree', '--name-only', head, fixed],
    { cwd: repoPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    .then(r => ({ ok: true, out: r.stdout }))
    .catch(err => ({ ok: false, out: err.stdout || '', stderr: err.stderr || '', message: err.message || '' }));
  if (!mt.ok && !/unknown option|usage: git merge-tree/i.test(mt.stderr + mt.message)) {
    // 冲突时输出是 <tree> 空行 <conflicted files...> 或纯报错,尽力解析
    const mtLines = String(mt.out || '').split('\n').map(l => l.trim()).filter(Boolean);
    conflictFiles = mtLines.filter(l => !/^[0-9a-f]{40}$/.test(l));
  }

  const dirtySet = new Set(dirtyFiles);
  const overlap = mergeFiles.filter(f => dirtySet.has(f));

  if (conflictFiles.length > 0) {
    return {
      ok: false,
      reason: `合并会产生冲突(git 无法自动完成),涉及 ${conflictFiles.length} 个文件。建议先在分支上解决或手动合并。`,
      dirtyFiles, mergeFiles, overlap, conflictFiles,
    };
  }
  if (overlap.length > 0) {
    const shown = overlap.slice(0, MAX_LISTED_FILES).join('\n');
    return {
      ok: false,
      reason: `你的工作区有未提交改动与本次合并重叠,直接合并会覆盖它们:\n${shown}`
        + `\n\n请先提交/暂存这些改动,或者用「先暂存再合并」。`,
      dirtyFiles, mergeFiles, overlap, conflictFiles,
    };
  }
  return { ok: true, dirtyFiles, mergeFiles, overlap: [], conflictFiles: [], fixedCommit: fixed };
}

/**
 * 合并回主干。调用方**必须**先跑 precheckMerge 且 ok,这里不再重复预检
 * (预检和执行之间窗口极小,重复做反而可能拿到不同答案)。
 * @returns {Promise<{commit:string, mergeCommit:string|null, files:string[]}>}
 */
export async function mergeWorktree(repoPath, wtPath, base, branch) {
  const fixed = await commitWorktreeChanges(wtPath, branch);
  const dirty = await git(repoPath, ['status', '--porcelain'], { allowFail: true }) || '';
  const dirtyFiles = dirty.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  const mergeFiles = (await worktreeChangedFiles(wtPath, base));
  const dirtySet = new Set(dirtyFiles);
  const overlap = mergeFiles.filter(f => dirtySet.has(f));
  if (overlap.length > 0) {
    throw new Error(`工作区改动与合并重叠:${overlap.slice(0, MAX_LISTED_FILES).join(', ')}`);
  }
  const mergeOut = await git(repoPath, ['merge', branch, '--no-edit'], { allowFail: true });
  if (mergeOut === null) {
    // 冲突:立刻放弃这次 merge,把工作区还给用户
    await git(repoPath, ['merge', '--abort'], { allowFail: true });
    throw new Error('合并出现冲突,已放弃(工作区未受影响)。请在分支上解决冲突后手动合并。');
  }
  const head = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { commit: fixed, mergeCommit: head, files: mergeFiles };
}

/**
 * 丢弃任务的 worktree 与分支。worktree 里没合并的改动会一并消失,
 * 调用方(UI)负责确认。
 */
export async function discardWorktree(repoPath, taskId) {
  const wtPath = worktreePath(repoPath, taskId);
  const branch = worktreeBranchRef(taskId);
  // --force:agent 的未提交改动一并丢弃,这正是「丢弃」的语义
  await git(repoPath, ['worktree', 'remove', '--force', wtPath], { allowFail: true });
  // 目录还残留(比如 git 版本老不认这个路径)就物理删掉
  await fsp.rm(wtPath, { recursive: true, force: true }).catch(() => {});
  await git(repoPath, ['branch', '-D', branch], { allowFail: true });
  // 分叉点的 config 记录一并清掉,别在用户的 repo config 里留垃圾
  await git(repoPath, ['config', '--unset', baseConfigKey(taskId)], { allowFail: true });
  // worktree 元数据 prune,防止 git worktree list 里挂着死条目
  await git(repoPath, ['worktree', 'prune'], { allowFail: true });
}

/** 任务 worktree 的概要状态(路由层直接序列化给前端) */
export async function worktreeStatus(repoPath, taskId) {
  const wtPath = worktreePath(repoPath, taskId);
  const branch = worktreeBranchRef(taskId);
  const head = await git(wtPath, ['rev-parse', '--verify', 'HEAD'], { allowFail: true });
  if (!head) return { exists: false, path: wtPath, branch };
  const cfgBase = await git(repoPath, ['config', '--get', baseConfigKey(taskId)], { allowFail: true });
  const base = (cfgBase || '').trim() || head.trim();
  const changedFiles = await worktreeChangedFiles(wtPath, base);
  return {
    exists: true,
    path: wtPath,
    branch,
    base,
    changedCount: changedFiles.length,
    changedFiles: changedFiles.slice(0, MAX_LISTED_FILES),
  };
}

export const __testables = { WORKTREE_DIR_NAME, BRANCH_PREFIX, worktreeChangedFiles };
