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
// MCP 工具表装配。
//
// 按板块分模块,一个板块一个文件(与"一个板块一份数据来源"对齐)。
// 加新工具时:写进对应的板块文件,导出一个 `xxxTools` 数组,在这里拼进去即可 ——
// 不需要动 stdio / http / 协议内核,那三层完全与工具内容无关。
import { overviewTools } from './overview.js';
import { repoTools } from './repos.js';
import { runtimeTools } from './runtime.js';
import { agentTools } from './agent.js';
import { workbenchTools } from './workbench.js';
import { scheduleTools } from './schedules.js';
import { mindmapTools } from './mindmap.js';
import { memoryTools } from './memory.js';

/** 全部工具,顺序即 tools/list 里的顺序(把"先看这个"的放前面)。 */
export const ALL_TOOLS = [
  ...overviewTools,
  ...repoTools,
  ...runtimeTools,
  ...workbenchTools,
  ...scheduleTools,
  ...agentTools,
  ...mindmapTools,
  ...memoryTools,
];

/** 工具名清单(诊断 / 帮助文本用)。 */
export function toolNames() {
  return ALL_TOOLS.map(t => t.name);
}

/** 按名字取一个工具(单测用)。 */
export function findTool(name) {
  return ALL_TOOLS.find(t => t.name === name) || null;
}
