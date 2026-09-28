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
// 生产环境的接线:把真实的取数实现装配进 createAiContextSnapshotter。
//
// 单独一个文件的原因(与 collectors.js 的分层对应):index.js 与 collectors.js
// 保持"零重量级 import",单测只碰纯函数;**只有这里**才 import 那些带着副作用或
// 拉子进程的模块。这样"这个快照会不会在 import 时就写用户数据"这个问题,看一个
// 文件就能回答。
//
// 两个刻意的取舍:
//
// 1) 所有取数都**复用已有实现**,不新写第二份:
//    · git 状态 → directoryGitState.probeDirectoryGitState(自带 15s TTL 缓存)
//    · 远程仓库 → remoteRepos.loadRemoteReposState(与界面同一份装了/登录了判断)
//    · 系统状态 → monitor.getSystemOverview / listPorts(与监控页同源)
//    · 思维导图 → mindmap.listMindmapFiles(与列表页同源)
//    否则快照里的数字和界面上的对不上,用户第一个就会问为什么。
//
// 2) jobStore **动态 import**,不放在顶层:
//    jobStore.js 在模块加载时就会 hydrateJobs() 并回写 ~/.zen-gitsync/jobs.json
//    (见 promptParts.js 头注释对这件事的处理)。顶层 import 会让"谁 import 了
//    aiContext 就在加载期写盘"变成隐性副作用;放到真正要读执行记录的那一刻,
//    副作用就落在"确实有一轮对话在跑"这个前提下,边界清楚。

import { createAiContextSnapshotter } from './index.js';
import { readJson, TASKS_FILE, TRUTH_FILES } from '../workbench/shared.js';
import { probeDirectoryGitState } from '../../utils/directoryGitState.js';
import { loadRemoteReposState } from '../remoteRepos.js';
import { getSystemOverview, listPorts } from '../monitor.js';
import { listMindmapFiles } from '../mindmap.js';

/** tasks.json 里的任务数组(容错:文件损坏/不存在时回空数组,由 collector 的计数体现) */
async function readTasks() {
  const data = await readJson(TASKS_FILE, { tasks: [] });
  return Array.isArray(data?.tasks) ? data.tasks : [];
}

/** 执行记录:先刷一遍磁盘,避免 Agent 看到的是本进程启动那一刻的旧状态 */
async function readJobs() {
  const { refreshJobsFromDisk, snapshotJobs } = await import('../workbench/jobStore.js');
  await refreshJobsFromDisk();
  return snapshotJobs();
}

/**
 * 建一个面向生产的快照生成器。
 * @param {object} deps
 * @param {object} deps.configManager
 * @param {Function} deps.getCurrentProjectPath
 */
export function createWorkspaceSnapshotter({ configManager, getCurrentProjectPath } = {}) {
  return createAiContextSnapshotter({
    configManager,
    getCurrentProjectPath,
    readTasks,
    readJobs,
    probeGit: (dir) => probeDirectoryGitState(dir),
    loadRemoteReposState: (provider) => loadRemoteReposState(provider),
    getMonitorOverview: () => getSystemOverview(),
    // 只取监听端口:快照里列全量 ESTABLISHED 连接会把文件撑爆且毫无信息量
    listPorts: () => listPorts({ all: false }),
    listMindmapFiles: (dir) => listMindmapFiles(dir),
    // 真相源路径:注入块里直接报给模型,它就能自己 read_file 拿全文,
    // 不必再多一轮"我看看有哪些文件"。清单只有一份 —— 见 workbench/shared.js
    // 的 TRUTH_FILES:envContext（编排台视角）用的是同一个常量,不会再加一处漏一处。
    truthFiles: TRUTH_FILES,
  });
}
