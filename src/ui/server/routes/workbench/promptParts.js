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
// 任务 prompt 正文的拼装规则（纯函数，无副作用）。
//
// 为什么单独成一个文件：taskRunner.js 顶层 import 了 jobStore.js，而后者在**模块加载时**
// 就调用 hydrateJobs() 并回写 ~/.zen-gitsync/jobs.json（还会把陈旧的 running/pending 降级为
// error 后落盘）。单测若直接 import taskRunner 就会碰到真实用户数据 ——
// 所以把"纯拼装"这一小块剥出来，测试只碰它。

/**
 * 拼任务 prompt 的正文 = 提示词模板 + 子任务标题 + 子任务描述。
 *
 * 去重规则只作用于「标题 / 描述」这一对：
 *   主 Agent 派发（POST /api/workbench/orchestrator/dispatch）建的简单任务里
 *   `title = text.split('\n')[0].slice(0, 120)`、`desc = text` —— 单行指令时两者逐字相同，
 *   直接拼会得到「帮我拉取一下代码\n\n帮我拉取一下代码」：白烧 token，而且让 prompt
 *   看起来像谁把话说了两遍。首行超过 120 字时 title 是首行的**前缀**，所以用
 *   startsWith 兜住这个截断情形（判定重复只要求"标题已被描述完整包含"，不丢信息）。
 *
 * 模板（interpolated）刻意不参与去重：那是用户显式配置的提示词，
 * 与标题撞车与否该由用户决定，代码不擅自删。
 *
 * @param {string} template 已插值的提示词模板，可为空
 * @param {string} title    子任务标题
 * @param {string} desc     子任务描述
 * @returns {string} 用空行分隔的非空段落
 */
export function composePromptBody(template, title, desc) {
  const t = (title || '').trim();
  const d = (desc || '').trim();
  // 描述首行 —— title 由它截断而来，这是判定"重复"的依据
  const firstLine = d.split('\n')[0];
  const titleRedundant = !!t && (t === d || firstLine.startsWith(t));

  // 判定用 trim 后的值，但拼进 prompt 的仍是**原值**：
  // 只删掉重复的那一段，其余一个字符都不动（缩进、结尾换行都保持原样）。
  const body = titleRedundant ? [desc] : [title, desc];
  return [template, ...body].filter(s => s && s.trim()).join('\n\n');
}
