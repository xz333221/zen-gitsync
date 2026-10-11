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
// MCP 服务端专用的路径补充。
//
// 为什么要有这个文件:src/paths.js 只登记"被多个模块引用过、改过名"的那些路径,
// 工作台的 tasks.json / jobs.json 等文件名一直散在
// src/ui/server/routes/workbench/shared.js 里(而且那个模块会连带 import logger/chalk)。
// MCP 服务端要独立跑(不依赖 g ui 进程),不该为几个字符串把 express 那一层拖进来,
// 所以在这里按同一套规则(DATA_DIR + 文件名)自己拼一份。
//
// ⚠️ 这里新增常量时,必须与 shared.js 那边保持一致 —— 两处口径不同 = 读到空数据却
// 不报错,是最难查的一类问题。本文件里带「镜像: shared.js:NN」注释的就是对应关系。
import path from 'node:path';

import { DATA_DIR } from '../paths.js';

export {
  DATA_DIR,
  AI_SKILLS_DIR,
  AI_MCP_FILE,
  AI_CONTEXT_DIR,
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  MEMORY_GLOBAL_FILE,
  MEMORY_PROJECTS_DIR,
  AGENT_SESSIONS_DIR,
  SCHEDULES_FILE,
  INSTANCES_DIR,
  WORKBENCH_IMAGES_DIR,
  projectAiDir,
  projectSkillsDir,
  projectMcpFile,
} from '../paths.js';

// ── 工作台(镜像: shared.js:34-72) ──────────────────────────────
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
export const JOBS_CONFIG_FILE = path.join(DATA_DIR, 'jobs-config.json');
/** 运行中 job 的跨实例广播目录,每 g ui 进程一个 <pid>.json */
export const LIVE_JOBS_DIR = path.join(DATA_DIR, 'live-jobs');
export const ORCHESTRATOR_FILE = path.join(DATA_DIR, 'orchestrator.json');
export const ORCHESTRATOR_REPORTS_FILE = path.join(DATA_DIR, 'orchestrator-reports.json');
export const HIDDEN_PROJECTS_FILE = path.join(DATA_DIR, 'hidden-projects.json');

// ── 本地仓库清单 ───────────────────────────────────────────────
// 环境变量覆盖的口径与 utils/localRepoScan.js:78 一致(单测靠它把缓存指到临时目录)。
export const LOCAL_REPOS_FILE = process.env.ZEN_LOCAL_REPOS_CACHE
  || path.join(DATA_DIR, 'local-repos.json');

// ── 时间 / 容量常量(镜像: shared.js:44/91) ────────────────────
/** 实例心跳过期阈值,与 utils/instanceRegistry.js:31 的 STALE_MS 一致 */
export const INSTANCE_STALE_MS = 30_000;
/** live-jobs 文件的"还算新鲜"上限,与 liveJobs.js 的 LIVE_MAX_AGE_MS 一致 */
export const LIVE_JOBS_MAX_AGE_MS = 60 * 60 * 1000;
