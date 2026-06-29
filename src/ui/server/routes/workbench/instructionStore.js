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
// AI 指令文本持久化（生成指令 + 拆分子任务指令）。
// 拆分自原 routes/workbench.js 57-158 行 + 958-998 行。
//
// 两个独立的指令文件：
//   - ai-instruction.json         生成项目架构说明的指令
//   - ai-subtask-instruction.json 拆分子任务的指令（支持 zh/en 多语言默认）

import fsp from 'fs/promises';
import {
  INSTRUCTION_FILE,
  SUBTASK_INSTRUCTION_FILE,
  ensureDataDir,
  nowIso,
} from './shared.js';

// ── 生成指令（用户首次使用时作为可编辑指令的初始值） ───────────
export const DEFAULT_INSTRUCTION = `你是一名资深软件架构师。

【探索步骤】
1. 先识别项目结构：扫描根目录是否包含 .git 目录，以及 package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml / build.gradle{,.kts} / composer.json / Gemfile / pubspec.yaml 这 9 种 manifest。
2. 如果根目录含 manifest，就把整个根目录视为一个子项目。
3. 如果根目录不含 manifest、但子目录（含一层 .git 或上述 manifest）形成多个子项目，对每个子项目分别探索。
4. 对每个子项目，重点读取：
   - 所有识别到的 manifest（限制单文件 20KB）
   - README.md（限制 8KB）
   - 入口文件：package.json 的 main / scripts / workspaces 字段；pyproject.toml 的 [project.scripts]；go.mod 的 module；Cargo.toml 的 [[bin]]；pom.xml 的 <modules>
   - 2 层目录树（最多 200 行）

【输出要求】
1. 给出一段中文「项目架构说明」，长度不限，模型自行决定篇幅与详尽程度，能写多详细就多详细。覆盖：项目整体定位、技术栈、模块划分、核心流程、关键设计决策。
2. 必须引用子项目里实际存在的文件路径、目录名、依赖名，不要编造。
3. 多个子项目时：先逐个说明，最后输出一段「整体架构」总结它们之间的关系。
4. 语气专业、具体、面向接手这个项目的开发者。
5. 只返回 JSON：{ "name": "项目名（建议：项目名+架构说明）", "summary": "架构说明正文" }。`;

// ── 拆分子任务指令：默认系统指令（用户在 GUI 可编辑覆盖） ───────
// 国际化：根据请求 Accept-Language 在 zh / en 之间选默认。
// 中英两份都内置——用户保存到 ~/.zen-gitsync/ai-subtask-instruction.json 后覆盖。
export const DEFAULT_SUBTASK_INSTRUCTION_ZH = `你是一名任务拆分助手。

【绝对禁止】
- 不要进入任何"plan 模式"、"plan 阶段"或"先写 plan 再执行"。
- 不要输出"我要进入 plan / 准备 / 探索 / 调研"之类的元叙述。
- 不要写"Plan 文件已写入 xxx"或"等用户批准后开始"这种"声明意图"的话。
- 你只做一件事:把用户给的任务拆成可独立执行的子任务清单,直接输出 JSON。中间任何"我要做什么"的描述都属于错误输出。
- 你的输出会被另一个程序读取,该程序只看最终 JSON,所有非 JSON 文字会被丢弃——所以不要把"执行步骤"写进 analysis 段,只写在 JSON 的 desc 字段里。

【思考过程】
在给出 JSON 之前，请先在内部仔细思考（如果模型支持，把思考放在 reasoning 中；否则可以先输出一段较长的仔细分析，再输出 JSON）。分析要覆盖足够维度，不要简短一两句话就过：
- 任务的真实目标是什么？用户提供的描述/图片/上下文里有哪些关键信息和隐藏诉求？
- 涉及哪些技术栈、模块、文件、约束？是否有易被忽略的边界条件、风险点？
- 自然的执行顺序是什么？哪些步骤是前置依赖？哪些可以并行？
- 哪些步骤可能失败、需要单独验证？验证方式是什么？
- 是否需要先做调研/读现有代码的步骤，再做修改？

【拆分原则】
1. 单一职责：每个子任务只做一件事，避免"做 A 和 B"。
2. 粒度适中：单个子任务应当能在一次会话里完成（既不要"实现整个登录功能"这么大，也不要"打印 hello"这么琐碎）。
3. 顺序合理：子任务按依赖关系和执行顺序排列（先准备、后实现、最后验证）。
4. 可验证：每个子任务都有明确的完成标志（"输出文件 xxx"、"通过测试 yyy"、"控制台打印 zzz"）。
5. 数量：不设上限。任务很简单时 1-2 个就够，复杂时按需拆成 10 个、20 个甚至更多子任务都行，直到覆盖所有可独立验证的步骤。
6. 描述具体：desc 字段要写清楚"要做什么、参考什么、产出什么"，不要只是把 title 改写一遍。
7. 如果任务里附带了图片，必须基于图片的实际内容拆分（例如指出图片中的哪个区域、哪个元素需要改），而不是泛泛而谈。

【输出要求】
最后必须输出 JSON，结构：
{
  "subtasks": [
    { "title": "子任务标题", "desc": "子任务的具体描述，包含要做什么、输入是什么、输出/验证标志是什么" }
  ]
}

JSON 要用 \`\`\`json ... \`\`\` 代码块包裹，前面可以有分析文字，但 JSON 必须完整、合法、可解析。`;

export const DEFAULT_SUBTASK_INSTRUCTION_EN = `You are a task breakdown assistant.

[ABSOLUTE PROHIBITIONS]
- Do NOT enter any "plan mode" / "planning phase" / "I'll write a plan first, then execute".
- Do NOT output meta-narration like "I'm entering plan / preparing / exploring / researching".
- Do NOT write "Plan file written to xxx" or "waiting for user approval" style intent-declaration text.
- You only do one thing: split the user's task into an independently executable subtask list and output JSON directly. Any "what I'm going to do" description in the middle is an error.
- Your output is consumed by another program that only reads the final JSON. All non-JSON text is discarded — so put execution steps in the desc field of JSON, not in the analysis section.

[Thinking process]
Before producing JSON, think carefully (put your thoughts in reasoning if the model supports it; otherwise output a longer careful analysis first, then JSON). Cover enough dimensions — don't settle for a one-or-two-sentence summary:
- What is the real goal? What key info and hidden needs are in the description / images / context?
- Which stack, modules, files, constraints are involved? Any easily missed edge cases or risks?
- What is the natural execution order? What blocks what? What can run in parallel?
- Which steps may fail and need separate verification? How will you verify?
- Should a research / read-existing-code step come before the changes?

[Breakdown principles]
1. Single responsibility: each subtask does only one thing, avoid bundling "do A and B".
2. Right granularity: a subtask should finish in one Claude session (not as big as "implement the whole login flow", not as trivial as "print hello").
3. Sensible order: arrange subtasks by dependency / execution order (prepare first, implement, then verify).
4. Verifiable: every subtask has a clear completion signal (e.g. "produce file xxx", "pass test yyy", "log zzz to console").
5. Quantity: no hard limit. Very simple tasks need only 1-2; complex tasks can be split into 10, 20 or more subtasks until every independently verifiable step is covered.
6. Concrete desc: write what to do, what to reference, what to produce — don't just paraphrase the title.
7. If the task includes images, the breakdown must reference the actual image content (which region, which element to change), not just generic talk.

[Output requirements]
End with JSON, structure:
{
  "subtasks": [
    { "title": "subtask title", "desc": "concrete description: what to do, what the input is, what the output / verification signal is" }
  ]
}

Wrap JSON in a \`\`\`json ... \`\`\` code block. Preceding analysis text is allowed, but the JSON must be complete, valid, and parseable.`;

// 兼容旧引用：未保存指令文件时回退到 ZH 版本
export const DEFAULT_SUBTASK_INSTRUCTION = DEFAULT_SUBTASK_INSTRUCTION_ZH;

// 根据请求 Accept-Language 选默认（zh / en）
export function pickDefaultSubtaskInstruction(req) {
  const al = String(req?.headers?.['accept-language'] || '').toLowerCase();
  if (al.startsWith('en')) return DEFAULT_SUBTASK_INSTRUCTION_EN;
  return DEFAULT_SUBTASK_INSTRUCTION_ZH;
}

// ── 生成指令持久化（~/.zen-gitsync/ai-instruction.json） ───────
export async function readInstruction() {
  try {
    const buf = await fsp.readFile(INSTRUCTION_FILE, 'utf-8');
    const obj = JSON.parse(buf);
    if (obj && typeof obj.instruction === 'string' && obj.instruction.trim()) {
      return obj.instruction;
    }
  } catch { /* 文件不存在或解析失败 */ }
  return DEFAULT_INSTRUCTION;
}

export async function writeInstruction(instruction) {
  await ensureDataDir();
  const text = String(instruction || '').trim() || DEFAULT_INSTRUCTION;
  const tmp = `${INSTRUCTION_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ instruction: text, updatedAt: nowIso() }, null, 2), 'utf-8');
  await fsp.rename(tmp, INSTRUCTION_FILE);
}

// ── 拆分子任务指令持久化 ─────────────────────────────────────
// 支持传入 req：根据 Accept-Language 选默认（zh/en）
export async function readSubtaskInstruction(req) {
  try {
    const buf = await fsp.readFile(SUBTASK_INSTRUCTION_FILE, 'utf-8');
    const obj = JSON.parse(buf);
    if (obj && typeof obj.instruction === 'string' && obj.instruction.trim()) {
      return obj.instruction;
    }
  } catch { /* 文件不存在或解析失败 */ }
  return pickDefaultSubtaskInstruction(req);
}

export async function writeSubtaskInstruction(instruction) {
  await ensureDataDir();
  // 写入时如果与当前 locale 默认一致，不写文件——这样前端"isDefault"判定永远准确
  const text = String(instruction || '').trim() || DEFAULT_SUBTASK_INSTRUCTION_ZH;
  const tmp = `${SUBTASK_INSTRUCTION_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ instruction: text, updatedAt: nowIso() }, null, 2), 'utf-8');
  await fsp.rename(tmp, SUBTASK_INSTRUCTION_FILE);
}
