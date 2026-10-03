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
// 四件事：
//   1. 调度开关（active）+ 人类干预指令存档，持久化到 ~/.zen-gitsync/orchestrator.json。
//      「暂停调度」是服务端强制的：暂停期间自动派发会被拒绝（手动点执行不受影响）。
//   2. 派发默认提示词：一条全局的 + 每个项目一条的，同样存在 orchestrator.json。
//      它们是「派发时自动附加的约束」，不是任务内容 —— 解析规则见 resolveDispatchPrompt。
//   3. 进度报告：自动报告的间隔配置存在 orchestrator.json（一个数字，跟着轮询下发），
//      历史报告存在 orchestrator-reports.json（几 KB 一份，只在面板打开时按需取）。
//      报告正文由 progressReport.js 生成，这里只负责"存哪、存几份、什么时候允许再生成"。
//   4. buildActivityFeed —— 把 job 的起止事实与人类指令合成一条时间倒序的活动流。
//      （控制台右栏的「活动日志」已换成进度报告，但这条流还在供顶栏「今日完成」计数，
//      以及编排台接口的数据完整性 —— 别看到没人渲染就把它删了。）
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
  ORCHESTRATOR_REPORTS_FILE,
  MAX_ORCHESTRATOR_INSTRUCTIONS,
  MAX_DEFAULT_PROMPT_CHARS,
  INSTRUCTION_PREVIEW_CHARS,
  MAX_PROGRESS_REPORTS,
  PROGRESS_REPORT_INTERVALS_MS,
  DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
  readJson,
  writeJson,
  nowIso,
  genId,
} from './shared.js';
// 百分比的归一化只有一处实现（progressReport.js）—— 报告是它生成的，读回来时
// 也必须按同一把尺子收脏数据，两处各写一份必然分叉（分叉的表现是"盘上 130 被当成
// 100% 满格，而生成那一刻明明是当没给"）
import { normalizePercent } from './progressReport.js';
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
    reportIntervalMs: DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
    lastReportAt: null,
  };
}

/**
 * 报告间隔归一。**只认白名单里的值**，其余（缺字段 / 脏值 / 手改文件写进去的 7 分钟）
 * 一律回落到默认 10 分钟。老版本没有这个字段 —— 那正是"升级后按新默认开始报告"的语义。
 */
export function normalizeReportIntervalMs(value) {
  const n = Number(value);
  return PROGRESS_REPORT_INTERVALS_MS.includes(n) ? n : DEFAULT_PROGRESS_REPORT_INTERVAL_MS;
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
    reportIntervalMs: normalizeReportIntervalMs(state.reportIntervalMs),
    lastReportAt: typeof state.lastReportAt === 'string' ? state.lastReportAt : null,
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

/**
 * 把一条指令流水压成「可以每 5 秒下发」的形状：正文只留开头 INSTRUCTION_PREVIEW_CHARS 字。
 *
 * 为什么需要它：指令正文上限已放宽到十万字（MAX_INSTRUCTION_CHARS），而
 * /api/workbench/orchestrator 是 5s 轮询、下发 state.instructions 整份（200 条）。
 * 不截就是 200 × 100000 = 20MB 一轮。
 *
 * 只压**下发**：落盘那份（orchestrator.json）与任务正文（task.desc）都保持完整，
 * 指令流水的意义就是"我说过什么"能被翻到。附 textTruncated 让前端能如实说"已截断"，
 * 而不是让用户以为当初就只写了这么多。
 *
 * @param {object} it orchestratorStore 的指令记录
 * @returns {object} 新对象（不改原记录 —— 落盘那份必须还是完整的）
 */
export function withInstructionPreview(it) {
  const src = it && typeof it === 'object' ? it : {};
  const text = typeof src.text === 'string' ? src.text : '';
  const truncated = text.length > INSTRUCTION_PREVIEW_CHARS;
  return { ...src, text: truncated ? text.slice(0, INSTRUCTION_PREVIEW_CHARS) : text, textTruncated: truncated };
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

// ── 进度报告的配置与历史 ────────────────────────────────────────────────
// 「报告时间我自己设置」的那个设置：0 = 关掉自动报告（手动「立即报告」始终可用，
// 它不受这个开关影响 —— 关掉的是"自己隔一会儿跑一次"，不是"不许报告"）。

/** 写自动报告间隔。返回写后的值（已归一） */
export async function setReportIntervalMs(value) {
  return serialize(async () => {
    const state = await readOrchestrator();
    state.reportIntervalMs = normalizeReportIntervalMs(value);
    state.updatedAt = nowIso();
    await persist(state);
    return state.reportIntervalMs;
  });
}

/**
 * 抢占一次自动报告的"名额"：距上次报告不足 intervalMs 就返回 false。
 *
 * 为什么占坑要写盘而不是只放内存里一个时间戳：报告历史是**多实例共享**的
 * （同一个 ~/.zen-gitsync 可能同时开着两个 g ui），各自跑一个定时器的话，
 * 内存里各记各的，两边会在同一分钟各生成一份内容几乎一样的报告。
 * 时间戳落在共享文件上，后到的那个实例读到的就是"刚报过"。
 *
 * 抢占发生在**生成之前**（生成要等一次模型往返，几秒到几十秒）：
 * 等生成完再写，两个实例的窗口就大得多。代价是生成失败也要等满一个间隔才重试 ——
 * 失败会记进报告历史（errorCode），比"同一分钟内连打两次模型"划算。
 */
export async function claimReportSlot(intervalMs, now = Date.now()) {
  return serialize(async () => {
    const state = await readOrchestrator();
    const last = Date.parse(state.lastReportAt || '');
    if (Number.isFinite(last) && now - last < intervalMs) return false;
    state.lastReportAt = new Date(now).toISOString();
    await persist(state);
    return true;
  });
}

/** 单份报告归一：字段缺失 / 脏数据都必须能渲染，不能让面板整个读不出来 */
function normalizeReport(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  return {
    id: typeof r.id === 'string' && r.id ? r.id : genId(),
    at: typeof r.at === 'string' ? r.at : null,
    trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    text: typeof r.text === 'string' ? r.text : '',
    // 模型给的整体进度（0~100），null = 模型没给 / 老记录没有这个字段 ——
    // 界面据此决定画不画进度条。**不要给它填一个默认值**：填 0 会在界面上
    // 变成一条"进度 0%"的实心条，那是在替模型说它没说过的话
    percent: normalizePercent(r.percent),
    errorCode: typeof r.errorCode === 'string' ? r.errorCode : '',
    errorDetail: typeof r.errorDetail === 'string' ? r.errorDetail : '',
    tasks: tasks
      .filter(t => t && typeof t === 'object')
      .map(t => ({
        taskId: typeof t.taskId === 'string' ? t.taskId : null,
        // 这一轮执行的 job id。**别再把它归一掉**（2026-10-03 补）：面板靠它判断
        // 「这份报告讲的活还在不在跑」—— 同一个任务重跑一轮会换一个 job，
        // 只比 taskId 会把上一轮的报告认成当前的。老记录没有这一项，留 null。
        jobId: typeof t.jobId === 'string' && t.jobId ? t.jobId : null,
        taskTitle: typeof t.taskTitle === 'string' ? t.taskTitle : '',
        projectName: typeof t.projectName === 'string' ? t.projectName : '',
        startedAt: typeof t.startedAt === 'string' ? t.startedAt : null,
        // 跑多久是**生成那一刻**的事实，跟着报告存下来：
        // 前端拿现在的时钟去减 startedAt，"已运行 12 分钟"会随报告变旧一路涨，
        // 历史报告就再也说不清"当时是什么情况"了。
        elapsedMs: Number.isFinite(Number(t.elapsedMs)) ? Math.max(0, Math.floor(Number(t.elapsedMs))) : 0,
        agent: typeof t.agent === 'string' ? t.agent : '',
        toolCallCount: Number.isFinite(Number(t.toolCallCount)) ? Math.max(0, Math.floor(Number(t.toolCallCount))) : 0,
        lastTool: typeof t.lastTool === 'string' ? t.lastTool : '',
        lastLine: typeof t.lastLine === 'string' ? t.lastLine : '',
        // 2026-09-29 补的三样：老记录里没有它们 —— 一律给"没有"（'' / null），
        // 不要硬塞一个默认值冒充"当时它就是在思考 / 当时静默了 0 秒"
        toolMix: typeof t.toolMix === 'string' ? t.toolMix : '',
        lastThought: typeof t.lastThought === 'string' ? t.lastThought : '',
        silentMs: Number.isFinite(Number(t.silentMs)) ? Math.max(0, Math.floor(Number(t.silentMs))) : null,
        // 每个任务各自的进度。与整体那条同一个口径（null = 模型没给），
        // 老记录里没有它 —— 一律 null，不拿整体百分比摊到每个任务头上
        percent: normalizePercent(t.percent),
      })),
  };
}

/**
 * 读报告历史（新的在前）。文件缺失 / 损坏一律当"还没有报告"，不抛错。
 *
 * **没有事实的报告不算报告**：那是一条"当时什么都没在跑"的空记录，对回头翻历史的人
 * 零信息量，却要占掉上限 20 条里的一格，把真正有用的挤出去（用户 2026-09-29 的原话：
 * "这种没有在执行的就不用展示了"）。
 *
 * 写入侧已经不再产生它们（见 routes/workbench/index.js 的 runProgressReport），
 * 这里再挡一次是因为：老版本进程 / 另一个实例写进同一份文件的空报告，
 * 在读取方看来同样得当成不存在 —— 面板只认这个函数给的清单。
 * 另外 appendReport 是拿本函数的返回值重写整个文件的，所以历史遗留的空报告
 * 会在下一次落盘时被真正从磁盘上清掉。
 */
export async function readReports() {
  const data = await readJson(ORCHESTRATOR_REPORTS_FILE, null);
  const list = data && Array.isArray(data.reports) ? data.reports : [];
  return list
    .map(normalizeReport)
    .filter(r => r.tasks.length > 0)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_PROGRESS_REPORTS);
}

/** 两份报告"说的是同一件事"吗：同一批任务 + 同一段正文 + 同一种失败 */
function sameReport(a, b) {
  if (!a || !b) return false;
  if (a.trigger !== b.trigger || a.text !== b.text) return false;
  if (a.errorCode !== b.errorCode || a.errorDetail !== b.errorDetail) return false;
  if (a.tasks.length !== b.tasks.length) return false;
  return a.tasks.every((t, i) => (t.taskId || '') === (b.tasks[i].taskId || '')
    && (t.taskTitle || '') === (b.tasks[i].taskTitle || ''));
}

/**
 * 追加一份报告（新的在前），超出上限的旧报告直接丢掉。
 *
 * 窗口期内**内容一样的**只留第一份。为什么需要它：没有正文的报告（没配模型 = NO_MODEL）
 * 是逐字节相同的 —— 「立即报告」连点两下、或两个实例各点一下，历史里就会出现两条
 * 一模一样的记录（真实数据：2026-09-28T15:44:08.161 与 .226 两条 manual / tasks=0）。
 * 前端那个"生成中"的防抖挡不住这种点击：空报告不叫模型，本机往返几十毫秒就返回了，
 * 第二次点击落在防抖释放之后。
 *
 * 判据刻意**不含**时长 / 工具次数 / 最近输出这些每份报告都会变的字段 ——
 * 带上它们就永远"不算重复"，等于没做这个检查。
 */
const REPORT_DEDUPE_WINDOW_MS = 10 * 1000;

/** @returns {Promise<object>} 落盘的那一份；被判为重复时返回已在历史里的头部那条 */
export async function appendReport(entry) {
  return serialize(async () => {
    const report = normalizeReport({ id: genId(), at: nowIso(), ...entry });
    const existing = await readReports();
    const head = existing[0];
    const headAt = Date.parse((head && head.at) || '');
    if (head && Number.isFinite(headAt)
      && Date.now() - headAt < REPORT_DEDUPE_WINDOW_MS
      && sameReport(head, report)) {
      // 不落盘。返回头部那条而不是 null：调用方（runProgressReport）要拿它广播，
      // 前端本来就在展示它，等于"你看到的就是刚生成的"
      return head;
    }
    const reports = [report, ...existing].slice(0, MAX_PROGRESS_REPORTS);
    await writeJson(ORCHESTRATOR_REPORTS_FILE, { version: 1, reports });
    return report;
  });
}

/**
 * 正在执行的执行体清单（右栏控制台顶部的「{n} 个执行中」计数用）。
 *
 * 一行 = 一个活跃 job（不是任务）：job 只是执行进程，
 * 所以文案上叫「执行」而不是「Agent」—— 不要把正在跑的 claude 进程
 * 渲染成一个并不存在的"智能体集群"。
 *
 * 它曾有第二个消费者：看板左栏那块「执行监控」面板（2026-09-29 已删，
 * 字段与中间「进行中」卡片重合，只剩 PID 有增量 —— 那个已并到卡片上）。
 *
 * @param {{ jobs?: object[], tasks?: object[] }} input
 */
export function buildRunningAgents({ jobs = [], tasks = [] } = {}) {
  const taskMap = new Map((Array.isArray(tasks) ? tasks : []).map(t => [t && t.id, t]));
  return (Array.isArray(jobs) ? jobs : [])
    .filter(j => j && (j.status === 'running' || j.status === 'pending'))
    .map(j => {
      const task = taskMap.get(j.taskId) || null;
      const projectPath = (task && task.projectPath) || '';
      return {
        jobId: j.id,
        taskId: j.taskId || null,
        subId: j.subId || null,
        taskTitle: (task && task.title) || '',
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
 * 唯一例外：job 是由一条指令直接带起来的，那次起跑并进指令行（见
 * absorbInstructionDispatches）—— 否则派发行和指令行会同秒同文地出现两遍。
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
    const base = {
      jobId: j.id,
      taskId: j.taskId || null,
      subId: j.subId || null,
      taskTitle: (task && task.title) || '',
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
    // 正文只带**开头一段**进活动流：这条流跟着 5s 轮询下发（截断口径见
    // withInstructionPreview）。落盘那份不截 —— 完整原文在 orchestrator.json 与
    // task.desc 里，要全文的人去那两个地方拿。
    const preview = withInstructionPreview(it);
    rows.push({
      id: `ins:${it.id}`,
      kind: 'user',
      at: it.at,
      instructionId: it.id,
      text: preview.text,
      // 前端据此显示"已截断"，而不是让人以为指令本来就那么短
      textTruncated: preview.textTruncated,
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
  return absorbInstructionDispatches(rows)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, MAX_ACTIVITY_ENTRIES);
}

/**
 * 把「由指令直接带起来的那一次起跑」并进指令行，不再单独出「派发」。
 *
 * 派发行的正文是「{taskTitle}」派发至 {project}，而任务标题就是指令首行
 * （建任务时 `text.split('\n')[0]` 取的）—— 于是同一秒里会出现两行几乎一字不差：
 * 一行标「用户派发」、一行标「派发」，看着像日志重复打印了一遍。
 * 落点信息本来也没丢：指令行自己就带 projectName，前端还会补上落点与依据。
 *
 * 只吸收**每条指令之后的第一次**起跑，不是吸收这个任务的所有起跑：
 * 同一个任务被手动重跑时，后面那些派发行没有指令与之对应，抹掉就会出现
 * 「连着两条完成，却找不到第二次是从哪儿开始的」。
 *
 * 手动点执行产生的 job（没有对应指令）一概不动 —— 那种情况下派发行是**唯一**
 * 能说明"它是什么时候跑起来的"的记录。
 */
function absorbInstructionDispatches(rows) {
  const startsByTask = new Map();
  for (const r of rows) {
    if (r.kind !== 'dispatch' || !r.taskId) continue;
    if (!startsByTask.has(r.taskId)) startsByTask.set(r.taskId, []);
    startsByTask.get(r.taskId).push(r);
  }
  for (const list of startsByTask.values()) {
    list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  }

  const absorbed = new Set();
  for (const r of rows) {
    if (r.kind !== 'user' || !r.taskId || !r.at) continue;
    const start = (startsByTask.get(r.taskId) || []).find(
      x => !absorbed.has(x.id) && String(x.at || '') >= String(r.at)
    );
    if (start) absorbed.add(start.id);
  }
  return absorbed.size ? rows.filter(r => !absorbed.has(r.id)) : rows;
}
