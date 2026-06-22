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
import { promises as fs } from 'fs';
import path from 'path';

export function registerStatusRoutes({
  app,
  getCommandHistory,
  execGitCommand
}) {
  // Add new endpoint for command history
  app.get('/api/command-history', async (req, res) => {
    try {
      const history = getCommandHistory();
      res.json({ success: true, history });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/status_porcelain', async (req, res) => {
    try {
      const { stdout } = await execGitCommand(['status', '--porcelain', '--untracked-files=all']);
      // 检测是否处于 MERGING 状态（MERGE_HEAD 存在）
      let isMergeInProgress = false;
      let mergeMessage = '';
      try {
        const { stdout: mergeHead } = await execGitCommand(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
        isMergeInProgress = mergeHead.trim().length > 0;
      } catch (_) {
        // MERGE_HEAD 不存在时命令会报错，属正常情况
        isMergeInProgress = false;
      }
      if (isMergeInProgress) {
        try {
          const { stdout: gitDir } = await execGitCommand(['rev-parse', '--git-dir']);
          const mergeMsgPath = path.resolve(gitDir.trim(), 'MERGE_MSG');
          const raw = await fs.readFile(mergeMsgPath, 'utf-8');
          // 过滤掉以 # 开头的注释行，拼接所有非空非注释行（保留多段信息如合并分支列表）
          mergeMessage = raw
            .split('\n')
            .filter(line => line.trim() && !line.startsWith('#'))
            .join('\n')
            .trim();
        } catch (_) {
          // MERGE_MSG 不存在/无权限时忽略
        }
      }
      res.json({ status: stdout, isMergeInProgress, mergeMessage });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
