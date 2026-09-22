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
// AI 指令文本持久化（生成项目架构说明的指令）。
// 拆分自原 routes/workbench.js 57-158 行。
//
// 指令文件：ai-instruction.json

import fsp from 'fs/promises';
import {
  INSTRUCTION_FILE,
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
