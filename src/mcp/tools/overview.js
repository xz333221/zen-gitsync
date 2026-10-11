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
// 总入口工具:workbench_overview / workspace_overview。
//
// 为什么把"概览"做成一个工具而不是让模型自己拼:
// g ui 服务端早就在 ~/.zen-gitsync/ai-context/ 里渲染好了一份**给模型看的**快照
// (INDEX.md + 7 个板块 md,每块含摘要、采集时间、"要实时值该怎么查")。
// 那是全项目最便宜的入口 —— 读一个几 KB 的 markdown,就能知道所有板块的现状,
// 不用 parse 37MB 的 jobs.json。MCP 直接把它转出去,别重复造。
import path from 'node:path';

import { AI_CONTEXT_DIR, DATA_DIR } from '../paths.js';
import { listDataFiles, readTextFile, truncate } from '../util.js';

export const overviewTools = [
  {
    name: 'workspace_overview',
    description:
      '【先看这个】一屏了解本机 zen-gitsync 的全部板块现状:当前项目 Git 状态、GitHub/Gitee 仓库数、'
      + '自定义命令、工作台任务统计、系统 CPU/内存/端口、思维导图清单。'
      + '数据来自 g ui 服务端渲染好的工作区快照(不是实时值,各板块采集时间不同)。'
      + '想知道某一板块的细节,再用对应的专用工具深入。',
    inputSchema: {
      type: 'object',
      properties: {
        include_boards: {
          type: 'boolean',
          description: '是否连同各板块的完整快照正文一起返回(默认 false,只回索引摘要)。全文可能上万字,按需再开。',
        },
      },
    },
    async handler(args) {
      const indexPath = path.join(AI_CONTEXT_DIR, 'INDEX.md');
      const index = await readTextFile(indexPath, '');
      if (!index.trim()) {
        return {
          source: 'file',
          available: false,
          note: '还没有工作区快照。这通常是因为 g ui 还没启动过一轮(快照由它生成),'
            + '或者数据目录里还没有 ai-context/ 。让用户跑一次 `g ui` 即可。',
          data_dir: DATA_DIR,
          hint: '也可以直接用 workbench_tasks / repos_list / runtime_status 这些工具 — 它们直读磁盘,不依赖快照。',
        };
      }

      const result = {
        source: 'file',
        snapshot_index: indexPath,
        index: truncate(index, 6000),
      };

      if (args?.include_boards === true) {
        const files = (await listDataFiles(AI_CONTEXT_DIR, { ext: '.md' }))
          .filter(f => !f.endsWith('INDEX.md'));
        const boards = {};
        for (const file of files) {
          const name = path.basename(file, '.md');
          boards[name] = truncate(await readTextFile(file, ''), 12_000);
        }
        result.boards = boards;
      }

      return result;
    },
  },
];
