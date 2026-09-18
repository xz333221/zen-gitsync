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
// 三件事：
//   1. 调度开关（active）+ 人类干预指令存档，持久化到 ~/.zen-gitsync/orchestrator.json。
//      「暂停调度」是服务端强制的：暂停期间自动派发会被拒绝（手动点执行不受影响）。
//   2. 派发默认提示词：一条全局的 + 每个项目一条的，同样存在 orchestrator.json。
//      它们是「派发时自动附加的约束」，不是任务内容 —— 解析规则见 resolveDispatchPrompt。
//   3. buildActivityFeed —— 把 job 的起止事实与人类指令合成一条时间倒序的活动流。
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
  MAX_DEFAULT_PROMPT_CHARS,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
import { projectName, canonicalProjectPath } from './projectRegistry.js';
import { TARGET_SOURCES } from './targetResolver.js';

/** 活动流最多返回多少条（前端只渲染最近的一屏，多的不传） */
export const MAX_ACTIVITY_ENTRIES = 120;

/** 默认提示词的三种来源。前端据此说明"这条指令附带了什么" */
export const PROMPT_SOURCES = ['global', 'project', 'both'];

/** 默认状态：新装 / 升级后直接是「调度中」，要停由用户自己去点暂停 */
function defaultState() {
  return {
    version: 1,
    active: true,
    updatedAt: null,
    instructions: [],
    defaultPrompt: '',
    projectPrompts: {},
  };
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
    // 落点是怎么定下来的（explicit / mention / agent / default）。
    // 老记录没有这个字段 —— 留空串，别硬塞一个默认值冒充"当时就是这么判断的"。
    targetSource: TARGET_SOURCES.includes(it.targetSource) ? it.targetSource : '',
    // 这次派发附带了哪一级默认提示词（'' = 没附带，含本次升级前的老记录）。
    // 用户回头问"这条怎么带上了那段话"，答案就在这儿。
    promptSource: PROMPT_SOURCES.includes(it.promptSource) ? it.promptSource : '',
  };
}

/**
 * 项目级默认提示词归一。
 *
 * 键一律走 canonicalProjectPath（与项目清单 / 看板同一套口径）：用户选中的项目路径
 * 在两侧写法可能不同（`D:/ws/x` 与 `d:\ws\x`），不归一就会存成两条、派发时查不到。
 * 提示词为空的条目**直接丢掉**而不是留个空壳 —— "清空"和"没设置过"必须是同一个状态。
 */
function normalizeProjectPrompts(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [key, val] of Object.entries(src)) {
    if (!val || typeof val !== 'object') continue;
    const k = canonicalProjectPath(key);
    const prompt = typeof val.prompt === 'string' ? val.prompt : '';
    if (!k || !prompt.trim()) continue;
    out[k] = {
      path: typeof val.path === 'string' && val.path ? val.path : key,
      prompt: prompt.slice(0, MAX_DEFAULT_PROMPT_CHARS),
      updatedAt: typeof val.updatedAt === 'string' ? val.updatedAt : null,
    };
  }
  return out;
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
    defaultPrompt: typeof state.defaultPrompt === 'string'
      ? state.defaultPrompt.slice(0, MAX_DEFAULT_PROMPT_CHARS)
      : '',
    projectPrompts: normalizeProjectPrompts(state.projectPrompts),
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

// ── 派发默认提示词 ──────────────────────────────────────────────────────
// 两级：全局一条（所有项目都附带）+ 每个项目一条（只在该项目派发时附带）。
// 存两份而不是"项目级覆盖全局"，是刻意的：全局那一条写的是"每次派发都要守的规矩"，
// 项目级写的是"这个项目额外的补充"。若项目级覆盖全局，用户在某个项目里设一条提示词
// 就会让全局规则**无声消失**，而他从界面上看不出这件事。

/** 写全局默认提示词（空串 = 清除）。返回写后的值 */
export async function setDefaultPrompt(prompt) {
  return serialize(async () => {
    const state = await readOrchestrator();
    state.defaultPrompt = typeof prompt === 'string' ? prompt.slice(0, MAX_DEFAULT_PROMPT_CHARS) : '';
    state.updatedAt = nowIso();
    await persist(state);
    return state.defaultPrompt;
  });
}

/** 写某个项目的默认提示词（空串 = 清除该项目这一条）。返回写后的整张表 */
export async function setProjectPrompt({ projectPath, prompt }) {
  return serialize(async () => {
    const state = await readOrchestrator();
    const key = canonicalProjectPath(projectPath);
    if (!key) return state.projectPrompts;
    const text = typeof prompt === 'string' ? prompt.slice(0, MAX_DEFAULT_PROMPT_CHARS) : '';
    if (!text.trim()) delete state.projectPrompts[key];
    else {
      state.projectPrompts[key] = {
        path: String(projectPath || '').trim() || key,
        prompt: text,
        updatedAt: nowIso(),
      };
    }
    state.updatedAt = nowIso();
    await persist(state);
    return state.projectPrompts;
  });
}

/**
 * 解析一次派发实际要附加的默认提示词。纯函数，单测覆盖。
 *
 * 顺序：**全局在前、项目级在后**。项目级不改写全局（见上面为什么不覆盖），
 * 两者拼接后作为「提示词模板」交给 taskRunner 的 composePromptBody —— 它会把它
 * 放在任务正文之前，用户真正要办的那句话仍在最后、离模型注意力中心最近。
 *
 * 完全相同的两条（用户把全局原样抄进项目里）只留一条：拼两遍纯粹是白烧 token。
 *
 * @param {object} state        readOrchestrator() 的结果
 * @param {string} projectPath  本次派发的落点项目路径
 * @returns {{ text: string, source: ''|'global'|'project'|'both' }}
 */
export function resolveDispatchPrompt(state, projectPath) {
  const globalText = (state && typeof state.defaultPrompt === 'string' ? state.defaultPrompt : '').trim();
  const key = canonicalProjectPath(projectPath);
  const entry = key && state && state.projectPrompts ? state.projectPrompts[key] : null;
  let projectText = entry && typeof entry.prompt === 'string' ? entry.prompt.trim() : '';

  if (projectText && projectText === globalText) projectText = '';

  // 拼完再夹一道：单条上限 ×2 恰好是任务提示词字段的上限，正常永远碰不到这个上限；
  // 兜这一下是为了保证**任何**路径写出去的提示词都不会超过那个字段能存下的长度。
  const text = [globalText, projectText].filter(Boolean).join('\n\n').slice(0, MAX_DEFAULT_PROMPT_CHARS);
  const source = globalText && projectText ? 'both' : (globalText ? 'global' : (projectText ? 'project' : ''));
  return { text, source };
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
      // 落点来源（'' = 本次升级前的老记录）。前端据此说明"为什么派到这儿了"
      targetSource: it.targetSource || '',
      // 这条指令附带了哪一级默认提示词（'' = 没附带）。前端据此说明"这段话是谁加的"
      promptSource: it.promptSource || '',
    });
  }

  // 时间缺失的排最后（排序键用空串，天然沉底）
  rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return rows.slice(0, MAX_ACTIVITY_ENTRIES);
}
