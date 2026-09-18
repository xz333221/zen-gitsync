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
// 执行时注入给 Agent 的「运行环境上下文」。
//
// 解决什么问题：从主 Agent 调度台发出去的指令，最终 prompt 只是用户原文
// + 附件清单（拼装见 promptParts.js），cwd 之外的项目、看板进度、历史指令
// 一概不在里面。于是用户问"我的项目有哪些"，Agent 只能就着当前目录猜 ——
// 而数据其实全在本机，只是没人告诉它路径。
//
// 这里做两件事，缺一不可：
//   1. 给**摘要** —— 项目清单 + 各列任务计数（顺着看板口径，一眼看到进度）；
//   2. 给**真相源文件路径** —— 要细节自己去读。
// 刻意不把 tasks.json 全文塞进 prompt：几十条任务、每条还挂着执行输出，
// 既烧 token，又会把用户真正要办的那句话淹掉。
//
// ⚠️ 文案为什么可以是中文硬编码（与 orchestratorStore 的「服务端不写死中文」不冲突）：
// 那一条约束针对的是**回给 UI 渲染的文案**，而这里是喂给模型的 prompt 内容，
// 不经过前端 $t()，也不会显示在界面上。反过来说，它也不该跟着界面语言变 ——
// 中文指令配中文上下文，模型理解得更稳。
//
// 纯函数：只吃入参、不读文件（文件读取在调用方 routes/workbench/index.js）。
// 这样单测不用碰真实用户数据 —— 与 promptParts.js 同一个理由。
// 统计口径复用 projectRegistry 的 summarizeProjectTasks：「任务算哪一列」
// 全局只有这一个实现，看板怎么分列，这里就怎么统计。

import { summarizeProjectTasks, canonicalProjectPath, TASK_COLUMNS } from './projectRegistry.js';

/** 项目清单最多列几个：再多就该让 Agent 自己去读文件，而不是往 prompt 里堆 */
export const ENV_CONTEXT_MAX_PROJECTS = 30;

/**
 * 列 key → 中文标签。**按 key 取名，不靠数组下标**：
 * 顺序一律由 TASK_COLUMNS 决定，这里只负责"这列叫什么"。
 * （上一轮去掉「评审中」列时，这份清单和下面的 `${s.todo}/${s.doing}/${s.done}` 是两处
 *  各写各的，改一处漏一处 —— 现在两份都从 TASK_COLUMNS 推。）
 */
const COLUMN_LABELS = { todo: '待处理', doing: '进行中', done: '已完成' };

/** 按 TASK_COLUMNS 的顺序取标签；缺标签时回落成 key 本身，
 *  宁可让 Agent 看到 `todo` 也不要看到空段（空段会让列与标签整体错位）。 */
const columnLabels = TASK_COLUMNS.map(k => COLUMN_LABELS[k] || k);

/**
 * 拼运行环境上下文块。
 *
 * @param {object}   input
 * @param {string}   input.currentProjectPath 本次任务的工作目录（= Agent 的 cwd）
 * @param {object[]} input.projects 项目条目（buildProjectEntries 的输出：{name, path, key}）
 * @param {object[]} input.tasks    tasks.json 里的全部任务
 * @param {object[]} input.jobs     执行记录（snapshotJobs() 的结果）
 * @param {string}   input.tasksFile        真相源文件绝对路径（下面几个同理）
 * @param {string}   input.jobsFile
 * @param {string}   input.orchestratorFile
 * @param {string}   input.configFile
 * @param {number}   [input.maxProjects] 只影响列出条数，不影响合计统计
 * @returns {string|null} 上下文块；没有任何项目可列时返回 null（调用方据此跳过注入）
 */
export function buildEnvContextBlock({
  currentProjectPath = '',
  projects = [],
  tasks = [],
  jobs = [],
  tasksFile = '',
  jobsFile = '',
  orchestratorFile = '',
  configFile = '',
  maxProjects = ENV_CONTEXT_MAX_PROJECTS,
} = {}) {
  const list = Array.isArray(projects) ? projects.filter(p => p && p.key) : [];
  if (list.length === 0) return null;

  const stats = summarizeProjectTasks(
    Array.isArray(tasks) ? tasks : [],
    Array.isArray(jobs) ? jobs : [],
  );

  // 合计按全部任务算（含「未关联项目」那一桶），所以不能用 list 求和
  const total = { total: 0 };
  for (const key of TASK_COLUMNS) total[key] = 0;
  for (const s of stats.values()) {
    total.total += s.total;
    for (const key of TASK_COLUMNS) total[key] += s[key] || 0;
  }

  const limit = Number.isFinite(maxProjects) && maxProjects > 0 ? Math.floor(maxProjects) : ENV_CONTEXT_MAX_PROJECTS;
  const shown = list.slice(0, limit);
  // 当前项目的比对**必须归一化后再比**：条目 key 是 canonicalProjectPath 的结果
  // （Windows 形式小写 + 斜杠归一如 d:\ws\x），而调用方给的 currentProjectPath 是原始写法
  // （盘符/目录段大小写都不一定一致）。直接拿 path 跟 key 比会永远不等 —— 同款口径分叉
  // 在后端项目列表里已经制造过一次「同名项目分裂成两个」，这里不重蹈。
  const currentKey = canonicalProjectPath(currentProjectPath);

  const lines = [];
  lines.push('[运行环境 · 由 zen-gitsync 多项目编排台自动注入，不是用户输入的内容]');
  lines.push('');
  lines.push(`当前任务所在项目（也是你的工作目录）: ${currentProjectPath || '(未指定)'}`);
  lines.push('');
  lines.push(`项目清单（共 ${list.length} 个；格式: 名称 | 路径 | ${columnLabels.join('/')}）:`);
  for (const p of shown) {
    const s = stats.get(p.key) || {};
    const mark = currentKey && p.key === currentKey ? '  ← 当前' : '';
    lines.push(`- ${p.name || p.key} | ${p.path} | ${TASK_COLUMNS.map(k => s[k] || 0).join('/')}${mark}`);
  }
  if (list.length > shown.length) {
    lines.push(`- …还有 ${list.length - shown.length} 个未列出（读下面的文件可以看全）`);
  }
  lines.push('');
  lines.push(
    `看板任务概览：全部项目合计 ${total.total} 条 —— ` +
    TASK_COLUMNS.map(k => `${COLUMN_LABELS[k]} ${total[k] || 0}`).join(' / '),
  );
  lines.push('');
  lines.push('需要细节时直接读这些文件（本机绝对路径，你有读取权限，不必先问用户）:');
  if (tasksFile) lines.push(`- ${tasksFile} —— 全部任务全文（标题/描述/子任务状态/报错/projectPath）`);
  if (jobsFile) lines.push(`- ${jobsFile} —— 历次执行记录（状态与输出）`);
  if (orchestratorFile) lines.push(`- ${orchestratorFile} —— 用户在调度台发过的指令流水`);
  if (configFile) lines.push(`- ${configFile} —— 应用配置（projects / recentDirectories）`);
  lines.push('');
  lines.push(
    '用户问到"我有哪些项目""某件事进展如何"这类问题时，先读上面的文件再回答；' +
    '不要凭当前目录猜测，也不要回答"我看不到/无法访问"。',
  );

  return lines.join('\n');
}
