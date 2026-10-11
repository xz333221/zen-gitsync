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
// 板块四(续):g ai 的定时任务 —— 读 + 增删改 + 立即跑。
//
// 关键边界:**任务库是文件,执行权在进程**。
// `~/.zen-gitsync/schedules.json` CLI 与 GUI 共享同一份(src/utils/scheduleStore.js),
// 所以 MCP 侧可以**直接落到文件**,不需要 g ui 在跑 —— 这和 dispatch_task 那条
// (必须转发)不一样。但到点执行的是 g ui 里的调度器,g ui 不在就不会跑。
// 所以每个写操作的结果里都要把这句说清楚:否则模型会向用户承诺"到点我会自动跑",
// 而那一刻 g ui 没开的话那就是一句错话。
//
// 与 CLI 里 `schedule_task` 工具(src/cli/ai/tools.js:933)的关系:
// 那是给 **g ai 自己**用的工具(只有一个扁平的 action 参数),这是给外部 Agent 用的
// MCP 工具(一动作一工具)。两者共用同一个 scheduleStore,不存在两套真相。
import {
  createTask,
  deleteTask,
  getTask,
  loadTasks,
  updateTask,
  MAX_TASKS,
  ON_MISSED,
  SESSION_MODES,
} from '../../utils/scheduleStore.js';
import { nextFireAfter, validateCron } from '../../utils/scheduleCron.js';
import { findLiveInstance, liveFetch, describeInstance, NO_LIVE_INSTANCE_HINT } from '../live.js';
import { SCHEDULES_FILE } from '../paths.js';
import { asBool, asInt, asString, truncate } from '../util.js';

/** updateTask 只认这批字段(id / lastFire / lastRun / sessionId 是系统字段) */
const UPDATABLE = ['name', 'schedule', 'cwd', 'prompt', 'model', 'enabled', 'sessionMode', 'onMissed'];

/** 把一条任务投影成"够读"的形状,并顺手算出下次触发时间。 */
function project(task) {
  let next = null;
  try {
    const d = task.enabled === false ? null : nextFireAfter(task.schedule, new Date());
    next = d ? new Date(d).toISOString() : null;
  } catch { next = null; }
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled !== false,
    schedule: task.schedule,
    next_fire_at: next,
    cwd: task.cwd,
    prompt: truncate(String(task.prompt || ''), 400),
    model: task.model || null,
    session_mode: task.sessionMode || null,
    on_missed: task.onMissed || null,
    last_fire: task.lastFire || null,
    last_run: task.lastRun ? { at: task.lastRun.at || null, status: task.lastRun.status || null } : null,
  };
}

/** 每次写操作都附的同一句提醒。写进结果里,而不是只在工具描述里说一次。 */
const SCHEDULER_CAVEAT =
  '调度器跑在 g ui 服务端进程里 —— g ui 不在时到点不会执行,'
  + '会按 on_missed 策略决定要不要补跑(run=重启后补一次,skip=直接跳过)。';

/** 校验 cron,不过就直接把原因回给模型(别让它瞎试)。 */
function checkCron(expr) {
  const result = validateCron(expr);
  if (!result?.ok) {
    return result?.error || `cron 表达式不合法: ${expr}`;
  }
  return null;
}

/** 拿一个任务,不存在时返回统一的错误对象(调用方直接 return 它) */
async function requireTask(id) {
  const taskId = asString(id);
  if (!taskId) return { error: '需要 id。先用 schedules_list 看有哪些任务。' };
  const task = await getTask(taskId);
  if (!task) return { error: `找不到定时任务 ${taskId}(已查 ${SCHEDULES_FILE})。` };
  return { taskId, task };
}

export const scheduleTools = [
  {
    name: 'schedules_list',
    description:
      '列出 g ai 的定时任务(名称、cron、工作目录、提示词、是否启用、上次执行结果、下次触发时间)。'
      + '任务库 CLI 与 GUI 共享;但真正到点执行的是 g ui 的调度器 —— g ui 不在时不会跑。',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const tasks = await loadTasks({ fresh: true });
      return {
        source: 'file',
        file: SCHEDULES_FILE,
        count: tasks.length,
        max: MAX_TASKS,
        tasks: tasks.map(project),
        note: SCHEDULER_CAVEAT,
      };
    },
  },

  {
    name: 'schedule_add',
    description:
      '新建一个定时任务:到点让 g ai 在指定项目目录下自动跑一段提示词。'
      + '直接落到任务库文件,不需要 g ui 正在运行(建和跑是两件事)。'
      + '⚠️ 这是**写操作**。schedule 必须是 5 字段 cron,如 "0 9 * * *" = 每天 9:00。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '任务名,如「每日拉代码」' },
        schedule: { type: 'string', description: 'cron 表达式(5 字段),如 "0 9 * * *"、"*/30 * * * *"' },
        prompt: { type: 'string', description: '到点后要让 g ai 做的事(完整指令)' },
        cwd: { type: 'string', description: '在哪个项目目录下跑(必须是已存在的目录);不传用调用方的当前目录' },
        enabled: { type: 'boolean', description: '是否启用,默认 true' },
        model: { type: 'string', description: '可选,指定模型' },
        session_mode: { type: 'string', enum: SESSION_MODES, description: '可选,dicated=复用专属会话(默认) / new=每轮新开' },
        on_missed: { type: 'string', enum: ON_MISSED, description: '可选,g ui 不在时错过怎么办:run=重启后补跑(默认) / skip=跳过' },
      },
      required: ['name', 'schedule', 'prompt'],
    },
    async handler(args, ctx) {
      const name = asString(args?.name);
      if (!name) return { created: false, error: '需要 name(任务名)。' };
      const schedule = asString(args?.schedule);
      if (!schedule) return { created: false, error: '需要 schedule(cron 表达式,如 "0 9 * * *")。' };
      const cronError = checkCron(schedule);
      // ⚠️ 失败态必须和成功态**同形状**地带 `created` 字段 —— 只回 { error } 的话
      // 调用方要靠 "r.created === false" 判断会拿到 undefined,等于判不出来。
      if (cronError) return { created: false, error: `schedule 不合法: ${cronError}` };
      const prompt = asString(args?.prompt);
      if (!prompt) return { created: false, error: '需要 prompt(到点后要做什么)。' };
      const cwd = asString(args?.cwd, ctx?.cwd || '');
      if (!cwd) return { created: false, error: '无法确定项目目录,请显式传 cwd。' };

      try {
        const input = {
          name,
          schedule,
          prompt,
          cwd,
          onMissed: args?.on_missed === 'skip' ? 'skip' : 'run',
          locale: String(ctx?.locale || 'zh').startsWith('en') ? 'en' : 'zh',
        };
        if (args?.model) input.model = asString(args.model);
        if (args?.session_mode) input.sessionMode = asString(args.session_mode);
        // createTask 内部归一化后 enabled 默认 true;只有显式 false 才建一个停用任务
        if (args?.enabled === false) input.enabled = false;

        const task = await createTask(input);
        const projected = project(task);
        return {
          source: 'file',
          file: SCHEDULES_FILE,
          created: true,
          task: projected,
          next_fire_at: projected.next_fire_at,
          note: SCHEDULER_CAVEAT,
        };
      } catch (err) {
        return { created: false, error: `创建失败: ${err?.message || String(err)}` };
      }
    },
  },

  {
    name: 'schedule_update',
    description:
      '修改一个定时任务。只传要改的字段 —— 没传的保持原样。可改:name / schedule / prompt / cwd / model / enabled / session_mode / on_missed。'
      + '⚠️ 这是**写操作**;任务 id 从 schedules_list 拿。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        name: { type: 'string' },
        schedule: { type: 'string', description: 'cron 表达式(5 字段)' },
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        model: { type: 'string' },
        enabled: { type: 'boolean' },
        session_mode: { type: 'string', enum: SESSION_MODES },
        on_missed: { type: 'string', enum: ON_MISSED },
      },
      required: ['id'],
    },
    async handler(args) {
      const found = await requireTask(args?.id);
      if (found.error) return found;

      if (args?.schedule !== undefined) {
        const cronError = checkCron(asString(args.schedule));
        if (cronError) return { updated: false, error: `schedule 不合法: ${cronError}` };
      }

      const patch = {};
      if (args?.name !== undefined) patch.name = asString(args.name);
      if (args?.schedule !== undefined) patch.schedule = asString(args.schedule);
      if (args?.prompt !== undefined) patch.prompt = asString(args.prompt);
      if (args?.cwd !== undefined) patch.cwd = asString(args.cwd);
      if (args?.model !== undefined) patch.model = asString(args.model);
      if (args?.enabled !== undefined) patch.enabled = asBool(args.enabled, true);
      if (args?.session_mode !== undefined) patch.sessionMode = asString(args.session_mode);
      if (args?.on_missed !== undefined) patch.onMissed = asString(args.on_missed);

      if (Object.keys(patch).length === 0) {
        return { updated: false, error: '没有要改的字段。可改:' + UPDATABLE.join(' / ') };
      }

      try {
        const task = await updateTask(found.taskId, patch);
        return {
          source: 'file',
          file: SCHEDULES_FILE,
          updated: true,
          changed: Object.keys(patch),
          task: project(task),
          note: SCHEDULER_CAVEAT,
        };
      } catch (err) {
        return { updated: false, error: `更新失败: ${err?.message || String(err)}` };
      }
    },
  },

  {
    name: 'schedule_remove',
    description:
      '删除一个定时任务。⚠️ 这是**写操作**且不可撤销 —— 删之前建议先用 schedules_list 确认 id 与名称。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        confirm: { type: 'boolean', description: '是否确认删除(先看一下任务是什么再传 true)' },
      },
      required: ['id'],
    },
    async handler(args) {
      const found = await requireTask(args?.id);
      if (found.error) return found;

      // 删除不可撤销,要求显式确认 —— 与 workbench 那边的 /api/workbench/jobs/clear
      // ({ confirm: true } 否则 400)同一口径。
      if (args?.confirm !== true) {
        return {
          removed: false,
          confirm_required: true,
          would_remove: { id: found.task.id, name: found.task.name, schedule: found.task.schedule, cwd: found.task.cwd },
          hint: '确认要删就再调一次并带上 confirm: true。',
        };
      }

      try {
        const snapshot = { id: found.task.id, name: found.task.name };
        await deleteTask(found.taskId);
        return { source: 'file', file: SCHEDULES_FILE, removed: true, removed_task: snapshot };
      } catch (err) {
        return { removed: false, error: `删除失败: ${err?.message || String(err)}` };
      }
    },
  },

  {
    name: 'schedule_set_enabled',
    description: '启用 / 停用某个定时任务(停用后不再触发,但任务保留)。这是写操作。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        enabled: { type: 'boolean', description: 'true=启用, false=停用' },
      },
      required: ['id', 'enabled'],
    },
    async handler(args) {
      const found = await requireTask(args?.id);
      if (found.error) return found;
      const enabled = asBool(args?.enabled, true);
      try {
        const task = await updateTask(found.taskId, { enabled });
        return {
          source: 'file',
          updated: true,
          enabled: task.enabled !== false,
          task: project(task),
          note: enabled ? SCHEDULER_CAVEAT : '已停用 —— 到点不会再触发,直到重新启用。',
        };
      } catch (err) {
        return { updated: false, error: `修改失败: ${err?.message || String(err)}` };
      }
    },
  },

  {
    name: 'schedule_run_now',
    description:
      '让某个定时任务**立刻跑一轮**(不等到点)。⚠️ 这是**写操作**,而且真的会起一轮 g ai 对话 —— '
      + '需要 g ui 正在运行(执行体在它进程里)。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
      },
      required: ['id'],
    },
    async handler(args, ctx) {
      const found = await requireTask(args?.id);
      if (found.error) return found;

      const instance = await findLiveInstance({ cwd: found.task.cwd || ctx?.cwd });
      if (!instance) {
        return { started: false, available: false, reason: '没有活着的 g ui 实例。' + NO_LIVE_INSTANCE_HINT };
      }

      const res = await liveFetch(instance.url, `/api/schedules/${encodeURIComponent(found.taskId)}/run`, {
        method: 'POST',
        timeoutMs: 30_000,
      });
      if (!res.ok || !res.payload) {
        return { started: false, from: describeInstance(instance), error: res.error || `HTTP ${res.status}`, detail: truncate(res.text || '', 800) };
      }
      return {
        source: 'live',
        from: describeInstance(instance),
        started: true,
        task: { id: found.task.id, name: found.task.name },
        result: res.payload,
        note: '执行是异步的 —— 这一轮跑完的落点在任务的专属会话里,可以用 agent_sessions_list 查。',
      };
    },
  },
];

/** 供单测/诊断用:可改字段清单与上限 */
export const SCHEDULE_TOOL_META = { UPDATABLE, MAX_TASKS };
