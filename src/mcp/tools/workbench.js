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
// 板块四:工作台(多项目编排台)。项目清单 / 任务 / 执行历史 / 派发 / 定时任务。
//
// 读的一律是文件即真相的几份 JSON:
//   tasks.json             全部任务(所有项目混在一份,靠 task.projectPath 分片)
//   jobs.json              执行记录(只在终态写,本机实测 37MB —— 只投影字段,别整份回传)
//   orchestrator.json      主 Agent 控制台的开关 / 指令流水 / 项目预设
//   schedules.json         定时任务(CLI 与 GUI 共享同一份)
//
// 只有"派发任务"必须走活实例 —— 建任务 + 起执行器的逻辑在 GUI 侧
// (dispatchInstruction.js),CLI 侧的同名工具也是靠 ctx 注入实现的(见
// src/cli/ai/tools.js:899-924 的注释),这里照搬那条边界。
import path from 'node:path';

import {
  TASKS_FILE,
  JOBS_FILE,
  ORCHESTRATOR_FILE,
  ORCHESTRATOR_REPORTS_FILE,
} from '../paths.js';
import { findLiveInstance, liveFetch, describeInstance, resolveJobs, NO_LIVE_INSTANCE_HINT } from '../live.js';
import { canonicalProjectPath, projectNameOf, readJsonFile, truncate, asString, asInt, asBool } from '../util.js';

/**
 * 看板列推导 —— 镜像 workbench/projectRegistry.js:170 的 deriveTaskColumn。
 *
 * 为什么不 import 那一份:projectRegistry.js 会连带拉起 directoryGitState 的批量探测
 * 与 fs.watch,MCP 服务端只想读几个 JSON,不该为一行判断把那套东西拖进来。
 * ⚠️ 改这里的规则必须同步改那边(反之亦然),否则"界面说的"和"模型说的"会对不上。
 */
function deriveColumn(task, jobsForTask) {
  const jobs = Array.isArray(jobsForTask) ? jobsForTask : [];
  if (jobs.some(j => j && (j.status === 'running' || j.status === 'pending'))) return 'doing';
  if (String(task?.status) === 'done') return 'done'; // 手动标完成
  if (jobs.length === 0) return 'todo';
  const sorted = jobs.slice().sort((a, b) => String(a.startedAt || a.endedAt || '').localeCompare(String(b.startedAt || b.endedAt || '')));
  const last = sorted[sorted.length - 1];
  return last && last.status === 'done' ? 'done' : 'todo';
}

/**
 * 读 tasks.json + job 表,按 taskId 索引好 job。多个工具复用。
 *
 * job 表优先走 resolveJobs(本进程内存 / 转发活实例)—— 那条路**拿得到还在跑的
 * 完整输出**,而且省掉一次 37MB 的 jobs.json 全量解析。
 * 拿不到时退回读盘:此时"还在跑"的那一次不在结果里(它只在 live-jobs 里),
 * 由 runtime_status 负责。
 *
 * @param {object} [ctx] - MCP ctx(可能带 getLiveJobs)
 * @returns {Promise<{ tasks: object[], jobs: object[], jobsByTask: Map, jobsSource: string }>}
 */
async function loadTaskGraph(ctx) {
  const taskStore = await readJsonFile(TASKS_FILE, null);
  const tasks = Array.isArray(taskStore?.tasks) ? taskStore.tasks : [];

  const resolved = await resolveJobs(ctx);
  let jobs;
  if (resolved) {
    jobs = resolved.jobs;
  } else {
    // ⚠️ 只读一次:本机这份 37MB,读两遍白白多花几百毫秒
    const store = await readJsonFile(JOBS_FILE, null);
    jobs = Array.isArray(store?.jobs) ? store.jobs : [];
  }

  const jobsByTask = new Map();
  for (const job of jobs) {
    if (!job?.taskId) continue;
    if (!jobsByTask.has(job.taskId)) jobsByTask.set(job.taskId, []);
    jobsByTask.get(job.taskId).push(job);
  }
  return { tasks, jobs, jobsByTask, jobsSource: resolved ? resolved.source : 'file' };
}

function projectTask(task, jobsForTask) {
  const jobs = Array.isArray(jobsForTask) ? jobsForTask : [];
  const sorted = jobs.slice().sort((a, b) => String(a.startedAt || a.endedAt || '').localeCompare(String(b.startedAt || b.endedAt || '')));
  const last = sorted[sorted.length - 1];
  return {
    id: task.id,
    title: task.title || '',
    desc: truncate(String(task.desc || ''), 500),
    project_path: task.projectPath || null,
    project_name: projectNameOf(task.projectPath),
    column: deriveColumn(task, jobs),
    status_field: task.status || '',
    type: task.type || null,
    executor_agent: last?.agent || null,
    run_count: jobs.length,
    last_run_at: last?.endedAt || last?.startedAt || null,
    last_run_status: last?.status || null,
    attachment_count: Array.isArray(task.attachments) ? task.attachments.length : 0,
    created_at: task.createdAt || null,
    updated_at: task.updatedAt || null,
  };
}

export const workbenchTools = [
  {
    name: 'workbench_projects',
    description:
      '列出工作台里登记的所有项目(名称、路径、任务统计:待处理/进行中/已完成)、当前项目是哪个,'
      + '以及主 Agent 控制台(编排台)的开关状态与最近收到的人工指令。'
      + '想知道每个项目的任务明细,再去 workbench_tasks。',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      const { tasks, jobsByTask, jobsSource } = await loadTaskGraph(ctx);

      const byProject = new Map();
      for (const task of tasks) {
        const key = canonicalProjectPath(task.projectPath) || '__no_project__';
        if (!byProject.has(key)) {
          byProject.set(key, { path: task.projectPath || null, total: 0, todo: 0, doing: 0, done: 0, last_active_at: null });
        }
        const bucket = byProject.get(key);
        const column = deriveColumn(task, jobsByTask.get(task.id));
        bucket.total += 1;
        bucket[column] += 1;
        const stamp = task.updatedAt || task.createdAt;
        if (stamp && (!bucket.last_active_at || String(stamp) > String(bucket.last_active_at))) bucket.last_active_at = stamp;
      }

      const projects = Array.from(byProject.entries()).map(([key, b]) => ({
        key,
        name: projectNameOf(b.path) || '(未关联项目)',
        path: b.path,
        tasks: { total: b.total, todo: b.todo, doing: b.doing, done: b.done },
        last_active_at: b.last_active_at,
      }));
      projects.sort((a, b) => b.tasks.total - a.tasks.total);

      const orchestrator = await readJsonFile(ORCHESTRATOR_FILE, null);
      const instructions = Array.isArray(orchestrator?.instructions) ? orchestrator.instructions : [];

      return {
        source: jobsSource,
        tasks_file: TASKS_FILE,
        jobs_file: JOBS_FILE,
        current_project: ctx?.cwd ? { path: ctx.cwd, name: projectNameOf(ctx.cwd), is_registered: byProject.has(canonicalProjectPath(ctx.cwd)) } : null,
        project_count: projects.length,
        projects,
        orchestrator: orchestrator ? {
          active: orchestrator.active === true,
          updated_at: orchestrator.updatedAt || null,
          default_prompt: truncate(String(orchestrator.defaultPrompt || ''), 600),
          report_interval_ms: orchestrator.reportIntervalMs ?? null,
          last_report_at: orchestrator.lastReportAt || null,
          instruction_count: instructions.length,
          recent_instructions: instructions.slice(-5).map(i => ({
            at: i?.at || i?.createdAt || null,
            text: truncate(String(i?.text || ''), 300),
          })),
        } : null,
        note: '看板列(todo/doing/done)由任务的执行记录推导 —— 判定规则与界面同源(手动标完成也算 done)。',
      };
    },
  },

  {
    name: 'workbench_tasks',
    description:
      '列出工作台里的任务(标题、描述、所属项目、看板列、执行器、最近一次执行时间与结果)。'
      + '可按项目路径 / 看板列 / 关键词过滤。想知道某个任务每次执行的完整输出,用 workbench_task_detail。',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: '只返回属于这个项目目录的任务' },
        column: { type: 'string', enum: ['todo', 'doing', 'done'], description: '只看某一列' },
        query: { type: 'string', description: '按标题/描述做子串过滤' },
        limit: { type: 'integer', description: '最多返回多少条,默认 50' },
      },
    },
    async handler(args, ctx) {
      const { tasks, jobsByTask, jobsSource } = await loadTaskGraph(ctx);
      const wantPath = canonicalProjectPath(asString(args?.project_path));
      const column = ['todo', 'doing', 'done'].includes(args?.column) ? args.column : '';
      const query = asString(args?.query).toLowerCase();
      const limit = asInt(args?.limit, 50, { min: 1, max: 300 });

      let list = tasks;
      if (wantPath) list = list.filter(t => canonicalProjectPath(t.projectPath) === wantPath);
      if (query) {
        list = list.filter(t => `${t.title || ''} ${t.desc || ''}`.toLowerCase().includes(query));
      }

      let projected = list.map(t => projectTask(t, jobsByTask.get(t.id)));
      if (column) projected = projected.filter(t => t.column === column);
      projected.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

      return {
        source: jobsSource,
        total: projected.length,
        returned: Math.min(projected.length, limit),
        tasks: projected.slice(0, limit),
        note: '按更新时间倒序。列 todo/doing/done 与界面看板同口径。',
      };
    },
  },

  {
    name: 'workbench_task_detail',
    description:
      '看一个任务的完整情况:任务本身 + 它的每一次执行记录(状态、退出码、耗时、输出尾部、工具调用数)。'
      + '想知道"这个任务到底做完没有、上次跑到哪一步",用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id(从 workbench_tasks 拿)' },
        output_chars: { type: 'integer', description: '每次执行返回多少字符的输出尾部,默认 2000' },
        max_runs: { type: 'integer', description: '最多返回几次执行记录(从最近往前),默认 5' },
      },
      required: ['task_id'],
    },
    async handler(args, ctx) {
      const taskId = asString(args?.task_id);
      if (!taskId) return { error: '需要 task_id。先用 workbench_tasks 拿。' };
      const outputChars = asInt(args?.output_chars, 2000, { min: 0, max: 20_000 });
      const maxRuns = asInt(args?.max_runs, 5, { min: 1, max: 30 });

      const { tasks, jobsByTask, jobsSource } = await loadTaskGraph(ctx);
      const task = tasks.find(t => t.id === taskId);
      if (!task) return { error: `找不到任务 ${taskId}(已查 ${TASKS_FILE})。` };

      const jobs = (jobsByTask.get(taskId) || [])
        .slice()
        .sort((a, b) => String(b.startedAt || b.endedAt || '').localeCompare(String(a.startedAt || a.endedAt || '')));

      return {
        source: jobsSource,
        jobs_file: JOBS_FILE,
        // 完整态时"还在跑"的那一次也在 runs 里(读盘时它不在)
        output_complete: jobsSource !== 'file',
        task: {
          ...projectTask(task, jobs),
          desc_full: String(task.desc || ''),
          prompt_override: truncate(String(task.simpleOverride || ''), 2000),
        },
        run_count: jobs.length,
        runs: jobs.slice(0, maxRuns).map(j => ({
          id: j.id,
          sub_id: j.subId || null,
          status: j.status || '',
          agent: j.agent || null,
          exit_code: typeof j.exitCode === 'number' ? j.exitCode : null,
          started_at: j.startedAt || null,
          ended_at: j.endedAt || null,
          last_activity_at: j.lastActivityAt || null,
          duration_ms: j.startedAt && j.endedAt
            ? Math.max(0, new Date(j.endedAt).getTime() - new Date(j.startedAt).getTime())
            : null,
          error: j.error || null,
          auto_completed: j.autoCompleted || null,
          tool_call_count: Array.isArray(j.toolCalls) ? j.toolCalls.length : 0,
          output_tail: outputChars > 0 ? truncate(String(j.output || '').slice(-outputChars), outputChars, outputChars) : undefined,
        })),
        note: jobsSource === 'file'
          ? '运行中的那一次执行不在 jobs.json 里(只在终态写),要看它请用 runtime_status。'
          : '这份 job 表来自本进程/活实例,包含正在跑的那一次,输出是完整全文。',
      };
    },
  },

  {
    name: 'workbench_dispatch',
    description:
      '往工作台**派发一条新任务** —— 相当于用户在「主 Agent 控制台」里说一句话。'
      + '会在目标项目下建一个任务,并按控制台的默认行为决定要不要立刻跑起来。'
      + '⚠️ 这是**写操作**,需要 g ui 正在运行。派发前先用 workbench_projects 确认项目路径。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要派给那个项目的 agent 的完整指令' },
        project_path: { type: 'string', description: '派到哪个项目目录(必须是已登记项目),不传则用控制台的默认目标' },
        executor: { type: 'string', description: '可选,指定执行器(claude / codex / opencode / codebuddy / gai)' },
        auto_run: { type: 'boolean', description: '是否建完就立刻执行,默认跟随控制台设置' },
        use_default_prompt: { type: 'boolean', description: '是否拼上项目预设提示词,默认跟随控制台设置' },
      },
      required: ['text'],
    },
    async handler(args, ctx) {
      const text = asString(args?.text);
      if (!text) return { error: '需要 text(要派出去的那句完整指令)。' };

      const instance = await findLiveInstance({ cwd: asString(args?.project_path, ctx?.cwd || '') });
      if (!instance) {
        return { available: false, dispatched: false, reason: '没有活着的 g ui 实例。' + NO_LIVE_INSTANCE_HINT };
      }

      const body = { text };
      if (asString(args?.project_path)) body.projectPath = asString(args.project_path);
      if (asString(args?.executor)) body.executor = asString(args.executor);
      // 与 tools.js 的 toolDispatchTask 同一口径:只有显式 false 才改变默认
      if (args?.auto_run === false) body.autoRun = false;
      if (args?.use_default_prompt === false) body.useDefaultPrompt = false;

      const res = await liveFetch(instance.url, '/api/workbench/orchestrator/dispatch', { method: 'POST', body, timeoutMs: 30_000 });
      if (!res.ok || !res.payload) {
        return {
          available: true,
          dispatched: false,
          from: describeInstance(instance),
          error: res.error || `HTTP ${res.status}`,
          detail: truncate(res.text || '', 1500),
        };
      }
      return { source: 'live', from: describeInstance(instance), dispatched: true, result: res.payload };
    },
  },

  {
    name: 'workbench_reports',
    description: '读主 Agent 控制台（编排台）生成的进度报告历史，最新的在前。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多返回多少条，默认 3' } },
    },
    async handler(args) {
      const limit = asInt(args?.limit, 3, { min: 1, max: 20 });
      const store = await readJsonFile(ORCHESTRATOR_REPORTS_FILE, null);
      const reports = Array.isArray(store?.reports) ? store.reports : [];
      return {
        source: 'file',
        file: ORCHESTRATOR_REPORTS_FILE,
        total: reports.length,
        reports: reports.slice(0, limit),
      };
    },
  },
];
