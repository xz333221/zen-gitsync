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
// 工作台后端路由入口。
//
// 本文件原本是 3539 行的巨型文件（含所有顶层工具函数 + 45 个路由端点）。
// 2026-06-29 已按业务域拆分到 ./workbench/ 子目录的 9 个模块：
//   - shared.js          常量 + 通用工具 (nowIso, genId, readJson, writeJson, interpolate)
//   - jsonParse.js       JSON 解析降级链 (parseSubtaskJson 等)
//   - llmClient.js       LLM 客户端 (callLlmJson, callLlmStream)
//   - projectScan.js     子项目识别 (findSubProjects, detectProjectManifest)
//   - attachmentUtils.js 附件白名单 (sanitizeExt, resolveExt, MIME_TO_EXT)
//   - sessionStore.js    AI 对话拆分会话持久化
//   - instructionStore.js AI 指令读写
//   - jobStore.js        jobs Map + bus + 持久化 + retention
//   - taskRunner.js      任务执行引擎 (runTaskQueue, runSingleSubtask)
//   - index.js           registerWorkbenchRoutes 入口聚合（45 个路由）
//
// 此处保留 re-export 是为了让 src/ui/server/index.js 的 import 路径不变。

export { registerWorkbenchRoutes } from './workbench/index.js';
