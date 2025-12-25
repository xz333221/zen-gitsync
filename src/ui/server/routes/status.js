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
      res.json({ status: stdout });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
