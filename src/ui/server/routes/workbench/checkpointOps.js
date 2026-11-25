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
// 板块:Workbench 任务的执行快照(checkpoint)与回滚。
//
// ── 解决什么 ────────────────────────────────────────────────────
// agent 无人值守跑任务,改坏了要能一键回到改前状态——「敢让它跑」的前提
// 是「敢让它改」。每一轮 job 起跑前给工作区拍一张快照,出问题从卡片上
// 一键回滚到这一轮开始之前。
//
// ── 快照的形态 ──────────────────────────────────────────────────
// 仿 T3 Code 的"隐藏 ref"做法,但更轻:
//   · 用**临时 index**(GIT_INDEX_FILE 指到临时文件)把工作区全部内容
//     (已跟踪 + 未跟踪,遵守 .gitignore)写成一棵 tree;
//   · `git commit-tree` 把它变成一个**无父提交**,`git update-ref` 挂到
//     `refs/zen-checkpoints/<jobId>`。
// 全程不碰用户的 index、分支和提交历史;refs/zen-checkpoints 不在常规
// 引用清单里展示,不参与 push。快照对象与普通 git 对象一样走 gc 的
// 引用可达性,不会被误回收。
//
// ── 回滚的语义(v1,刻意从窄) ─────────────────────────────────────
// **只还原磁盘文件**,不碰 git index/暂存区:
//   · 快照里有、现在没有 → 恢复;
//   · 快照里没有、现在有 → 删除(它是这一轮之后出现的);
//   · 用户自己的暂存状态保持原样,差异会体现在 git status 里,人看得见。
// 回滚不区分「agent 改的」和「用户在快照之后手改的」——归因做不到精确,
// 所以 UI 必须把「快照之后改了什么」的清单先摆出来,确认才动手。

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REF_PREFIX = 'refs/zen-checkpoints';
/** 每个仓库最多保留多少个检查点 ref(新的把最老的挤掉) */
export const MAX_CHECKPOINTS_PER_REPO = 20;

function git(dir, args, { allowFail = false, env } = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: env ? { ...process.env, ...env } : undefined },
      (err, stdout, stderr) => {
        if (err && !allowFail) {
          const msg = String(stderr || err.message || '').trim().split('\n').filter(Boolean).pop();
          resolve({ ok: false, stdout: '', error: msg || 'git 命令失败' });
          return;
        }
        resolve({ ok: !err, stdout: String(stdout ?? ''), error: err ? String(stderr || err.message) : null });
      });
  });
}

/** 是否一个可用的 git 仓库 */
export async function isGitRepo(dir) {
  const out = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return out.stdout?.trim() === 'true';
}

export function checkpointRef(jobId) {
  return `${REF_PREFIX}/${jobId}`;
}

/**
 * 给 runDir 拍快照。不是 git 仓库时返回 null(调用方照常跑,只是没有回滚)。
 * @returns {Promise<{ref:string, commit:string}|null>}
 */
export async function createCheckpoint(runDir, jobId) {
  if (!(await isGitRepo(runDir))) return null;
  // 只对"运行目录 = 仓库根"的项目生效:任务指向仓库子目录时,agent 的改动
  // 可能落在 runDir 之外,快照/回滚都会漏,干脆不做(与 worktree 同一前提)。
  const top = await git(runDir, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!top.ok) return null;
  try {
    if (path.resolve(top.stdout.trim()) !== path.resolve(runDir)) return null;
  } catch { return null; }
  const tmpIndex = path.join(os.tmpdir(), `zen-ckpt-${jobId}-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    // 临时 index 从零开始:add -A = 全部已跟踪 + 未跟踪(遵守 .gitignore)的当前状态
    const add = await git(runDir, ['add', '-A'], { env, allowFail: true });
    if (!add.ok) return null;
    const wt = await git(runDir, ['write-tree'], { env, allowFail: true });
    if (!wt.ok) return null;
    const tree = wt.stdout.trim();
    const commit = (await git(runDir, ['commit-tree', tree, '-m', `zen-gitsync checkpoint ${jobId}`], { env, allowFail: true })).stdout.trim();
    if (!commit) return null;
    const ref = checkpointRef(jobId);
    const upd = await git(runDir, ['update-ref', ref, commit], { allowFail: true });
    if (!upd.ok) return null;
    await pruneCheckpoints(runDir);
    return { ref, commit };
  } finally {
    await fsp.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/**
 * 快照之后到现在,工作区相对快照改了哪些文件(回滚确认框的数据源)。
 * @returns {Promise<Array<{path:string, status:string}>>} status: A|M|D
 */
export async function checkpointDiff(runDir, ref) {
  // 已跟踪文件的改动:diff ref..工作区。注意 diff 是拿**真实 index** 对比的,
  // 快照收进来的未跟踪文件在 diff 眼里是"D"(ref 有、index 没有)——但文件
  // 明明在磁盘上好好的,得按"磁盘上还有"过滤掉,只留真被删的。
  const out = await git(runDir, ['diff', '--name-status', ref, '--'], { allowFail: true });
  const raw = out.ok
    ? out.stdout.split('\n').filter(Boolean).map(l => {
        const [st, ...rest] = l.split('\t');
        return { status: st.trim().charAt(0), path: rest.join('\t') };
      })
    : [];
  const result = [];
  for (const d of raw) {
    if (d.status === 'D') {
      const alive = await fsp.stat(path.join(runDir, d.path)).then(() => true, () => false);
      if (alive) continue; // 磁盘上还有 → 未跟踪且未变,不是删除
    }
    result.push(d);
  }
  // 未跟踪文件 diff 看不见,但"快照之后新出现的"同样是差异——单列成 A。
  // 快照**收过**未跟踪文件(add -A),所以先查 ref 树里有没有,别把快照前
  // 就存在的未跟踪文件错报成新增。
  const st = await git(runDir, ['status', '--porcelain'], { allowFail: true });
  if (st.ok) {
    const known = new Set(result.map(d => d.path));
    const untracked = st.stdout.split('\n').filter(l => l.startsWith('?? '))
      .map(l => l.slice(3).trim().replace(/^"|"$/g, ''));
    if (untracked.length > 0) {
      const tree = await git(runDir, ['ls-tree', '-r', '--name-only', ref], { allowFail: true });
      const inRef = new Set(tree.ok ? tree.stdout.split('\n').filter(Boolean) : []);
      for (const p of untracked) {
        if (known.has(p) || inRef.has(p)) continue;
        result.push({ status: 'A', path: p });
      }
    }
  }
  return result;
}

/**
 * 回滚到快照:把工作区磁盘状态还原成快照那一刻(见文件头"回滚的语义")。
 * @returns {Promise<{restored:number, removed:number}>}
 */
export async function rollbackToCheckpoint(runDir, ref) {
  // 校验 ref 真的是我们的检查点,别让任意 ref 进来当 --source
  const verify = await git(runDir, ['rev-parse', '--verify', `${ref}^{tree}`], { allowFail: true });
  if (!verify.ok || !String(ref).startsWith(`${REF_PREFIX}/`)) {
    throw new Error(`检查点不存在或已失效: ${ref}`);
  }
  // 1) 快照清单 → 临时 index
  const tmpIndex = path.join(os.tmpdir(), `zen-rollback-${Date.now()}.index`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(runDir, ['read-tree', ref], { env, allowFail: false });
    const snapFiles = (await git(runDir, ['ls-files'], { env })).stdout.split('\n').filter(Boolean);
    const snapSet = new Set(snapFiles);

    // 2) 把快照里的每个文件写回磁盘(checkout-index -f 覆盖已有内容)
    if (snapFiles.length > 0) {
      await git(runDir, ['checkout-index', '-a', '-f'], { env, allowFail: false });
    }
    let restored = 0;
    if (snapFiles.length > 0) {
      // checkout-index 无法只写"快照里有而工作区没有"的,全量写回;
      // restored 按 diff 口径统计(快照之后被改/被删的文件数),删除的不在此列。
      const diff = await checkpointDiff(runDir, ref);
      restored = diff.filter(d => d.status === 'M' || d.status === 'D').length;
    }

    // 3) 删除快照之后新增的文件:当前 index 跟踪的、不在快照里的
    const cur = await git(runDir, ['ls-files'], {});
    const curFiles = cur.ok ? cur.stdout.split('\n').filter(Boolean) : [];
    let removed = 0;
    for (const f of curFiles) {
      if (snapSet.has(f)) continue;
      await fsp.rm(path.join(runDir, f), { force: true }).catch(() => {});
      removed++;
    }

    // 4) 快照之后目录里新出现的**未跟踪**文件也要清掉,否则"回到当时"
    //    名不副实(工作区里还躺着 agent 这轮生成的临时产物)。
    const st = await git(runDir, ['status', '--porcelain'], {});
    if (st.ok) {
      for (const line of st.stdout.split('\n')) {
        if (!line.startsWith('?? ')) continue;
        const p = line.slice(3).trim().replace(/^"|"$/g, '');
        if (snapSet.has(p)) continue;
        await fsp.rm(path.join(runDir, p), { force: true, recursive: true }).catch(() => {});
        removed++;
      }
    }
    return { restored, removed };
  } finally {
    await fsp.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

/** 检查点 ref 是否还存在(回滚按钮的可用性判断) */
export async function checkpointExists(runDir, ref) {
  if (!ref || !String(ref).startsWith(`${REF_PREFIX}/`)) return false;
  const out = await git(runDir, ['rev-parse', '--verify', `${ref}^{commit}`], { allowFail: true });
  return out.ok;
}

/**
 * 只保留最近 N 个检查点 ref(按 commit 时间排序,新的优先)。
 * 失败静默——清理失败不该影响主流程。
 */
async function pruneCheckpoints(runDir) {
  const out = await git(runDir, ['for-each-ref', '--sort=-committerdate',
    '--format=%(refname)', REF_PREFIX], { allowFail: true });
  if (!out.ok) return;
  const refs = out.stdout.split('\n').filter(Boolean);
  for (const ref of refs.slice(MAX_CHECKPOINTS_PER_REPO)) {
    await git(runDir, ['update-ref', '-d', ref], { allowFail: true });
  }
}

export const __testables = { REF_PREFIX };
