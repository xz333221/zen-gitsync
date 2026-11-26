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
// task_status 工具的数据源：tasks.json + 合并后的执行记录 → 给模型看的状态文本。
//
// 口径纪律（教训见 memory「两个面板要显示同一对值」）：看板的列由
// projectRegistry.deriveTaskColumn 从执行记录推导，这里**必须复用同一个函数**，
// 自己拿 status 拼一份"已完成/进行中"必然分叉 —— 模型汇报"已完成"而看板还挂在
// 「待处理」，用户看到的又是一回撒谎。

import { readJson, TASKS_FILE } from './shared.js';
import { refreshJobsFromDisk, snapshotJobs } from './jobStore.js';
import { deriveTaskColumn } from './projectRegistry.js';

const COLUMN_LABELS = { todo: '待处理', doing: '进行中', done: '已完成' };
const JOB_STATUS_LABELS = {
  done: '成功', error: '出错', cancelled: '已取消', running: '运行中', pending: '排队中',
};

function formatDuration(job) {
  const start = Date.parse(job?.startedAt || '');
  const end = Date.parse(job?.endedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '';
  const total = Math.floor((end - start) / 1000);
  if (total < 60) return `用时${total}秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `用时${minutes}分${seconds}秒` : `用时${minutes}分`;
}

/**
 * 建一个 taskStatus 实现（GUI 侧注入 ctx.taskStatus，与 listProjects 同一手法）。
 * 纯读：tasks.json + jobs 快照，不写任何东西。
 *
 * @param {object} [opts]
 * @param {number} [opts.maxTasks]        不带 id 时最多列几条（按 updatedAt 挑最新的）
 * @param {number} [opts.outputTailChars] 每条附带的输出结尾长度
 * @returns {(args: { taskId?: string }) => Promise<string>}
 */
export function createTaskStatusProvider({ maxTasks = 15, outputTailChars = 600 } = {}) {
  return async function taskStatus(args = {}) {
    const wantedId = String(args?.taskId || '').trim();

    // 别的 g ui 进程跑的记录也在合并快照里；先刷磁盘缓存再取，顺序别颠倒
    // （见 jobStore 文件头："先 await 刷新、再同步取快照"）。
    await refreshJobsFromDisk().catch(() => {});
    const data = await readJson(TASKS_FILE, { tasks: [] });
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    const jobsByTask = new Map();
    for (const j of snapshotJobs()) {
      if (!j || !j.taskId) continue;
      const list = jobsByTask.get(j.taskId) || [];
      list.push(j);
      jobsByTask.set(j.taskId, list);
    }

    let picked;
    if (wantedId) {
      const task = tasks.find(t => t && t.id === wantedId);
      if (!task) {
        return `没有找到 id 为「${wantedId}」的任务 —— id 要用 dispatch_task 结果里给的 taskId；`
          + '不带参数调用可以列出最近的任务。';
      }
      picked = [task];
    } else {
      picked = tasks
        .slice()
        .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
        .slice(0, maxTasks);
      if (!picked.length) return '看板上目前没有任何任务。';
    }

    const lines = [];
    for (const task of picked) {
      const jobs = (jobsByTask.get(task.id) || [])
        .slice()
        .sort((a, b) => String(b?.startedAt || '').localeCompare(String(a?.startedAt || '')));
      const column = deriveTaskColumn(task, jobs);
      const parts = [
        `「${String(task.title || '未命名任务')}」`,
        `id=${task.id}`,
        `看板状态：${COLUMN_LABELS[column] || column}`,
      ];
      const last = jobs[0] || null;
      if (last) {
        parts.push(`最近一次执行：${JOB_STATUS_LABELS[last.status] || last.status}`);
        if (last.endedAt) parts.push(`结束于 ${last.endedAt}`);
        const duration = formatDuration(last);
        if (duration) parts.push(duration);
        if (last.status === 'error' && last.error) parts.push(`错误：${String(last.error).slice(0, 200)}`);
      } else {
        parts.push('还没执行过');
      }
      lines.push(parts.join('；'));

      const output = String(last?.output || '').trim();
      if (output) {
        lines.push(`  输出结尾：${output.slice(-outputTailChars).replace(/\s+/g, ' ')}`);
      }
    }

    if (!wantedId) {
      lines.push(`（以上为最近的 ${picked.length} 条；要查指定任务把 task_id 传进来。）`);
    }
    return lines.join('\n');
  };
}
