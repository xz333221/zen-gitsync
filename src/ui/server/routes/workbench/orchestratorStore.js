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
// 主 Agent 编排台的状态存储 + 活动流拼装。
//
// 两件事：
//   1. 调度开关（active）+ 人类干预指令存档，持久化到 ~/.zen-gitsync/orchestrator.json。
//      「暂停调度」是服务端强制的：暂停期间自动派发会被拒绝（手动点执行不受影响）。
//   2. buildActivityFeed —— 把 job 的起止事实与人类指令合成一条时间倒序的活动流。
//
// 活动流为什么不在服务端拼好文案：
//   UI 文案统一走前端 i18n（lang/{zh,en}），服务端只回**结构化事实**
//   （kind + taskTitle + projectName + 时间），句子由前端 $t() 渲染。
//   后端一旦写死中文，英文界面就会漏出中文。
//
// 指令存档只是"我说过什么"的流水，不参与执行逻辑；进它不算成功，出它也不算失败，
// 失败原因记在单条指令的 status/reason 上（前端照着渲染）。

import {
  ORCHESTRATOR_FILE,
  MAX_ORCHESTRATOR_INSTRUCTIONS,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
import { projectName } from './projectRegistry.js';

/** 活动流最多返回多少条（前端只渲染最近的一屏，多的不传） */
export const MAX_ACTIVITY_ENTRIES = 120;

/** 默认状态：新装 / 升级后直接是「调度中」，要停由用户自己去点暂停 */
function defaultState() {
  return { version: 1, active: true, updatedAt: null, instructions: [] };
}

/** 单条指令归一：老数据/半损坏数据都要能渲染，不能让整份状态读不出来 */
function normalizeInstruction(raw) {
  const it = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof it.id === 'string' && it.id ? it.id : genId(),
    text: typeof it.text === 'string' ? it.text : '',
    projectPath: typeof it.projectPath === 'string' ? it.projectPath : '',
    at: typeof it.at === 'string' ? it.at : null,
    taskId: typeof it.taskId === 'string' && it.taskId ? it.taskId : null,
    // accepted=已建任务 / rejected=被拒绝（暂停调度、项目不存在等）/ created=只建了草稿没执行
    status: ['accepted', 'rejected', 'created'].includes(it.status) ? it.status : 'created',
    reason: typeof it.reason === 'string' ? it.reason : '',
  };
}

/** 归一化磁盘内容；文件缺失、损坏、字段缺失都必须能起来（编排台不能因为存档坏了就打不开） */
export function normalizeOrchestrator(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  const base = defaultState();
  const instructions = Array.isArray(state.instructions) ? state.instructions : [];
  return {
    version: 1,
    // 只有显式 false 才算暂停；其余（缺字段 / 脏值）一律当调度中
    active: state.active === false ? false : true,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : base.updatedAt,
    instructions: instructions
      .filter(x => x && typeof x === 'object')
      .slice(-MAX_ORCHESTRATOR_INSTRUCTIONS)
      .map(normalizeInstruction),
  };
}

/**
 * 读-改-写串行化。
 * 指令是"点一下就写一条"的高频小写操作，并发的两次读写会互相覆盖
 * （后写的把前一条指令整个吞掉）。这里用一条 Promise 链把写操作排成队。
 */
let writeChain = Promise.resolve();
function serialize(task) {
  const next = writeChain.then(task, task);
  // 吞掉链上的异常，避免一次失败让后续所有写操作都被拒绝
  writeChain = next.catch(() => {});
  return next;
}

export async function readOrchestrator() {
  return normalizeOrchestrator(await readJson(ORCHESTRATOR_FILE, null));
}

async function persist(state) {
  await writeJson(ORCHESTRATOR_FILE, state);
  return state;
}

/** 暂停 / 恢复调度 */
export async function setOrchestratorActive(active) {
  return serialize(async () => {
    const state = await readOrchestrator();
    state.active = !!active;
    state.updatedAt = nowIso();
    return persist(state);
  });
}

/** 追加一条人类干预指令记录，返回写入后的那条记录 */
export async function appendInstruction(entry) {
  return serialize(async () => {
    const state = await readOrchestrator();
    const record = normalizeInstruction({ id: genId(), at: nowIso(), ...entry });
    state.instructions.push(record);
    if (state.instructions.length > MAX_ORCHESTRATOR_INSTRUCTIONS) {
      state.instructions = state.instructions.slice(-MAX_ORCHESTRATOR_INSTRUCTIONS);
    }
    await persist(state);
    return record;
  });
}

/** 回填某条指令的执行结果（建完任务后补 taskId / status） */
export async function updateInstruction(id, patch) {
  return serialize(async () => {
    const state = await readOrchestrator();
    const i = state.instructions.findIndex(x => x.id === id);
    if (i < 0) return null;
    state.instructions[i] = normalizeInstruction({ ...state.instructions[i], ...patch });
    await persist(state);
    return state.instructions[i];
  });
}

export async function clearInstructions() {
  return serialize(async () => {
    const state = await readOrchestrator();
    state.instructions = [];
    state.updatedAt = nowIso();
    return persist(state);
  });
}

/**
 * 正在执行的执行体清单（看板左栏「执行监控」用）。
 *
 * 一行 = 一个活跃 job（不是任务）：一个任务并行跑 3 个子任务就是三行，
 * 因为"谁在跑什么"只有到 job 粒度才说得清。job 只是执行进程，
 * 所以文案上叫「执行」而不是「Agent」—— 不要把正在跑的 claude 进程
 * 渲染成一个并不存在的"智能体集群"。
 *
 * @param {{ jobs?: object[], tasks?: object[] }} input
 */
export function buildRunningAgents({ jobs = [], tasks = [] } = {}) {
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map(t => [t && t.id, t]));
  return (Array.isArray(jobs) ? jobs : [])
    .filter(j => j && (j.status === 'running' || j.status === 'pending'))
    .map(j => {
      const task = taskMap.get(j.taskId) || null;
      const subs = task && Array.isArray(task.subtasks) ? task.subtasks : [];
      const sub = subs.find(s => s && s.id === j.subId) || null;
      const projectPath = (task && task.projectPath) || '';
      return {
        jobId: j.id,
        taskId: j.taskId || null,
        subId: j.subId || null,
        taskTitle: (task && task.title) || '',
        subTitle: (sub && sub.title) || '',
        status: j.status,
        pid: j.pid || null,
        startedAt: j.startedAt || null,
        projectPath,
        projectName: projectName(projectPath),
      };
    })
    .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
}

/** 供派发路由判断"现在能不能自动执行" */
export async function isSchedulingActive() {
  const state = await readOrchestrator();
  return state.active;
}

/**
 * 拼装活动流：job 的起止事实 + 人类指令，按时间倒序取前 MAX_ACTIVITY_ENTRIES 条。
 *
 * 一条 job 产出两条记录（派发 / 收尾），这是它的真实生命周期：
 *   dispatch   ← startedAt 存在
 *   done / error / cancelled ← endedAt 存在，按 status 分
 * 只回结构化字段，句子交给前端 i18n。
 *
 * @param {{ jobs?: object[], tasks?: object[], instructions?: object[] }} input
 */
export function buildActivityFeed({ jobs = [], tasks = [], instructions = [] } = {}) {
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map(t => [t && t.id, t]));
  const rows = [];

  const projectOf = (task) => {
    const p = (task && task.projectPath) || '';
    return { projectPath: p, projectName: projectName(p) };
  };

  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !j.id) continue;
    const task = taskMap.get(j.taskId) || null;
    const subs = task && Array.isArray(task.subtasks) ? task.subtasks : [];
    const sub = subs.find(s => s && s.id === j.subId) || null;
    const base = {
      jobId: j.id,
      taskId: j.taskId || null,
      subId: j.subId || null,
      taskTitle: (task && task.title) || '',
      subTitle: (sub && sub.title) || '',
      jobStatus: j.status || '',
      pid: j.pid || null,
      ...projectOf(task),
    };

    if (j.startedAt) {
      rows.push({ id: `job:${j.id}:start`, kind: 'dispatch', at: j.startedAt, ...base });
    }
    if (j.endedAt) {
      const kind = j.status === 'done' ? 'done'
        : j.status === 'cancelled' ? 'cancelled'
          : 'error';
      rows.push({
        id: `job:${j.id}:end`,
        kind,
        at: j.endedAt,
        exitCode: typeof j.exitCode === 'number' ? j.exitCode : null,
        error: j.error || '',
        ...base,
      });
    }
  }

  for (const it of Array.isArray(instructions) ? instructions : []) {
    if (!it || !it.id) continue;
    rows.push({
      id: `ins:${it.id}`,
      kind: 'user',
      at: it.at,
      instructionId: it.id,
      text: it.text || '',
      taskId: it.taskId || null,
      instructionStatus: it.status || 'created',
      reason: it.reason || '',
      projectPath: it.projectPath || '',
      projectName: projectName(it.projectPath || ''),
    });
  }

  // 时间缺失的排最后（排序键用空串，天然沉底）
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, MAX_ACTIVITY_ENTRIES);
}
