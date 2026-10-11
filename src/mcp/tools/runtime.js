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
// 板块二:当前正在运行的命令 / 任务 / g ui 实例。
//
// 数据来源,按真相度从高到低:
//   · 本进程内存 / 转发活实例  —— **完整**输出(见 live.js 的 resolveJobs)
//   · live-jobs/<pid>.json    —— 跨实例广播,但输出是**截尾**的(32KB 尾 / 工具流水最近 20 条)
//   · jobs.json               —— 只在终态写,完整但不含"还在跑"的部分
//   · instances/<pid>.json    —— 心跳 30s,文件即真相(需判活)
//
// 三条路线由 resolveJobs() 统一降级,本文件不重复判断;拿不到内存态时退回读盘,
// 并在结果里用 `source` 与 `output_complete` 把"这份输出是不是全文"如实告诉调用方。
import path from 'node:path';

import { JOBS_FILE, LIVE_JOBS_DIR, LIVE_JOBS_MAX_AGE_MS } from '../paths.js';
import { listLiveInstances, describeInstance, resolveJobs } from '../live.js';
import { isPidAlive, listDataFiles, readJsonFile, truncate, asInt, asBool } from '../util.js';

/** 从 jobs.json 里挑"最近结束"的若干条,只投影模型关心的字段。 */
function projectFinishedJob(job) {
  if (!job || typeof job !== 'object') return null;
  return {
    id: job.id,
    taskId: job.taskId || null,
    taskTitle: job.taskTitle || null,
    title: job.title || '',
    status: job.status || '',
    agent: job.agent || null,
    exitCode: typeof job.exitCode === 'number' ? job.exitCode : null,
    startedAt: job.startedAt || null,
    endedAt: job.endedAt || null,
    durationMs: job.startedAt && job.endedAt
      ? Math.max(0, new Date(job.endedAt).getTime() - new Date(job.startedAt).getTime())
      : null,
    error: job.error || null,
    outputTail: truncate(String(job.output || '').slice(-4000), 4000, 4000),
    toolCallCount: Array.isArray(job.toolCalls) ? job.toolCalls.length : 0,
  };
}

/** 正在跑的 job 记录 —— 输出已在落盘时截过尾,这里再按返回预算收一次。 */
function projectLiveJob(job, { outputChars, complete }) {
  if (!job || typeof job !== 'object') return null;
  const tools = Array.isArray(job.toolCalls) ? job.toolCalls : [];
  const output = String(job.output || '');
  return {
    id: job.id,
    taskId: job.taskId || null,
    title: job.title || '',
    status: job.status || '',
    agent: job.agent || null,
    pid: job.pid || null,
    startedAt: job.startedAt || null,
    lastActivityAt: job.lastActivityAt || null,
    silentMs: job.lastActivityAt ? Date.now() - new Date(job.lastActivityAt).getTime() : null,
    // 完整态时给全文长度,让调用方知道"我拿到的就是全部"
    outputLength: complete ? output.length : undefined,
    outputTail: outputChars > 0 ? truncate(output.slice(-outputChars), outputChars, outputChars) : undefined,
    thinkingTail: outputChars > 0 ? truncate(String(job.thinking || '').slice(-Math.min(outputChars, 2000)), outputChars, outputChars) : undefined,
    toolCalls: tools.slice(-12).map(c => ({
      name: c?.name || '',
      status: c?.status || '',
      argsPreview: String(c?.argsPreview || '').slice(0, 200),
    })),
    toolCallCount: tools.length,
  };
}

export const runtimeTools = [
  {
    name: 'runtime_status',
    description:
      '本机现在正在跑什么:所有活着的 g ui 实例,以及它们各自正在执行的工作台任务(命令、状态、执行器、'
      + '最近的输出尾部、正在调的工具)。'
      + '直读跨实例广播文件,不需要调用方在 g ui 里。'
      + '注意:运行中任务的完整输出只在它所属进程的内存里,这里拿到的是落盘的截尾快照。',
    inputSchema: {
      type: 'object',
      properties: {
        include_finished: {
          type: 'boolean',
          description: '是否连同最近已完成的任务一起返回(默认 false)',
        },
        finished_limit: { type: 'integer', description: '已完成任务返回多少条,默认 10' },
        output_chars_per_job: {
          type: 'integer',
          description: '每个运行中任务返回多少字符的输出尾部,0 表示不带输出,默认 1500',
        },
      },
    },
    async handler(args, ctx) {
      const includeFinished = asBool(args?.include_finished, false);
      const finishedLimit = asInt(args?.finished_limit, 10, { min: 1, max: 50 });
      const outputChars = asInt(args?.output_chars_per_job, 1500, { min: 0, max: 8000 });

      // ── 实例 ──────────────────────────────────────────────
      const instances = await listLiveInstances();
      const now = Date.now();

      // ── job 表:能拿完整态就拿,拿不到退回读盘 ──
      const resolved = await resolveJobs(ctx);
      const complete = resolved?.complete === true;
      const running = [];
      const staleFiles = [];

      if (resolved) {
        for (const job of resolved.jobs) {
          if (!(job?.status === 'running' || job?.status === 'pending')) continue;
          const projected = projectLiveJob(job, { outputChars, complete });
          if (projected) running.push({ owner: resolved.from || null, ...projected });
        }
      } else {
        // 按 owner pid 分文件,只认活着的 owner
        const files = (await listDataFiles(LIVE_JOBS_DIR))
          .filter(f => /^\d+\.json$/.test(path.basename(f)));
        for (const file of files) {
          const ownerPid = Number(path.basename(file, '.json'));
          const data = await readJsonFile(file, null);
          const updatedAt = Number(data?.updatedAt) || 0;
          const fresh = updatedAt > 0 && now - updatedAt < LIVE_JOBS_MAX_AGE_MS;
          if (!isPidAlive(ownerPid) || !fresh) {
            // 残留广播文件(进程被强杀时会留下)。不删 —— 删文件不是 MCP 该干的事。
            staleFiles.push({ owner_pid: ownerPid, updated_at: updatedAt ? new Date(updatedAt).toISOString() : null, pid_alive: isPidAlive(ownerPid) });
            continue;
          }
          const owner = instances.find(i => i.pid === ownerPid);
          for (const job of Array.isArray(data?.jobs) ? data.jobs : []) {
            const projected = projectLiveJob(job, { outputChars, complete: false });
            if (projected) running.push({ owner_pid: ownerPid, owner: owner ? describeInstance(owner) : null, ...projected });
          }
        }
      }

      const result = {
        source: resolved ? resolved.source : 'file',
        // 这条最关键:告诉调用方"outputTail 是从完整输出上截的,还是本身就是截尾的"
        output_complete: complete,
        checked_at: new Date().toISOString(),
        g_ui_running: instances.length > 0,
        instances: instances.map(i => ({
          pid: i.pid,
          port: i.port,
          url: i.url,
          project_name: i.projectName,
          project_path: i.projectPath,
          uptime_minutes: i.startedAt ? Math.round((now - i.startedAt) / 60_000) : null,
          heartbeat_age_seconds: Math.round(i.age / 1000),
        })),
        running_job_count: running.length,
        running_jobs: running,
      };

      if (resolved?.from) result.jobs_from = resolved.from;
      if (instances.length === 0) {
        result.note = '当前没有活着的 g ui 实例(没有它,派发任务 / 跑 g ai 对话都不可用;'
          + '但任务、执行历史、会话等磁盘数据仍可读)。';
      }
      if (!complete) {
        result.output_note = 'outputTail 来自 live-jobs 的**截尾**快照(原文还有更多),'
          + '不是完整输出。要拿全文,让 g ui 跑起来 —— 挂在它进程内、或转发它都能拿到完整态。';
      }
      if (staleFiles.length > 0) {
        result.stale_broadcast_files = staleFiles;
        result.stale_note = '这些是已经没有主人的 live-jobs 广播文件(进程被强杀留下的),已忽略。';
      }

      // ── 最近完成的历史 ────────────────────────────────────
      if (includeFinished) {
        let jobs;
        if (resolved) {
          // 内存态里已经带历史了,别再 parse 一份 37MB 的 jobs.json
          jobs = resolved.jobs;
        } else {
          const store = await readJsonFile(JOBS_FILE, null);
          jobs = Array.isArray(store?.jobs) ? store.jobs : [];
          result.jobs_file = JOBS_FILE;
        }
        const finished = jobs
          .filter(j => j && j.status !== 'running' && j.status !== 'pending')
          .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')))
          .slice(0, finishedLimit)
          .map(projectFinishedJob)
          .filter(Boolean);
        result.recent_finished = finished;
        result.jobs_total = jobs.length;
      }

      return result;
    },
  },
];
