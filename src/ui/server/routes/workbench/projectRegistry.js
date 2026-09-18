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
// 项目登记表：把「常用/最近目录」和「任务里出现过的 projectPath」合并成一份项目清单，
// 并给每个项目挂上 Git 状态与任务统计，供多项目编排台（看板）使用。
//
// 为什么是「合并」而不是新建一张项目表：
//   - 任务早就有 projectPath 字段（建任务时记下当时的项目），只是从来没有被当成一等实体；
//   - 最近目录是应用已经在维护的项目来源，重复维护第二份清单必然对不上。
//   两者取并集去重后，"有任务但没进过最近目录" 和 "在最近目录但还没建任务" 的项目都能看到。
//
// 安全边界（沿用 /api/recent_directories/git-state 的口径）：
//   这里要探测的路径只来自**服务端可信来源** —— configManager.getRecentDirectories()
//   与 tasks.json 里已有的 projectPath。本模块不接受任何客户端传入的路径，
//   因此不会被当成「任意路径 git 探测」的入口使用。
//
// 设计要点：
//   - 路径归一与前端 utils/path.ts 的 canonicalProjectPath 必须**逐字一致**
//     （Windows 形式转小写 + 斜杠归一）；两边口径一旦分叉，
//     同一个目录会在两侧落到不同 key 上，表现为项目凭空分裂成两个。
//   - 任务落在哪一列由 deriveTaskColumn 统一推导，是纯函数、单测覆盖；
//     前端不重复实现这套规则，避免两边口径漂移。
//   - Git 状态复用 utils/directoryGitState.js 的批量探测（带并发上限 + TTL 缓存 + 超时）。

import { probeDirectoryGitStates } from '../../utils/directoryGitState.js';

/** 看板列，数组顺序即列顺序 */
export const TASK_COLUMNS = ['todo', 'doing', 'done'];

/** 没有关联任何项目的任务归到这个 key（与前端 useWorkbenchProjectGroups 一致） */
export const NO_PROJECT_KEY = '__no_project__';

/**
 * 项目路径归一。与前端 src/ui/client/src/utils/path.ts 的 canonicalProjectPath 同口径：
 * Windows 形式（带盘符）→ 转小写 + 反斜杠归一；其余（POSIX）原样返回。
 *
 * 为什么必须归斜杠：常用目录允许用户手输，同一个目录会同时存在 `D:/ws/proj`
 * 与 `D:\ws\proj` 两种写法。文件系统不区分，字符串比较却会 ——
 * 于是项目列表里出现两个同名项目（实测 article-generator 就是如此）。
 * 归一是修一个看得见的重复项，不是顺手清理。
 *
 * 为什么必须归**大小写**（2026-09-18 补，同一类问题的第二张脸）：
 * 只归斜杠治不了目录段的大小写。`recentDirectories` 存的是用户输入时的**原始写法**
 * （`saveRecentDirectory` 只用 normalizeProjectPath 做去重比较，落盘仍写原串），
 * 而任务的 `projectPath` 来自别处 —— 于是同一个目录会以 `c:\users\xuze3`
 * （常用目录里手输的小写盘符）和 `C:\Users\xuze3`（任务带出来的）两种形态并存，
 * 拿到两个 key、渲染成两条项目行。
 *
 * 关键在于**小写化必须做进 key 本身**，而不是在每处比较之前各自归一：key 会被拿去
 * `stats.get(key)` 精确查表、比 `← 当前` 标记、比派发目标、比前端选中的项目 ——
 * 只要有一处忘了先归一，同一目录就又会裂成两条。统一收在这里，调用方拿到的 key
 * 天然可跨写法相等比较。（Windows 文件系统不区分大小写，小写化不会把两个真目录并成一个；
 * 与之对应的 config.js 项目键 `normalizeProjectPath` 也是全小写的，方向一致。）
 *
 * 刻意**不**做去尾斜杠 / 展开 `..` / 解析符号链接：那会把比较规则变得依赖文件系统语义。
 * 小写化是这条底线上唯一的例外，但它是**纯字符串**操作（只看 `X:` 这个形状，不看
 * process.platform），没有引入任何 fs 依赖 —— 底线还在。
 */
export function canonicalProjectPath(p) {
  const s = String(p || '').trim();
  if (!/^[a-zA-Z]:/.test(s)) return s;
  return s.replace(/\//g, '\\').toLowerCase();
}

/** 目录名（项目显示名），路径为空时返回空串而不是兜底文案（文案归前端 i18n 管） */
export function projectName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 任务该在哪个目录里执行。纯函数，单测覆盖。
 *
 * 多项目编排下的关键一环：run* 系列路由过去一律拿 getCurrentProjectPath() 当工作区，
 * 于是「在看板里执行 B 项目的任务」会跑到 A 项目的工作区里去改代码 —— 对多项目看板是致命的。
 * 任务自创建起就记着自己的 projectPath，执行时以它为准；只有它为空
 * （历史数据 / 未关联项目）才回退到调用方给的兜底路径（一般是当前项目）。
 *
 * 刻意**不**在任务目录不存在时回退当前项目：那等于悄悄把改动落到另一个仓库上，
 * 比直接报错危险得多。目录不存在就让执行报错，用户能立刻看见。
 */
export function resolveTaskRepoPath(task, fallbackPath = '') {
  const fromTask = task && typeof task.projectPath === 'string' ? task.projectPath.trim() : '';
  if (fromTask) return fromTask;
  return typeof fallbackPath === 'string' ? fallbackPath : '';
}

/** 把 jobs 快照按 taskId 分组，deriveTaskColumn / 统计都要用 */
export function groupJobsByTask(jobs) {
  const map = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.taskId) continue;
    if (!map.has(j.taskId)) map.set(j.taskId, []);
    map.get(j.taskId).push(j);
  }
  return map;
}

/** job 的时间戳：优先 startedAt，回落到 endedAt，都没有就空串（用于取"最后一条"） */
function jobTimestamp(j) {
  return String((j && (j.startedAt || j.endedAt)) || '');
}

/** 取时间上最新的一条 job；时间戳都一样（老数据）时按原顺序取末条 */
export function latestJob(jobsForTask) {
  const list = Array.isArray(jobsForTask) ? jobsForTask : [];
  if (list.length === 0) return null;
  let best = list[0];
  for (const j of list) {
    if (jobTimestamp(j) >= jobTimestamp(best)) best = j;
  }
  return best;
}

/**
 * 把一个任务推导到看板的四列之一。纯函数，单测覆盖。
 *
 * 口径（按优先级，逐条短路）：
 *   1. 有 job 处于 running/pending，或子任务状态是 running → `doing`
 *   2. 有子任务且全部 done → `done`
 *   3. 有子任务但没全 done：
 *        - 动过（有 done 的子任务 / 执行过 / 有 error 的子任务）→ `todo`
 *        - 完全没动过 → `todo`
 *   4. 没子任务（简单任务，或还没拆分的复杂任务）：
 *        - 从没执行过 → `todo`
 *        - 最近一条 job 是 done → `done`；其余终态（error/cancelled）→ `todo`
 *
 * error/cancelled 不再单列：列表示任务是否仍待处理，错误是这一轮执行的结果，
 * 具体错误继续通过卡片标记和任务详情展示。
 */
export function deriveTaskColumn(task, jobsForTask = []) {
  const subs = Array.isArray(task && task.subtasks) ? task.subtasks : [];
  const jobs = Array.isArray(jobsForTask) ? jobsForTask : [];

  if (jobs.some(j => j && (j.status === 'running' || j.status === 'pending'))) return 'doing';
  if (subs.some(s => s && s.status === 'running')) return 'doing';

  if (subs.length > 0) {
    const doneCount = subs.filter(s => s && s.status === 'done').length;
    if (doneCount === subs.length) return 'done';
    return 'todo';
  }

  if (jobs.length === 0) return 'todo';
  const last = latestJob(jobs);
  return last && last.status === 'done' ? 'done' : 'todo';
}

/** 空统计，避免各处手写零值 */
function emptyStats() {
  return {
    total: 0, todo: 0, doing: 0, done: 0,
    progress: 0, runningJobs: 0, errorSubtasks: 0, lastActiveAt: null,
  };
}

/** 取更新的时间戳（都是 ISO 字符串，直接字典序比较即可） */
function laterOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) >= String(b) ? a : b;
}

/**
 * 按项目 key 汇总任务统计。
 * @returns {Map<string, object>} key 为 canonicalProjectPath(projectPath) || NO_PROJECT_KEY
 */
export function summarizeProjectTasks(tasks, jobs) {
  const jobsByTask = groupJobsByTask(jobs);
  const taskProject = new Map(); // taskId -> projectKey
  const byKey = new Map();

  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t) continue;
    const key = canonicalProjectPath(t.projectPath) || NO_PROJECT_KEY;
    taskProject.set(t.id, key);
    if (!byKey.has(key)) byKey.set(key, emptyStats());
    const agg = byKey.get(key);
    const jobsForTask = jobsByTask.get(t.id) || [];
    const column = deriveTaskColumn(t, jobsForTask);
    agg.total += 1;
    agg[column] += 1;
    if (Array.isArray(t.subtasks)) {
      agg.errorSubtasks += t.subtasks.filter(s => s && s.status === 'error').length;
    }
    agg.lastActiveAt = laterOf(agg.lastActiveAt, t.updatedAt || t.createdAt);
    // 最后活跃时间也要把执行记录算进来：任务本身可能很久没改，但刚刚跑过
    for (const j of jobsForTask) {
      agg.lastActiveAt = laterOf(agg.lastActiveAt, j.endedAt || j.startedAt);
    }
  }

  // 活跃执行数按 job 数（不是任务数）：一个任务并行跑 3 个子任务就是 3 个活跃执行
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || (j.status !== 'running' && j.status !== 'pending')) continue;
    const key = taskProject.get(j.taskId);
    if (key && byKey.has(key)) byKey.get(key).runningJobs += 1;
  }

  for (const agg of byKey.values()) {
    agg.progress = agg.total > 0 ? Math.round((agg.done / agg.total) * 100) : 0;
  }
  return byKey;
}

/**
 * 合并最近目录与任务里的 projectPath，得到去重后的项目条目。
 * path 取"首次出现的写法"（先最近目录内部按原顺序、再任务），前端可以直接拿它跟其它列表对齐。
 *
 * ⚠️ "首次出现"要显式实现，不能靠 `map.set` 覆盖：常用目录里同一个目录
 * 出现两种写法是常态（`c:\users\xuze3` 与 `C:\Users\xuze3`），
 * 无脑 set 会让**最后一条**写法覆盖前面那条 —— 既违背上面这句约定
 * （界面上的路径会随常用目录顺序来回跳），也会把先命中过的 fromTasks 抹掉，
 * 让 `source` 从 'both' 退化成 'recent'。
 *
 * @param {{ recentDirs?: string[], tasks?: object[] }} input
 * @returns {Array<{ path: string, key: string, name: string, source: 'recent'|'task'|'both' }>}
 */
export function buildProjectEntries({ recentDirs = [], tasks = [] } = {}) {
  const map = new Map();
  for (const dir of recentDirs) {
    const key = canonicalProjectPath(dir);
    if (!key) continue;
    const hit = map.get(key);
    if (hit) hit.inRecent = true; // 同一目录的第二种写法：只并入来源，不覆盖 path
    else map.set(key, { path: String(dir).trim(), key, inRecent: true, fromTasks: false });
  }
  for (const t of tasks) {
    const key = canonicalProjectPath(t && t.projectPath);
    if (!key) continue; // 没关联项目的任务不进项目清单
    const hit = map.get(key);
    if (hit) hit.fromTasks = true;
    else map.set(key, { path: String(t.projectPath).trim(), key, inRecent: false, fromTasks: true });
  }
  return Array.from(map.values()).map(e => ({
    path: e.path,
    key: e.key,
    name: projectName(e.path),
    source: e.inRecent && e.fromTasks ? 'both' : (e.inRecent ? 'recent' : 'task'),
  }));
}

/** 从探测结果里摘出前端要用的 Git 字段（与原 git-state 接口返回口径一致） */
function pickGitState(state) {
  if (!state) return null;
  return {
    isGitRepo: state.isGitRepo,
    branch: state.branch || null,
    upstream: state.upstream || null,
    hasUpstream: !!state.hasUpstream,
    detached: !!state.detached,
    ahead: state.ahead || 0,
    behind: state.behind || 0,
    changed: state.changed || 0,
    staged: state.staged || 0,
    unstaged: state.unstaged || 0,
    untracked: state.untracked || 0,
  };
}

/**
 * 项目清单（含 Git 状态 + 任务统计）。
 *
 * @param {object} input
 * @param {string[]} input.recentDirs   configManager.getRecentDirectories() 的结果
 * @param {object[]} input.tasks        tasks.json 里的任务
 * @param {object[]} input.jobs         jobStore.snapshotJobs() 的结果
 * @param {string}   [input.currentProjectPath] 应用当前所在项目（用于打 isCurrent 标记）
 * @param {boolean}  [input.withGit]    是否探测 Git 状态（默认 true）
 * @param {object}   [input.probeOptions] 透传给 probeDirectoryGitStates（超时 / TTL / 并发）
 */
export async function listProjects({
  recentDirs = [],
  tasks = [],
  jobs = [],
  currentProjectPath = '',
  withGit = true,
  probeOptions,
} = {}) {
  const entries = buildProjectEntries({ recentDirs, tasks });
  const stats = summarizeProjectTasks(tasks, jobs);
  const currentKey = canonicalProjectPath(currentProjectPath);

  let states = {};
  if (withGit && entries.length > 0) {
    states = await probeDirectoryGitStates(entries.map(e => e.path), probeOptions);
  }

  return entries.map(e => {
    const state = withGit ? states[e.path] : null;
    return {
      path: e.path,
      key: e.key,
      name: e.name,
      source: e.source,
      isCurrent: !!currentKey && e.key === currentKey,
      // exists:true|false|null —— null 表示没探到（withGit=false 或探测超时），
      // 前端对 null 不显示任何"失效"标记，避免把未知谎报成目录不存在
      exists: state ? state.exists : null,
      git: pickGitState(state),
      stats: stats.get(e.key) || emptyStats(),
    };
  });
}

/** 看板任务卡需要的精简字段（完整任务体在 /api/workbench/tasks，这里只给卡片用得到的） */
export function decorateTaskForBoard(task, jobsForTask = []) {
  const subs = Array.isArray(task && task.subtasks) ? task.subtasks : [];
  const jobs = Array.isArray(jobsForTask) ? jobsForTask : [];
  const last = latestJob(jobs);
  return {
    id: task.id,
    title: task.title || '',
    desc: task.desc || '',
    type: task.type === 'simple' ? 'simple' : 'complex',
    projectPath: task.projectPath || '',
    column: deriveTaskColumn(task, jobs),
    subtaskCount: subs.length,
    subtaskDoneCount: subs.filter(s => s && s.status === 'done').length,
    subtaskErrorCount: subs.filter(s => s && s.status === 'error').length,
    attachmentCount: Array.isArray(task.attachments) ? task.attachments.length : 0,
    runningJobs: jobs.filter(j => j && (j.status === 'running' || j.status === 'pending')).length,
    lastJobStatus: last ? last.status : null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
  };
}

// ── 任务详情（点卡片弹窗用） ────────────────────────────────────────────

/**
 * 弹窗里最多回多少字符的执行输出。
 *
 * 看板列表刻意只发摘要，因为它是 5s 轮询的：把每个任务的子任务描述、报错、
 * 执行输出全塞进去，十几条任务每 5 秒推一遍纯属浪费（单条输出动辄几十万字符）。
 * 详情改成按需取一次，并且**在服务端截尾**——弹窗要回答的是"最近一次执行干了什么、
 * 卡在哪了"，不是把整份日志搬进 DOM。想看全文有编辑器和 job 管理页。
 */
export const OUTPUT_TAIL_CHARS = 4000;

/**
 * 把一条 job 压成弹窗够用的形状：丢掉 prompt/thinking（可能极大），
 * output 只留尾部 OUTPUT_TAIL_CHARS 字符，并用 outputTruncated 明确告知被截过
 * —— 前端据此提示"仅显示末尾"，而不是让人以为整个输出就这么点。
 */
export function trimJobForDetail(job) {
  if (!job) return null;
  const out = typeof job.output === 'string' ? job.output : '';
  const truncated = out.length > OUTPUT_TAIL_CHARS;
  return {
    id: job.id || '',
    subId: job.subId || '',
    title: job.title || '',
    subTitle: job.subTitle || '',
    status: job.status || '',
    pid: typeof job.pid === 'number' ? job.pid : null,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    exitCode: typeof job.exitCode === 'number' ? job.exitCode : null,
    error: job.error || '',
    outputTail: truncated ? out.slice(-OUTPUT_TAIL_CHARS) : out,
    outputTruncated: truncated,
    hasOutput: out.length > 0,
  };
}

/**
 * 组装单个任务的详情。纯函数，单测覆盖。
 *
 * @param {object} task           完整任务（含 subtasks / attachments）
 * @param {Array}  jobsForTask    属于该任务的 job（顺序不限，内部会按时间排）
 * @param {number} recentJobLimit 最多回带几条 job 明细（默认 10）
 * @returns {object|null}         task 缺失时返回 null，由路由转成 404
 */
export function buildTaskDetail(task, jobsForTask = [], { recentJobLimit = 10 } = {}) {
  if (!task || !task.id) return null;
  const jobs = (Array.isArray(jobsForTask) ? jobsForTask : []).filter(Boolean);

  // 按时间倒序：弹窗里第一条就是「最近一次执行」
  const sorted = [...jobs].sort((a, b) => {
    const ta = jobTimestamp(a);
    const tb = jobTimestamp(b);
    if (ta === tb) return 0;
    return ta < tb ? 1 : -1;
  });

  const limit = Number.isFinite(recentJobLimit) && recentJobLimit > 0 ? Math.floor(recentJobLimit) : 10;
  return {
    task,
    column: deriveTaskColumn(task, jobs),
    lastJob: trimJobForDetail(sorted[0] || null),
    recentJobs: sorted.slice(0, limit).map(trimJobForDetail),
    jobCount: jobs.length,
  };
}
