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
// 工作区状态快照的**生成、缓存与定向刷新**。
//
// 解决什么问题:g ai 过去只知道自己 cwd 那点事。问"我 GitHub 上有些什么仓库""工作台还有
// 哪些没做完""思维导图都放在哪",它要么答"我看不到",要么现场一条条命令去刨。
// 数据其实全在本机,只是没人告诉它。
//
// 与 envContext.js 的分工(两者**互补、不重叠**):
//   · envContext 服务于**多项目编排台派发的任务**,注入后立刻执行,只覆盖项目与看板;
//   · 这里服务于**智能体页的日常对话**,覆盖七个板块,落盘成文件供按需读取。
//   共用同一条"摘要内联 + 路径外挂"的口径,细节见 render.js 头注释。
//
// ⚠️ 五个设计约束,改动前先读:
//
// 1) **跑在服务端,与界面挂载状态无关。**
//    不是从 pinia store 里抓状态 —— 那要求用户先把七个 tab 都点一遍(见 App.vue:995-1034
//    的 v-if 懒挂载),没点过的板块永远是空文件;两个 g ui 实例并行还会互相覆盖。
//    服务端这边 config / tasks / git CLI / os 全在手边,一次 HTTP 都不用。
//
// 2) **按板块独立刷新,不做"定时全量重写"。**
//    七个板块的取数成本差两个数量级:git 状态是本地毫秒级,`gh` / `gitee` 拉列表要联网、
//    单条命令 25s 超时。统一按一个周期刷,要么本地板块不够新、要么联网板块把机器刷爆。
//    所以每个板块有**自己的** ttlMs,并提供 refreshSections(ids) 只刷指定的几块。
//    这一条也顺带解决了"刚刚改过配置"的写放大老问题(见 paths.js 注释)。
//
// 3) **绝不抛异常给调用方。**
//    它挂在对话链路上。某一板块取不到(CLI 没装、目录没了、磁盘忙)只该让那一块降级,
//    不该让用户这条消息发不出去。每个板块单独 try/catch,写盘失败也只记日志。
//
// 4) **绝不阻塞"用户按下发送 → 模型开始吐字"这段。**
//    读路径(getSnapshot / getBlock)一律不等生成:有就回、过期也**先回旧的**再后台定向刷。
//    生成只发生在 refreshAll / refreshSections / warm 里。这一条是踩出来的 ——
//    最初的实现 await 生成,直接挂掉了一个既有回归测试。
//    "实时性"不靠读路径等待来保证,靠两件事:① 各种时机主动刷新(见 agentRoutes 的
//    刷新端点 + 服务端启动预热),② 注入块里那句"要实时值就跑什么命令"。
//
// 5) **IO 全部走注入。**
//    本模块不 import 任何 workbench 内部模块 —— jobStore.js 在**模块加载时**就会
//    hydrateJobs() 并回写 ~/.zen-gitsync/jobs.json(见 promptParts.js 头注释),
//    import 进来会让单测碰到真实用户数据。调用方(wiring.js)本来就有这些依赖,传进来即可。

import path from 'node:path';
import fs from 'node:fs/promises';

import { AI_CONTEXT_DIR } from '../../../../paths.js';
import { atomicWriteText, ensureDir } from '../../../../fsAtomic.js';
import logger from '../../utils/logger.js';
import {
  AI_CONTEXT_SECTIONS,
  INDEX_FILE,
  buildContextBlock,
  formatStamp,
  renderIndexFile,
  renderSectionFile,
  sectionForceTtl,
  sectionMeta,
  sectionTtl,
} from './render.js';
import {
  collectCustomCommands,
  collectGit,
  collectMindmap,
  collectRemote,
  collectSystem,
  collectWorkbenchTasks,
} from './collectors.js';

/** 板块 id → 缺依赖时的失败结果(形状与 collector 的成功结果一致) */
function failedSection(id, message) {
  const meta = sectionMeta(id);
  return {
    id,
    title: meta?.title || id,
    file: meta?.file || `${id}.md`,
    ok: false,
    summary: '',
    lines: [],
    error: String(message ?? '未知错误'),
  };
}

/**
 * 建一个快照生成器。
 *
 * @param {object} deps
 * @param {object}   deps.configManager            需有 loadConfig / getRecentDirectories
 * @param {Function} deps.getCurrentProjectPath    () => string
 * @param {Function} deps.readTasks                () => Promise<object[]>
 * @param {Function} deps.readJobs                 () => Promise<object[]>
 * @param {Function} deps.probeGit                 (dir) => Promise<state>
 * @param {Function} deps.loadRemoteReposState     (provider) => Promise<state>
 * @param {Function} deps.getMonitorOverview       () => Promise<overview>
 * @param {Function} deps.listPorts                () => Promise<port[]>
 * @param {Function} deps.listMindmapFiles         (dir) => Promise<file[]>
 * @param {object}   [deps.truthFiles]             { tasksFile, jobsFile, configFile } 注入给模型看
 * @param {Function} [deps.now]                    便于测试注入时钟
 * @param {string}   [deps.dir]                    快照目录(默认 ~/.zen-gitsync/ai-context)
 */
export function createAiContextSnapshotter({
  configManager,
  getCurrentProjectPath,
  readTasks,
  readJobs,
  probeGit,
  loadRemoteReposState,
  getMonitorOverview,
  listPorts,
  listMindmapFiles,
  truthFiles = {},
  now = () => Date.now(),
  dir = AI_CONTEXT_DIR,
} = {}) {
  /**
   * 每个板块存**自己的**采集时刻 —— 这正是"按板块刷新"的落点。
   * 共用一个 at 会让"刚刷过的 git"和"十分钟前刷的仓库列表"看起来一样新。
   * @type {Map<string, { result: object, at: number }>|null}
   */
  let sections = null;
  /** 最近一次落盘时刻(只用于 INDEX 的"本次汇总时间") */
  let persistedAt = 0;
  /** 同一板块的并发生成共享同一个 Promise,避免几个时机同时触发时各拉一次网络 */
  const inflightById = new Map();

  function logWarn(msg) {
    try { logger.warn(`[ai-context] ${msg}`); } catch { /* 日志失败不影响主链路 */ }
  }

  function ensureCache() {
    if (!sections) sections = new Map();
    return sections;
  }

  function stateOf(id) {
    return sections?.get(id) || null;
  }

  function isSectionFresh(id) {
    const st = stateOf(id);
    if (!st) return false;
    return now() - st.at < sectionTtl(id);
  }

  /** 强制刷新时的地板:防止"切个面板就刷一次"把联网板块刷爆 */
  function isForceAllowed(id) {
    const st = stateOf(id);
    if (!st) return true;
    const floor = sectionForceTtl(id);
    return floor === 0 || now() - st.at >= floor;
  }

  /** 读配置/最近目录/当前项目 —— 每次刷新读一遍,它们本身很便宜 */
  async function loadCtx() {
    let config = null;
    try {
      config = await configManager?.loadConfig?.();
    } catch (err) {
      logWarn(`读取配置失败,自定义命令与思维导图目录这两块会降级: ${err?.message || err}`);
    }

    let recentDirs = [];
    try {
      recentDirs = (await configManager?.getRecentDirectories?.()) || [];
    } catch (err) {
      logWarn(`读取最近目录失败,项目清单可能不完整: ${err?.message || err}`);
    }

    const repoPath = typeof getCurrentProjectPath === 'function' ? (getCurrentProjectPath() || '') : '';
    const mindmapDirs = Array.isArray(config?.ui?.mindmapDirs) ? config.ui.mindmapDirs : [];
    return { config, recentDirs, repoPath, mindmapDirs };
  }

  /** 板块 id → 取数函数。每个都自己兜异常,返回形状统一的结果。 */
  async function collectOne(id, ctx) {
    try {
      switch (id) {
        case 'git':
          return await collectGit({ repoPath: ctx.repoPath, probe: probeGit });
        case 'github':
          return collectRemote({ provider: 'github', state: await loadRemoteReposState('github') });
        case 'gitee':
          return collectRemote({ provider: 'gitee', state: await loadRemoteReposState('gitee') });
        case 'commands':
          return collectCustomCommands({ config: ctx.config });
        case 'tasks':
          return collectWorkbenchTasks({
            tasks: await readTasks(),
            jobs: await readJobs(),
            recentDirs: ctx.recentDirs,
          });
        case 'system':
          return collectSystem({ overview: await getMonitorOverview(), ports: await listPorts() });
        case 'mindmap':
          return collectMindmap({ dirs: ctx.mindmapDirs, listDir: listMindmapFiles });
        default:
          return failedSection(id, '未知板块');
      }
    } catch (err) {
      logWarn(`板块 ${id} 取数失败: ${err?.message || err}`);
      return failedSection(id, err?.message || err);
    }
  }

  /** 取一个板块并按 id 去重并发 */
  function runSectionOnce(id, ctx) {
    const existing = inflightById.get(id);
    if (existing) return existing;
    const p = collectOne(id, ctx)
      .then((result) => {
        ensureCache().set(id, { result, at: now() });
        return result;
      })
      .finally(() => { inflightById.delete(id); });
    inflightById.set(id, p);
    return p;
  }

  /**
   * 落盘:只重写**本次刷新的那几个**板块文件,加上 INDEX(INDEX 必须全量重渲染 ——
   * 它是总览,任何一块更新了它都得跟着变)。
   *
   * 写失败**只记日志**:文件可能还是上一轮的内容(头部有时间戳,模型能看出来),
   * 但绝不因为磁盘忙就让用户这条消息发不出去。
   */
  async function persist({ ids, ctx }) {
    try {
      await ensureDir(dir);
    } catch (err) {
      logWarn(`创建快照目录失败: ${err?.message || err}`);
      return;
    }

    const scope = ctx?.repoPath ? `当前项目 ${ctx.repoPath}` : '';

    const writes = ids.map((id) => {
      const st = stateOf(id);
      if (!st) return Promise.resolve();
      const text = renderSectionFile({
        id,
        title: st.result.title,
        generatedAt: formatStamp(new Date(st.at)),
        // 「覆盖范围」只给 git 板块：其余六块（远程仓库 / 自定义命令 / 任务 / 系统 / 思维导图）
        // 讲的是整机与全账号的事,顶上写一句"覆盖范围: 当前项目 X"是错的 ——
        // 模型会以为那份 65 个仓库的清单只属于当前项目。
        scope: id === 'git' ? scope : '',
        lines: st.result.lines,
        error: st.result.ok ? '' : st.result.error,
      });
      return atomicWriteText(path.join(dir, st.result.file), text).catch(err => {
        logWarn(`写入 ${st.result.file} 失败: ${err?.message || err}`);
      });
    });

    persistedAt = now();

    writes.push(
      atomicWriteText(
        path.join(dir, INDEX_FILE),
        // INDEX 不写「覆盖范围」：它汇总的是七个不同范围的板块,没有统一的覆盖范围。
        renderIndexFile({
          generatedAt: formatStamp(new Date(persistedAt)),
          results: orderedResults(),
        }),
      ).catch(err => logWarn(`写入 ${INDEX_FILE} 失败: ${err?.message || err}`)),
    );

    await Promise.all(writes);
    await pruneUnknownFiles(new Set([INDEX_FILE, ...AI_CONTEXT_SECTIONS.map(s => s.file)]));
  }

  /**
   * 清掉目录里不属于任何已知板块的 .md。
   * 只删 .md —— 目录是我们自己生成的,但万一用户往里放了别的东西,不碰。
   * 典型场景:某板块以后被下线,它的旧文件不该继续被模型读到。
   */
  async function pruneUnknownFiles(keep) {
    try {
      const entries = await fs.readdir(dir).catch(() => []);
      await Promise.all(entries.map(async (name) => {
        if (!name.toLowerCase().endsWith('.md')) return;
        if (keep.has(name)) return;
        await fs.unlink(path.join(dir, name)).catch(() => {});
      }));
    } catch (err) {
      logWarn(`清理陈旧快照文件失败: ${err?.message || err}`);
    }
  }

  /** 按固定顺序取出已缓存的板块结果(带各自的 collectedAt,给注入块与 INDEX 用) */
  function orderedResults() {
    const out = [];
    for (const s of AI_CONTEXT_SECTIONS) {
      const st = stateOf(s.id);
      if (!st) continue;
      out.push({ ...st.result, collectedAt: formatStamp(new Date(st.at)), at: st.at });
    }
    return out;
  }

  /**
   * 定向刷新。
   *
   * @param {string[]} [ids]            要刷的板块 id;不传 = 全部
   * @param {object}   [options]
   * @param {boolean}  [options.force]  true 时忽略软 TTL;但仍受各自 forceTtlMs 地板限制
   *                                    (联网板块最多每 60s 拉一次,不受前端点击频率摆布)
   * @returns {Promise<object>} getState() 的结果
   */
  async function refreshSections(ids, { force = false } = {}) {
    const known = AI_CONTEXT_SECTIONS.map(s => s.id);
    const wanted = (Array.isArray(ids) && ids.length > 0 ? ids : known).filter(id => known.includes(id));
    const target = wanted.filter(id => (force ? isForceAllowed(id) : !isSectionFresh(id)));
    if (target.length === 0) return getState();

    const ctx = await loadCtx();
    await Promise.all(target.map(id => runSectionOnce(id, ctx)));
    await persist({ ids: target, ctx });
    return getState();
  }

  /** 全量刷新(仍按各板块 TTL 判定是否需要真跑) */
  function refreshAll({ force = false } = {}) {
    return refreshSections(AI_CONTEXT_SECTIONS.map(s => s.id), { force });
  }

  /**
   * 取快照 —— **永不阻塞**。
   *
   * 为什么不在这里等生成:生成要跑 git 探测 + `gh` / `gitee` 拉列表(单条 25s 超时) +
   * PowerShell 查磁盘。串在"用户按下发送"和"模型开始吐字"之间,首字节就被拖十几秒。
   *
   * 口径:有就回(不管新旧),同时把**过期的板块**推到后台去定向刷。
   * 冷启动(一份都没有)时回 null —— 调用方 getBlock 会退化成"只给实时查询方法"。
   */
  function getSnapshot() {
    const stale = AI_CONTEXT_SECTIONS.map(s => s.id).filter(id => !isSectionFresh(id));
    if (stale.length > 0 && sections && sections.size > 0) {
      // 已经有内容了 → 后台补刷过期的,本轮先用旧的
      refreshSections(stale).catch(() => {});
    }
    const results = orderedResults();
    if (results.length === 0) return Promise.resolve(null);
    return Promise.resolve({
      generatedAt: persistedAt ? formatStamp(new Date(persistedAt)) : '',
      results,
    });
  }

  /**
   * 主动预热/刷新。给"服务端刚起来""用户切到了某个面板"这类时机调用。
   * 不关心返回值,失败只记日志(refreshSections 内部已兜)。
   */
  function warm({ sections: ids, force = false } = {}) {
    return refreshSections(ids, { force }).catch((err) => {
      logWarn(`预热失败: ${err?.message || err}`);
      return getState();
    });
  }

  /**
   * 取注入给模型的上下文块。
   *
   * **永远返回非空**:即使一份快照都还没生成,块里也有"七个板块各自怎么查实时值"+
   * 快照目录 + 真相源路径 —— 这几样不需要取数,却是真正扛实时性的部分。
   * 所以这个函数不会抛、也不会回空串,调用方可以无条件注入。
   *
   * @param {{ locale?: string }} [options]
   * @returns {Promise<string>}
   */
  async function getBlock({ locale = 'zh' } = {}) {
    const snap = await getSnapshot();
    return buildContextBlock({
      generatedAt: snap?.generatedAt || '',
      results: snap?.results || [],
      dirPath: dir,
      truthFiles,
      locale,
    });
  }

  /** 当前各板块的状态(给刷新端点回执 / 排查用) */
  function getState() {
    return {
      dir,
      persistedAt: persistedAt ? formatStamp(new Date(persistedAt)) : null,
      sections: AI_CONTEXT_SECTIONS.map((s) => {
        const st = stateOf(s.id);
        return {
          id: s.id,
          title: s.title,
          file: s.file,
          ttlMs: s.ttlMs,
          forceTtlMs: s.forceTtlMs,
          collectedAt: st ? formatStamp(new Date(st.at)) : null,
          ageMs: st ? now() - st.at : null,
          fresh: isSectionFresh(s.id),
          ok: st ? st.result.ok : null,
          summary: st ? st.result.summary : '',
        };
      }),
    };
  }

  /** 让指定板块(默认全部)的缓存立即失效 */
  function invalidate(ids) {
    if (!sections) return;
    if (Array.isArray(ids) && ids.length > 0) {
      for (const id of ids) sections.delete(id);
      return;
    }
    sections.clear();
  }

  /**
   * 原样取某个板块的缓存结果(**含结构化 data**),不做任何刷新。
   *
   * 为什么不用 getSnapshot():那个函数会顺手把**其余过期的板块**推到后台去刷 ——
   * 对"打开智能体页聊天"是对的(用户接下来可能问任何一块),但 envContext 只在
   * 派发任务时取一次 tasks 板块,没理由因此去拉 gh/gitee。取不到就回 null,
   * 调用方自己降级。
   *
   * @param {string} id 板块 id
   * @returns {object|null}
   */
  function getSectionResult(id) {
    return stateOf(id)?.result || null;
  }

  return { getSnapshot, getBlock, refreshAll, refreshSections, warm, getState, invalidate, getSectionResult };
}

export { AI_CONTEXT_SECTIONS, INDEX_FILE };
