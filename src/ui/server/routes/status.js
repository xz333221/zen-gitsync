import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

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
      const { stdout } = await execGitCommand('git status --porcelain --untracked-files=all');
      // 检测是否处于 MERGING 状态（MERGE_HEAD 文件存在）
      let isMergeInProgress = false;
      let mergeMessage = '';
      try {
        const { stdout: mergeHead } = await execGitCommand('git rev-parse -q --verify MERGE_HEAD');
        isMergeInProgress = mergeHead.trim().length > 0;
        if (isMergeInProgress) {
          // 读取 Git 自动生成的合并提交信息
          try {
            const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
            const mergeMsgPath = path.resolve(gitDir, 'MERGE_MSG');
            const raw = await fs.readFile(mergeMsgPath, 'utf-8');
            // 过滤掉以 # 开头的注释行，取第一个非空行
            mergeMessage = raw
              .split('\n')
              .filter(line => line.trim() && !line.startsWith('#'))
              .join('\n')
              .trim();
          } catch (_) {
            // MERGE_MSG 不存在时忽略
          }
        }
      } catch (_) {
        // MERGE_HEAD 不存在时命令会报错，属正常情况
        isMergeInProgress = false;
      }
      res.json({ status: stdout, isMergeInProgress, mergeMessage });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
