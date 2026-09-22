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
// g ai 的 list_projects 工具：数据源与格式化。
//
// 解决什么问题：GUI 里最近项目面板早就把"哪些项目落后了几个提交"算好了，但那份数据
// 只走 HTTP 给前端，g ai 的上下文里一个字段都没有。于是用户问"我哪些项目需要 pull"，
// 它只能去 list_files 扫盘 —— 本仓库实测扫出 37 个 git 仓库（node_modules 里的嵌套
// 仓库也算），跟界面上那 9 个最近项目完全不是一套口径。
//
// 为什么单独一个模块，不写进 src/cli/ai/tools.js：
//   那个文件被 CLI 与 Web 两端共用，是"有哪些工具"的清单；最近目录、tasks.json、
//   看板统计都只存在于 GUI 侧，塞进去等于让 CLI 反向依赖 UI。这里把数据源与格式化
//   收在一起，由 workbench/agentRoutes.js 注入进工具上下文，tools.js 只留一句转发。
//   （同一手法见 taskRunner.setEnvContextProvider：只有 GUI 侧拿得到这些依赖。）
//
// 口径必须与界面对齐，所以这里**只**调用 projectRegistry 的 listProjects：
//   最近目录 ∪ 任务里的 projectPath → buildProjectEntries，
//   Git 状态 → probeDirectoryGitStates，任务分列 → summarizeProjectTasks。
//   一条都不重新实现 —— 面板显示"落后 4"，g ai 也必须说"落后 4"。
//
// refresh 为什么存在：领先/落后读的是本地 remote-tracking 引用，也就是"上次 fetch
// 时的快照"（见 directoryGitState.js 文件头）。不 fetch 就回答"你不需要 pull"是错的
// ——用户最初问的恰好就是这句。所以给一个 opt-in 的 refresh，复用「刷新全部」按钮
// 背后那个 fetchDirectoryRemotes（同一个进程内 in-flight 保护也一并继承）。

import { listProjects } from './projectRegistry.js';
import { readJson, TASKS_FILE } from './shared.js';
import { snapshotJobs } from './jobStore.js';
import { fetchDirectoryRemotes } from '../../utils/directoryFetch.js';

/**
 * refresh=true 时逐个项目联网 fetch 的并发数。
 * 与「最近项目」面板的「刷新全部」取同一档（RecentDirectoriesList.vue 的
 * REFRESH_CONCURRENCY）—— 界面同一个动作是什么节奏，g ai 触发时就是什么节奏。
 */
const REFRESH_CONCURRENCY = 6;

/** 单个仓库的 fetch 失败原因最多回几条：全塞进去会把这轮工具输出淹掉 */
const MAX_REPORTED_FAILURES = 5;

function gitLineOf(p) {
  if (p.exists === false) return '目录不存在（可能已被删除或移动）';
  const g = p.git;
  if (!g) return 'Git 状态未探到（上次探测超时，重跑一次可能就有了）';
  if (g.isGitRepo !== true) return '不是 Git 仓库';

  const parts = [];
  parts.push(g.detached ? 'HEAD 处于 detached 状态' : `分支 ${g.branch || '(未知)'}`);
  if (g.hasUpstream && g.upstream) {
    const track = [];
    if (g.behind > 0) track.push(`落后 ${g.behind}`);
    if (g.ahead > 0) track.push(`领先 ${g.ahead}`);
    parts.push(`${g.upstream}${track.length ? `（${track.join(' · ')}）` : '（已同步）'}`);
  } else {
    parts.push('未配置上游分支');
  }
  if (g.changed > 0) {
    parts.push(`工作区 ${g.changed} 项未提交（已暂存 ${g.staged} · 未暂存 ${g.unstaged} · 未跟踪 ${g.untracked}）`);
  } else {
    parts.push('工作区干净');
  }
  return parts.join(' · ');
}

function taskLineOf(p) {
  const s = p.stats || {};
  if (!s.total) return '任务: 无';
  const parts = [`待处理 ${s.todo || 0}`, `进行中 ${s.doing || 0}`, `已完成 ${s.done || 0}`];
  if (s.runningJobs > 0) parts.push(`正在执行 ${s.runningJobs}`);
  return `任务: ${parts.join(' / ')}`;
}

/**
 * 把 listProjects 的结果拼成给模型看的文本。纯函数，单测覆盖。
 *
 * @param {object[]} projects listProjects() 的输出
 * @param {object}   [opts]
 * @param {boolean}  [opts.refreshed] 本轮是否已联网 fetch 过
 * @param {object}   [opts.fetchStats] refreshProjects() 的统计（未刷新时为 null）
 * @param {string}   [opts.tasksFile]  tasks.json 路径（给模型一条"要细节自己读"的路）
 * @returns {string}
 */
export function formatProjectList(projects, { refreshed = false, fetchStats = null, tasksFile = '' } = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const lines = [];
  // 抬头必须写清"这是什么口径"，否则模型会以为自己看到的是一份普通目录扫描结果
  lines.push(`[用户本机的「最近项目」清单 · 与 g ui 最近项目面板同一口径 · 共 ${list.length} 个]`);
  lines.push(refreshed
    ? '本轮已对每个项目执行 git fetch（领先/落后是 fetch 之后的真实值）。'
    : '⚠️ 领先/落后读的是本地 remote-tracking 引用，即"上次 fetch 时的快照"，不是实时值；'
      + '用户问的是否需要 pull / 推送时，应带 refresh=true 重跑一次再下结论。');
  lines.push('');

  list.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name || p.path}${p.isCurrent ? '  ← 当前所在项目' : ''}`);
    lines.push(`   路径: ${p.path}`);
    lines.push(`   Git: ${gitLineOf(p)}`);
    lines.push(`   ${taskLineOf(p)}`);
  });

  if (refreshed && fetchStats) {
    lines.push('');
    lines.push(`本轮 fetch 结果: 成功 ${fetchStats.ok} · 跳过 ${fetchStats.skipped}（非仓库/无 remote/已有刷新在跑）· 失败 ${fetchStats.failed}`);
    for (const f of fetchStats.failures.slice(0, MAX_REPORTED_FAILURES)) {
      lines.push(`  失败: ${f}`);
    }
    if (fetchStats.failures.length > MAX_REPORTED_FAILURES) {
      lines.push(`  …还有 ${fetchStats.failures.length - MAX_REPORTED_FAILURES} 条失败未列出`);
    }
  }

  if (tasksFile) {
    lines.push('');
    lines.push(`要任务细节（标题/描述/子任务/报错）直接读: ${tasksFile}`);
  }
  return lines.join('\n');
}

/**
 * 逐个项目 git fetch，带回三态计数。
 * 并发上限与面板一致；单个失败只记账，不中断整轮（fetchDirectoryRemotes 本身不抛）。
 */
async function refreshProjects(projects) {
  // 不存在的目录没有 fetch 的意义（后端也会跳过），先剔除省一轮请求
  const targets = projects.filter(p => p.exists !== false).map(p => p.path);
  const stats = { ok: 0, skipped: 0, failed: 0, failures: [] };
  let cursor = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      const r = await fetchDirectoryRemotes(target);
      if (r.status === 'ok') stats.ok += 1;
      else if (r.status === 'failed') {
        stats.failed += 1;
        stats.failures.push(`${target}: ${r.timeout ? `fetch 超时（超过 ${r.timeoutSeconds ?? 30} 秒）` : (r.error || 'fetch 失败')}`);
      } else {
        stats.skipped += 1;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(REFRESH_CONCURRENCY, targets.length)) }, worker),
  );
  return stats;
}

/**
 * 生成注入给工具上下文的 listProjects 实现。
 *
 * @param {object}   deps
 * @param {object}   deps.configManager         读最近目录（与看板同一份配置）
 * @param {Function} [deps.getCurrentProjectPath] 当前项目路径，用于打"← 当前"
 * @returns {(args?: { refresh?: boolean }) => Promise<string>}
 */
export function createProjectListProvider({ configManager, getCurrentProjectPath } = {}) {
  return async function listProjectsForAgent({ refresh = false } = {}) {
    let recentDirs = [];
    try {
      recentDirs = (await configManager.getRecentDirectories()) || [];
    } catch {
      // 与看板同一退路：读不到最近目录就只按"任务里出现过的项目"列
    }
    const { tasks } = await readJson(TASKS_FILE, { tasks: [] });
    const jobs = snapshotJobs();
    const taskList = Array.isArray(tasks) ? tasks : [];
    const currentProjectPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';

    const probeOptions = refresh ? { useCache: false } : undefined;
    let projects = await listProjects({ recentDirs, tasks: taskList, jobs, currentProjectPath, probeOptions });

    let fetchStats = null;
    if (refresh && projects.length > 0) {
      fetchStats = await refreshProjects(projects);
      // fetch 动了 remote-tracking 引用 → 重探一次。必须 useCache:false：
      // 否则拿到的是 15s TTL 里 fetch 之前那份快照，等于白刷（与 fs.js 的 fetch 路由同因）。
      projects = await listProjects({
        recentDirs, tasks: taskList, jobs, currentProjectPath, probeOptions: { useCache: false },
      });
    }

    return formatProjectList(projects, { refreshed: refresh, fetchStats, tasksFile: TASKS_FILE });
  };
}
