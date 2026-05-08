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
      try {
        const { stdout: mergeHead } = await execGitCommand('git rev-parse -q --verify MERGE_HEAD');
        isMergeInProgress = mergeHead.trim().length > 0;
      } catch (_) {
        // MERGE_HEAD 不存在时命令会报错，属正常情况
        isMergeInProgress = false;
      }
      res.json({ status: stdout, isMergeInProgress });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
