export function registerGitTagRoutes({ app, execGitCommand, clearCommandHistory }) {
  // ============ Git Tag 相关接口 ============

  // 创建标签
  app.post('/api/create-tag', async (req, res) => {
    try {
      const { tagName, message, type, commit } = req.body;

      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      let command = 'git tag';

      if (type === 'annotated') {
        // 附注标签
        if (!message) {
          return res.status(400).json({ success: false, error: '附注标签需要提供说明信息' });
        }
        command += ` -a "${tagName}" -m "${message}"`;
      } else {
        // 轻量标签
        command += ` "${tagName}"`;
      }

      // 如果指定了commit，添加到命令中
      if (commit && commit.trim()) {
        command += ` ${commit.trim()}`;
      }

      const { stdout } = await execGitCommand(command);

      res.json({
        success: true,
        message: '标签创建成功',
        output: stdout
      });
    } catch (error) {
      console.error('创建标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取标签列表
  app.get('/api/list-tags', async (req, res) => {
    try {
      // 使用 git tag -n --format 获取详细信息
      const { stdout } = await execGitCommand(
        'git tag -n --format="%(refname:short)|%(objectname:short)|%(creatordate:iso8601)|%(subject)"'
      );

      if (!stdout.trim()) {
        return res.json({ success: true, tags: [] });
      }

      const tags = stdout.trim().split('\n').map(line => {
        const [name, commit, date, message] = line.split('|');
        return {
          name: name || '',
          commit: commit || '',
          date: date || '',
          message: message || '',
          type: 'lightweight' // 默认为轻量标签
        };
      });

      // 检测哪些是附注标签
      for (const tag of tags) {
        try {
          const { stdout: typeCheck } = await execGitCommand(
            `git cat-file -t ${tag.name}`,
            { log: false }
          );
          if (typeCheck.trim() === 'tag') {
            tag.type = 'annotated';
          }
        } catch (error) {
          // 忽略错误，保持默认值
        }
      }

      res.json({ success: true, tags });
    } catch (error) {
      console.error('获取标签列表失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送标签到远程
  app.post('/api/push-tag', async (req, res) => {
    try {
      const { tagName } = req.body;

      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      const { stdout } = await execGitCommand(`git push origin ${tagName}`);

      res.json({
        success: true,
        message: '标签推送成功',
        output: stdout
      });
    } catch (error) {
      console.error('推送标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送所有标签到远程
  app.post('/api/push-all-tags', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git push origin --tags');

      res.json({
        success: true,
        message: '所有标签推送成功',
        output: stdout
      });
    } catch (error) {
      console.error('推送所有标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 删除标签
  app.post('/api/delete-tag', async (req, res) => {
    try {
      const { tagName } = req.body;

      if (!tagName) {
        return res.status(400).json({ success: false, error: '缺少标签名称' });
      }

      const { stdout } = await execGitCommand(`git tag -d ${tagName}`);

      res.json({
        success: true,
        message: '标签删除成功',
        output: stdout
      });
    } catch (error) {
      console.error('删除标签失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加命令历史的清空API
  app.post('/api/clear-command-history', async (req, res) => {
    try {
      const result = clearCommandHistory();
      res.json({ success: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
