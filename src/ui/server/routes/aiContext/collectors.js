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
// 各板块的取数 + 归纳。
//
// 分两层,刻意的:
//   · **IO 层**(probe / listDir / loadRemoteReposState)全部走参数注入,生产传真实实现,
//     单测传假实现 —— 不联网、不 spawn、不碰真实用户数据(与 remoteRepos 的 *Impl 同一套做法)。
//   · **归纳层**是纯函数:把数据压成「一行摘要 + 若干正文行」。口径在这里唯一实现。
//
// 每个 collector 都回同一个形状:
//   { id, title, file, ok, summary, lines, error }
// 失败时 ok=false 且 error 有值 —— **绝不静默返回空**,因为空会被模型读成"没有"。
// (agentChat 的系统提示里为 gh/gitee 写了三段就是在防这个误读。)

import { AI_CONTEXT_SECTIONS, sectionMeta, oneLine, truncate } from './render.js';
import { summarizeProjectTasks, buildProjectEntries, TASK_COLUMNS } from '../workbench/projectRegistry.js';

const COLUMN_LABELS = { todo: '待处理', doing: '进行中', done: '已完成' };

/** 任务清单在文件里最多列几条(超了只给计数,细节让模型去看 tasks.json) */
export const TASKS_FILE_LIMIT = 60;
/** 项目清单在文件里最多列几行 */
export const PROJECTS_FILE_LIMIT = 30;
/** 端口清单最多列几行 */
export const PORTS_FILE_LIMIT = 40;
/** 远程仓库清单最多列几行 */
export const REPOS_FILE_LIMIT = 80;
/**
 * 摘要里最多带几个仓库名当"预览"。
 *
 * 为什么摘要不能只写"N 个仓库":用户问的就是"我的 Gitee 有哪些项目"。只给数量,
 * 模型得先想到去读文件才能回答;带上前几个名字,它一眼就知道**答案在手边**,
 * 并且有个由头去读全量清单。名字很短、几乎不变,这点常驻开销换的是"不用猜"。
 */
export const REPOS_SUMMARY_PREVIEW = 5;

function fail(id, message) {
  const meta = sectionMeta(id);
  return { id, title: meta?.title || id, file: meta?.file || `${id}.md`, ok: false, summary: '', lines: [], error: oneLine(message) };
}

function ok(id, summary, lines = [], data = null) {
  const meta = sectionMeta(id);
  const shape = { id, title: meta?.title || id, file: meta?.file || `${id}.md`, ok: true, summary: oneLine(summary), lines, error: '' };
  // `data` 是给**另一个视图**用的结构化数据（目前只有 tasks 板块用）：
  // 渲染成文件/注入块的摘要归本模块，但"项目清单 + 各列计数 + 合计"这类数字
  // 还要被 envContext（多项目编排台视角）复用。带上它，两条链路就只有一个口径。
  // 刻意用**纯对象**（Map 转掉）—— 它会跟着结果对象一路传到快照缓存里，
  // 万一哪天被 JSON.stringify 序列化，Map 会静默变成 {}。
  if (data && typeof data === 'object') shape.data = data;
  return shape;
}

function gb(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0GB';
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

// ── ① 当前项目 Git 状态 ────────────────────────────────────────
/**
 * 复用 directoryGitState 的 probeDirectoryGitState(自带 15s TTL 缓存),
 * 不再多 spawn 一次 `git status`:分支/改动数它就够了,文件级清单留给模型自己跑。
 */
export async function collectGit({ repoPath = '', probe } = {}) {
  if (!repoPath) return fail('git', '未拿到当前项目路径');
  if (typeof probe !== 'function') return fail('git', '内部错误:缺少 git 状态探测实现');

  let state;
  try {
    state = await probe(repoPath);
  } catch (err) {
    return fail('git', `探测失败: ${err?.message || err}`);
  }
  if (!state) return fail('git', '探测未返回结果');
  if (state.exists === false) return fail('git', `目录不存在: ${repoPath}`);
  if (!state.isGitRepo) {
    return ok('git', `${repoPath} 不是 git 仓库`, [`- 路径: ${repoPath}`, '- 状态: 不是 git 仓库']);
  }

  const branch = state.detached ? '(分离 HEAD)' : (state.branch || '(未知分支)');
  const track = state.hasUpstream
    ? `领先 ${state.ahead || 0} / 落后 ${state.behind || 0}`
    : '无上游分支';
  const dirty = state.changed || 0;
  const summary = dirty > 0
    ? `分支 ${branch}，${track}，未提交 ${dirty} 个文件`
    : `分支 ${branch}，${track}，工作区干净`;

  const lines = [
    `- 路径: ${repoPath}`,
    `- 分支: ${branch}${state.upstream ? ` → ${state.upstream}` : ''}`,
    `- 领先/落后（本地快照，未联网 fetch）: 领先 ${state.ahead || 0} / 落后 ${state.behind || 0}`,
    `- 未提交改动: ${dirty} 个文件（已暂存 ${state.staged || 0} / 未暂存 ${state.unstaged || 0} / 未跟踪 ${state.untracked || 0}）`,
    '',
    '要文件级清单（具体改了哪些文件）请自己跑 `git status --porcelain`。',
  ];
  return ok('git', summary, lines);
}

// ── ②③ 远程仓库(GitHub / Gitee) ────────────────────────────────
/**
 * 纯函数:把 loadRemoteReposState 的结果归纳成板块。
 *
 * 这里严防的三种误读:
 *   · 没装 CLI → 必须写成"未检测到 gh"，不能是空清单（否则模型答"你没有仓库"）
 *   · 装了没登录 → 必须点明"未登录"，并给出登录命令
 *   · 拉取报错 → 必须把原因带上，且说明"清单可能不完整"
 */
export function collectRemote({ provider, state } = {}) {
  const id = provider === 'gitee' ? 'gitee' : 'github';
  const label = id === 'gitee' ? 'Gitee' : 'GitHub';
  const cli = id === 'gitee' ? 'gitee' : 'gh';
  if (!state) return fail(id, '未拿到检测结果');

  if (!state.installed) {
    return ok(id, `未检测到 ${cli} CLI，取不到仓库列表`, [
      `- ${cli} CLI: 未安装（或不在服务端进程的 PATH 里）`,
      `- 前端「远程仓库」页可一键安装/登录；装好后可能需重启服务才能被服务端看见`,
      '',
      '⚠️ 这不是"用户没有仓库"，只是取不到。不要据此回答"你没有仓库"。',
    ]);
  }

  if (!state.authenticated) {
    return ok(id, `已装 ${cli} 但未登录，取不到仓库列表`, [
      `- ${cli} CLI: 已安装${state.version ? `（${state.version}）` : ''}`,
      `- 登录态: 未登录`,
      `- 登录命令: ${cli} auth login`,
      '',
      '⚠️ 这不是"用户没有仓库"，只是没登录。引导用户去登录，不要索要 token。',
    ]);
  }

  const repos = Array.isArray(state.repos) ? state.repos : [];
  const user = state.user || '';
  const head = [
    `- ${cli} CLI: 已安装${state.version ? `（${state.version}）` : ''}`,
    `- 登录账号: ${user || '(未能解析出账号名)'}`,
    `- 仓库数: ${repos.length}${state.truncated ? '（已截断，可能更多）' : ''}`,
  ];
  if (state.error) head.push(`- ⚠️ 上次拉取报错: ${oneLine(state.error)}（清单可能不完整）`);
  head.push('');

  const shown = repos.slice(0, REPOS_FILE_LIMIT);
  head.push(`## 仓库清单${repos.length > shown.length ? `（只列前 ${shown.length} 个）` : ''}`, '');
  for (const r of shown) {
    const parts = [r.name || r.fullName || '(无名)'];
    if (r.visibility) parts.push(r.visibility);
    if (r.language) parts.push(r.language);
    if (r.updatedAt) parts.push(`更新于 ${String(r.updatedAt).slice(0, 10)}`);
    if (r.description) parts.push(truncate(r.description, 60));
    head.push(`- ${parts.join(' | ')}`);
  }
  if (shown.length === 0) head.push('（该账号下没有可见仓库）');

  // 摘要带上前几个仓库名:用户问"我有哪些项目"时,模型不必先读文件才知道自己有没有能力回答
  const preview = repos
    .slice(0, REPOS_SUMMARY_PREVIEW)
    .map(r => r?.name || r?.fullName)
    .filter(Boolean);
  const previewText = preview.length > 0
    ? `（如 ${preview.join('、')}${repos.length > preview.length ? ' 等' : ''}）`
    : '';
  const summary = `${repos.length} 个仓库${state.truncated ? '（截断）' : ''}`
    + (user ? `，账号 ${user}` : '')
    + previewText;
  return ok(id, summary, head);
}

// ── ④ 自定义命令 ─────────────────────────────────────────────
/** 纯函数:读 config.customCommands（src/config.js:117 的唯一落点） */
export function collectCustomCommands({ config } = {}) {
  const cmds = Array.isArray(config?.customCommands) ? config.customCommands : [];
  const lines = [];
  for (const c of cmds) {
    if (!c) continue;
    const name = c.name || c.command || '(未命名)';
    lines.push(`- ${name}${c.command ? ` → \`${oneLine(c.command)}\`` : ''}${c.description ? ` — ${truncate(c.description, 80)}` : ''}`);
  }
  if (lines.length === 0) lines.push('（没有配置自定义命令）');
  return ok('commands', `共 ${cmds.length} 条`, lines);
}

// ── ⑤ 工作台任务 ─────────────────────────────────────────────
/**
 * 纯函数。统计口径**复用 projectRegistry**:项目条目走 buildProjectEntries、
 * 任务分列走 summarizeProjectTasks —— 看板怎么分列,这里就怎么统计,不另写一份。
 */
export function collectWorkbenchTasks({ tasks = [], jobs = [], recentDirs = [] } = {}) {
  const allTasks = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const allJobs = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const projects = buildProjectEntries({ recentDirs, tasks: allTasks });
  const stats = summarizeProjectTasks(allTasks, allJobs);

  const total = { total: 0 };
  for (const k of TASK_COLUMNS) total[k] = 0;
  for (const s of stats.values()) {
    total.total += s.total;
    for (const k of TASK_COLUMNS) total[k] += s[k] || 0;
  }
  const runningJobs = allJobs.filter(j => j && (j.status === 'running' || j.status === 'pending')).length;

  const lines = [];
  lines.push(`## 项目清单（共 ${projects.length} 个）`, '');
  lines.push(`格式: 名称 | 路径 | ${TASK_COLUMNS.map(k => COLUMN_LABELS[k]).join('/')}`);
  for (const p of projects.slice(0, PROJECTS_FILE_LIMIT)) {
    const s = stats.get(p.key) || {};
    lines.push(`- ${p.name || p.key} | ${p.path} | ${TASK_COLUMNS.map(k => s[k] || 0).join('/')}`);
  }
  if (projects.length > PROJECTS_FILE_LIMIT) {
    lines.push(`- …还有 ${projects.length - PROJECTS_FILE_LIMIT} 个未列出`);
  }

  // 任务本体：状态 + 内容。列在这里是为了让模型不用先读 tasks.json 就能答"有哪些进行中的"。
  lines.push('', `## 任务明细（共 ${allTasks.length} 条）`, '');
  const jobsByTask = new Map();
  for (const j of allJobs) {
    if (!j || !j.taskId) continue;
    if (!jobsByTask.has(j.taskId)) jobsByTask.set(j.taskId, []);
    jobsByTask.get(j.taskId).push(j);
  }
  const sorted = [...allTasks].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const shown = sorted.slice(0, TASKS_FILE_LIMIT);
  for (const t of shown) {
    const js = jobsByTask.get(t.id) || [];
    const lastJob = js.length > 0
      ? [...js].sort((a, b) => String(b.endedAt || b.startedAt || '').localeCompare(String(a.endedAt || a.startedAt || '')))[0]
      : null;
    const meta = [];
    if (t.projectPath) meta.push(t.projectPath);
    if (lastJob?.status) meta.push(`最近执行 ${lastJob.status}`);
    if (t.updatedAt) meta.push(`更新于 ${String(t.updatedAt).slice(0, 16).replace('T', ' ')}`);
    const desc = t.description || t.desc || '';
    lines.push(`- [${t.title || t.id}]${meta.length ? ` (${meta.join(' · ')})` : ''}${desc ? ` — ${truncate(desc, 160)}` : ''}`);
  }
  if (sorted.length > shown.length) lines.push(`- …还有 ${sorted.length - shown.length} 条未列出（读下面的 tasks.json 看全）`);

  const summary =
    `全部项目合计 ${total.total} 条 —— ` +
    TASK_COLUMNS.map(k => `${COLUMN_LABELS[k]} ${total[k] || 0}`).join(' / ') +
    (runningJobs > 0 ? `，正在执行 ${runningJobs} 个` : '，当前无执行中的任务');

  // 结构化部分原样交出去：envContext（编排台视角）要拿它渲染"当前项目标记 + 项目清单"，
  // 而不是自己再读一遍 tasks.json / jobs.json。同一份数据、两个视图，口径不可能再分叉。
  return ok('tasks', summary, lines, {
    projects,
    statsByKey: Object.fromEntries(stats),
    total,
    runningJobs,
    taskCount: allTasks.length,
  });
}

// ── ⑥ 系统状态 ───────────────────────────────────────────────
/** 纯函数:吃 monitor 路由的 overview + ports 结果 */
export function collectSystem({ overview, ports } = {}) {
  if (!overview) return fail('system', '未拿到系统概览');
  const mem = overview.memory || {};
  const cpu = overview.cpu || {};
  const sys = overview.system || {};
  const lines = [
    `- 主机: ${sys.hostname || '(未知)'} · ${sys.platform || ''} ${sys.arch || ''}`,
    `- CPU 占用: ${(Number(cpu.usage) || 0).toFixed(1)}%${cpu.cores ? `（${cpu.cores} 核` : ''}${cpu.model ? ` · ${cpu.model}` : ''}${cpu.cores ? '）' : ''}`,
    `- 内存: ${(Number(mem.usagePercent) || 0).toFixed(1)}%（已用 ${gb(mem.used)} / 共 ${gb(mem.total)}）`,
    `- Node: ${sys.nodeVersion || ''}`,
  ];
  // getSystemOverview 给的 disks 是 `{ total, free, used, usagePercent, drives: [...] }`
  // （不是数组）；这里两种形状都认，免得以后有人改成数组就静默少一段。
  const disks = Array.isArray(overview.disks)
    ? overview.disks
    : (Array.isArray(overview.disks?.drives) ? overview.disks.drives : []);
  if (disks.length > 0) {
    lines.push('- 磁盘:');
    for (const d of disks) {
      const pct = Number(d.usagePercent ?? 0);
      lines.push(`  - ${d.mount || d.drive || d.path || '?'} 已用 ${gb(d.used)} / 共 ${gb(d.total)}（${Number.isFinite(pct) ? pct.toFixed(1) : '0'}%）`);
    }
  }

  const list = Array.isArray(ports) ? ports : [];
  lines.push('', `## 监听端口（${list.length} 个）`, '');
  for (const p of list.slice(0, PORTS_FILE_LIMIT)) {
    const pid = p.pid ?? p.PID ?? '';
    const proc = p.process || p.name || '';
    lines.push(`- ${p.protocol || ''} ${p.localAddress || p.address || ''}:${p.port ?? ''} ${pid ? `PID ${pid}` : ''} ${proc}`.trimEnd());
  }
  if (list.length === 0) lines.push('（没有查到监听端口）');
  if (list.length > PORTS_FILE_LIMIT) lines.push(`- …还有 ${list.length - PORTS_FILE_LIMIT} 个未列出`);

  const summary =
    `CPU ${(Number(cpu.usage) || 0).toFixed(1)}% · 内存 ${(Number(mem.usagePercent) || 0).toFixed(1)}%` +
    (disks.length > 0 ? ` · ${disks.length} 块磁盘` : '') +
    ` · ${list.length} 个监听端口`;
  return ok('system', summary, lines);
}

// ── ⑦ 思维导图 ───────────────────────────────────────────────
/**
 * 目录来自 config.ui.mindmapDirs（前端 mindmapStore 的落点）。
 * listDir 走注入:生产用路由里同一份 readdir 实现(见 routes/mindmap.js 的 listMindmapFiles),
 * 保证"快照里数出来的文件"和界面看到的是同一批。
 */
export async function collectMindmap({ dirs = [], listDir } = {}) {
  const roots = (Array.isArray(dirs) ? dirs : []).filter(d => typeof d === 'string' && d.trim());
  if (roots.length === 0) {
    return ok('mindmap', '未配置思维导图目录', ['（设置里还没添加思维导图工作区目录）']);
  }
  if (typeof listDir !== 'function') return fail('mindmap', '内部错误:缺少目录列举实现');

  const lines = [];
  let totalFiles = 0;
  const errors = [];
  for (const dir of roots) {
    let files = [];
    try {
      files = (await listDir(dir)) || [];
    } catch (err) {
      errors.push(`${dir}: ${err?.message || err}`);
      continue;
    }
    totalFiles += files.length;
    lines.push(`## ${dir}（${files.length} 个）`, '');
    if (files.length === 0) lines.push('（这个目录下没有 .mindmap.json）');
    for (const f of files) {
      const ts = f.mtime ? new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ') : '';
      lines.push(`- ${f.title || f.name}${ts ? ` | ${ts}` : ''}${f.size ? ` | ${Math.round(f.size / 1024)}KB` : ''}`);
    }
    lines.push('');
  }
  if (errors.length > 0) {
    lines.push('取数失败:', ...errors.map(e => `- ${e}`), '');
  }

  // 全部目录都读不到 → 整块判失败,不能报成"0 个导图"。
  // 零个导图和"目录都打不开"在摘要里长得一模一样,而后者会被模型读成
  // "用户没有思维导图"——这正是渲染层 renderSectionFile 反复在防的那种误读。
  if (errors.length === roots.length) {
    const failed = fail('mindmap', `全部 ${roots.length} 个目录都读取失败: ${errors[0]}`);
    failed.lines = lines;
    return failed;
  }

  const summary = `${roots.length} 个目录 · ${totalFiles} 个导图` + (errors.length > 0 ? `（${errors.length} 个目录读取失败）` : '');
  return ok('mindmap', summary, lines);
}

export { AI_CONTEXT_SECTIONS };
