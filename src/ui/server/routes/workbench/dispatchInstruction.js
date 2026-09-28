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
// 「派发一条指令」的**唯一实现**。
//
// 两个入口共用它，刻意不各写一份：
//   1. POST /api/workbench/orchestrator/dispatch —— 人在主 Agent 控制台敲的指令；
//   2. 内置智能体的 dispatch_task 工具        —— g ai 自己派出去的活
//      （见 cli/ai/tools.js 的 toolDispatchTask 与 routes/workbench/agentRoutes.js 的 ctx 注入）。
//
// 为什么必须共用：这条链路里全是"口径"——落点怎么判、默认提示词附加哪一级、
// 指令流水记什么、执行器怎么回落、附件从暂存区怎么搬。两份实现分叉的失效方式是
// 「不报错，只是 prompt 里少一段 / 落点不一样」，只能靠人眼比对才发现 —— 与
// agentParity.test.js 里钉的那几条（提示词四处、路径归一三处）同一类坑。
//
// 依赖全部走形参或独立模块（configManager / getCurrentProjectPath 由调用方注入），
// 所以本文件不 import index.js —— 那条边一旦建立就是循环依赖。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../../utils/asyncRoute.js';
import {
  logger,
  readJson,
  writeJson,
  nowIso,
  genId,
  TASKS_FILE,
  IMAGES_DIR,
  MAX_ATTACHMENTS_PER_TASK,
} from './shared.js';
import { stagingPath, mimeForExt } from './attachmentUtils.js';
import { readOrchestrator, resolveDispatchPrompt, appendInstruction } from './orchestratorStore.js';
import { buildProjectEntries } from './projectRegistry.js';
import { resolveInstructionTarget } from './targetResolver.js';
import { runSingleSubtask } from './taskRunner.js';
import { normalizeTaskExecutor as normalizeExecutorId } from '../../../../config.js';
import { publish } from './jobStore.js';

/**
 * 解析本次执行用哪个执行器：显式指定 > 配置里的全局默认 > 'claude'。
 * 配置读失败一律回落 'claude' —— 执行器选不出来不该挡住任务本身能跑。
 *
 * ⚠️ 两个 normalizeTaskExecutor **同名但语义相反**，这里必须用 config.js 那个：
 *   · config.js      ：非法 / 缺省返回 **null**（给"?? 回落"用），本函数要的就是它；
 *   · taskRunner.js  ：非法 / 缺省返回 **'claude'**（给"永远给得出一个值"用），
 *                      taskRunner 自己是执行入口，必须拿到可 spawn 的名字。
 *   2026-09-28 修：此前本函数用的是 taskRunner 那版，于是 `explicit` 恒为真值 →
 *   **下面读配置那一段从来没被执行过**，"设置里的全局默认执行器"永远不会生效，
 *   每次悄悄用 claude。表现和注释里担心的 ReferenceError 一模一样，但成因是重名，
 *   所以两处名字都保留（各自都是对的），只在导入时改名区分。
 *
 * ⚠️ `configManager` **必须从参数传进来**：这个模块是模块作用域，而 configManager
 * 由调用方注入 —— 直接引用会抛 ReferenceError，被下面这个 try 吞掉，表现为同一种
 * "默认执行器不生效"。以后往这个函数里加依赖，一律走形参。
 */
export async function resolveExecutor(requested, configManager) {
  const explicit = normalizeExecutorId(requested);
  if (explicit) return explicit;
  try {
    if (configManager) {
      const cfg = await configManager.loadConfig();
      const fallback = normalizeExecutorId(cfg?.taskExecutor);
      if (fallback) return fallback;
    }
  } catch (err) {
    logger.warn('[workbench] 读取 taskExecutor 配置失败,回落 claude:', err && err.message || err);
  }
  return 'claude';
}

/**
 * 建一个派发器。configManager / getCurrentProjectPath 是这条链路上唯二来自装配层的
 * 依赖（前者读全局默认执行器，后者是落点解析的最后兜底），其余全在独立模块里。
 *
 * @param {Object} deps
 * @param {Object} [deps.configManager]
 * @param {() => string} [deps.getCurrentProjectPath]
 * @param {(task: object, sub: object, repoPath: string, branch: string, opts: object) => Promise<any>} [deps.runTask]
 *        执行入口。**只为测试留的注入口**（与 aiContext 的 snapshotter、remoteRepos 的
 *        *Impl 同一套做法）：单测里真跑一次就会 spawn 用户本机真实的 claude CLI，
 *        既有额度消耗又不可复现。生产不传，走 taskRunner.runSingleSubtask。
 */
export function createDispatcher({ configManager, getCurrentProjectPath, runTask } = {}) {
  const launch = typeof runTask === 'function' ? runTask : runSingleSubtask;
  /**
   * 派发一条指令：落到某个项目下建一个任务，视闸门决定是否立刻执行。
   *
   * @param {Object} payload
   * @param {string} payload.text                指令正文（会原样成为该任务的 prompt）
   * @param {string} [payload.projectPath]       显式指定的落点；缺省交给 targetResolver 判断
   * @param {boolean} [payload.autoRun]          默认 true；false = 只建任务不执行
   * @param {boolean} [payload.useDefaultPrompt] 默认 true；false = 本次不附加默认提示词
   * @param {string} [payload.executor]          claude | opencode | codex；缺省走配置默认
   * @param {Array} [payload.attachments]        暂存区附件记录 [{ id, ext, originalName }]
   * @returns {Promise<{task: object, instruction: object, ran: boolean, schedulingActive: boolean, target: object}>}
   */
  async function dispatchInstruction(payload = {}) {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) throw new HttpError(400, '指令内容不能为空');
    if (text.length > 4000) throw new HttpError(400, '指令过长（上限 4000 字）');

    const fallbackPath = typeof getCurrentProjectPath === 'function' ? getCurrentProjectPath() : '';
    const bodyPath = typeof payload.projectPath === 'string' ? payload.projectPath.trim() : '';

    // 先把任务与项目清单读出来：解析落点要用它们。
    // 清单复用 buildProjectEntries（与看板 / 运行环境上下文同一套口径），
    // 刻意**不走** listProjects —— 那会 spawn git，派发不值得为它多等一轮。
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = data.tasks || [];

    let recentDirs = [];
    try {
      if (configManager && typeof configManager.getRecentDirectories === 'function') {
        recentDirs = (await configManager.getRecentDirectories()) || [];
      }
    } catch (err) {
      logger.warn('[workbench] 派发时读取最近目录失败，落点解析退化为仅按任务路径:', err.message);
    }

    const target = await resolveInstructionTarget({
      text,
      projects: buildProjectEntries({ recentDirs, tasks }),
      explicitPath: bodyPath,
      defaultPath: fallbackPath,
      // 懒取模型：只有「指令里没点名、也没被显式指定」时才会真的读 config 去问模型
      getModel: async () => {
        if (!configManager) return null;
        const rawConfig = await configManager.readRawConfigFile();
        const models = Array.isArray(rawConfig.models) ? rawConfig.models : [];
        return models.find(m => m.isDefault) || models[0] || null;
      },
      onAgentError: (err) => {
        logger.warn('[workbench] 主 Agent 判断指令落点失败，退到默认项目:', err.message);
      },
    });

    const targetPath = target.path;
    if (!targetPath) {
      throw new HttpError(400, '没能识别出目标项目，也没有默认项目可用 —— 先在左侧打开或选一个项目');
    }

    // 目标目录必须真的存在：跑在不存在的工作区上只会拿到一堆无意义的报错
    let stat = null;
    try { stat = await fsp.stat(targetPath); } catch { /* 下面统一报错 */ }
    if (!stat || !stat.isDirectory()) {
      const rejected = await appendInstruction({
        text,
        projectPath: targetPath,
        status: 'rejected',
        reason: '项目目录不存在',
        targetSource: target.source,
      });
      publish('orchestrator:instruction', rejected);
      throw new HttpError(400, `项目目录不存在：${targetPath}`);
    }

    const autoRun = payload.autoRun !== false;
    // 调度开关与默认提示词同在一份 state 里，只读一次：
    // 分开读两次必然出现"读到的是两个瞬间"的窗口（改设置的同时派发）。
    const orchestratorState = await readOrchestrator();
    const schedulingActive = orchestratorState.active;

    // 默认提示词按**落点项目**解析：全局那条对所有项目生效，项目级那条只在这个项目追加。
    // useDefaultPrompt=false 是"这一次不附加" —— 全局提示词若没法单次关掉，
    // 偶尔发一条纯指令就得先去设置里把它删了，再粘回来。
    const dispatchPrompt = payload.useDefaultPrompt === false
      ? { text: '', source: '' }
      : resolveDispatchPrompt(orchestratorState, targetPath);

    // ── 附件：调用方只回传 { id, ext, originalName }，服务端按 id 回暂存区找文件 ──
    // 路径完全由服务端拼（stagingPath 会同时校验 id 形状与 ext 白名单），
    // 所以不存在"调用方指定任意路径"这回事 —— 比"信任 absolutePath 再校验前缀"干净。
    // 数量与文件存在性在这里统一校验：上传时服务端是无状态的，压根不知道攒了几个。
    const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (rawAttachments.length > MAX_ATTACHMENTS_PER_TASK) {
      throw new HttpError(400, `附件最多 ${MAX_ATTACHMENTS_PER_TASK} 个`);
    }
    const staged = [];
    for (const item of rawAttachments) {
      const attId = typeof item?.id === 'string' ? item.id : '';
      const ext = typeof item?.ext === 'string' ? item.ext : '';
      const from = stagingPath(attId, ext);
      if (!from) throw new HttpError(400, '附件参数不合法');
      let attStat = null;
      try { attStat = await fsp.stat(from); } catch { /* 下面统一报错 */ }
      if (!attStat || !attStat.isFile()) throw new HttpError(400, '附件已失效，请重新添加');
      staged.push({
        id: attId,
        ext,
        from,
        size: attStat.size,
        originalName: String(item?.originalName || `attachment.${ext}`).slice(0, 200),
      });
    }

    // tasks / data 已在上面读好（落点解析要用），这里不再重复读一遍
    const now = nowIso();
    const taskId = genId();

    // 附件从暂存区搬进任务自己的目录（`_task-{id}/`），这样删除任务时会被一并清掉
    const attachmentDir = path.join(IMAGES_DIR, '_task-' + taskId);
    const attachments = [];
    if (staged.length > 0) {
      await fsp.mkdir(attachmentDir, { recursive: true });
      for (const s of staged) {
        const storedName = `${s.id}.${s.ext}`;
        const dest = path.join(attachmentDir, storedName);
        try {
          await fsp.rename(s.from, dest);
        } catch {
          // 极端情况（跨卷等）退化成复制 + 删除；仍失败就跳过这个附件，
          // 而不是让整条指令派发不出去 —— 指令本身是好的，不该被一个文件拖死。
          try {
            await fsp.copyFile(s.from, dest);
            await fsp.unlink(s.from);
          } catch { continue; }
        }
        attachments.push({
          id: s.id,
          originalName: s.originalName,
          mimeType: mimeForExt(s.ext),
          size: s.size,
          ext: s.ext,
          storedName,
          absolutePath: dest,
          createdAt: now,
        });
      }
    }

    const task = {
      id: taskId,
      // 标题取指令首行并截断：看板卡片只占一行，整段指令塞进标题会把卡片撑爆
      title: text.split('\n')[0].slice(0, 120),
      desc: text,
      promptId: null,
      // 默认提示词在派发这一刻抄进任务（这次生效的是什么，任务自己记着）。
      // 之后用户改设置不会回头改写它 —— 一条已存在的任务，"它当时是被怎么派出去的"
      // 是既成事实，不是当前配置的投影。
      simpleOverride: dispatchPrompt.text,
      projectPath: targetPath,
      attachments,
      status: 'todo',
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(task);
    await writeJson(TASKS_FILE, { tasks });

    const willRun = autoRun && schedulingActive;
    const record = await appendInstruction({
      text,
      projectPath: targetPath,
      taskId: task.id,
      status: willRun ? 'accepted' : 'created',
      reason: autoRun && !schedulingActive ? '调度已暂停，只建了任务未执行' : '',
      // 落点是怎么定下来的（explicit / mention / agent / default），
      // 记下来才能在流水里回答用户那句"为什么派到这儿了"
      targetSource: target.source,
      // 附带的是哪一级默认提示词（'' = 没带）。流水里要能说清"这段话是谁加的"
      promptSource: dispatchPrompt.source,
    });

    publish('task:created', { task });
    publish('orchestrator:instruction', record);

    // 与 POST /tasks/:id/run 走同一条执行路径，避免出现第二套执行入口
    let executor = null;
    if (willRun) {
      const virtualSub = {
        id: `${task.id}__simple`,
        title: task.title,
        desc: task.desc || '',
        status: 'todo',
        // 提示词取自 task.simpleOverride（派发时已把
        // 全局/项目默认提示词抄进去），而不是在这里再解析一次配置
        promptOverride: task.simpleOverride || '',
        attachments: [],
      };
      // 派发入口可以显式指定执行器；不传则用配置里的全局默认（resolveExecutor 走回落链）
      executor = await resolveExecutor(payload.executor, configManager);
      launch(task, virtualSub, targetPath, '', { executor }).catch(err => {
        publish('task:error', { taskId: task.id, error: err.message });
      });
    }

    // executor 一并回给调用方：HTTP 响应与 dispatch_task 的结果文案都要说清"这条任务
    // 交给了谁"。只建不跑时是 null —— 那时不必为它多读一次配置。
    return { task, instruction: record, ran: willRun, schedulingActive, target, executor };
  }

  return { dispatchInstruction };
}
