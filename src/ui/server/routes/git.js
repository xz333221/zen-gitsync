import express from 'express';

export function registerGitRoutes({
  app,
  execGitCommand,
  clearBranchCache
}) {
  // 获取所有分支
  app.get('/api/branches', async (req, res) => {
    try {
      // 获取本地分支 - 使用简单的git branch命令
      const { stdout: localBranches } = await execGitCommand('git branch');

      // 获取远程分支
      const { stdout: remoteBranches } = await execGitCommand('git branch -r');

      // 处理本地分支 - 正确解析git branch的标准输出格式
      const localBranchList = localBranches.split('\n')
        .filter(Boolean)
        .map(b => b.trim())
        .map(b => b.startsWith('* ') ? b.substring(2) : b); // 移除星号并保留分支名

      // 处理远程分支，保留完整的远程分支名称
      const remoteBranchList = remoteBranches.split('\n')
        .filter(Boolean)
        .map(b => b.trim())
        .filter(b => b !== 'origin' && !b.includes('HEAD')); // 过滤掉单纯的origin和HEAD引用

      // 合并分支列表
      const allBranches = [
        ...localBranchList,
        ...remoteBranchList
      ];

      res.json({ branches: allBranches });
    } catch (error) {
      console.error('获取分支列表失败:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // 创建新分支
  app.post('/api/create-branch', express.json(), async (req, res) => {
    try {
      const { newBranchName, baseBranch } = req.body;

      if (!newBranchName) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }

      // 构建创建分支的命令
      let command = `git branch ${newBranchName}`;

      // 如果指定了基础分支，则基于该分支创建
      if (baseBranch) {
        command = `git branch ${newBranchName} ${baseBranch}`;
      }

      // 执行创建分支命令
      await execGitCommand(command);

      // 切换到新创建的分支
      await execGitCommand(`git checkout ${newBranchName}`);

      // 清除分支缓存，因为分支已切换
      clearBranchCache();

      res.json({ success: true, branch: newBranchName });
    } catch (error) {
      console.error('创建分支失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 切换分支
  app.post('/api/checkout', async (req, res) => {
    try {
      const { branch } = req.body;
      if (!branch) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }

      // 执行分支切换
      await execGitCommand(`git checkout ${branch}`);

      // 清除分支缓存，因为分支已切换
      clearBranchCache();

      res.json({ success: true });
    } catch (error) {
      console.error('切换分支失败:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 合并分支
  app.post('/api/merge', async (req, res) => {
    try {
      const { branch, noCommit, noFf, squash, message } = req.body;

      if (!branch) {
        return res.status(400).json({ success: false, error: '分支名称不能为空' });
      }

      // 构建Git合并命令 - 直接使用传入的分支名（可能包含origin/前缀）
      let command = `git merge ${branch}`;

      // 添加可选参数
      if (noCommit) {
        command += ' --no-commit';
      }

      if (noFf) {
        command += ' --no-ff';
      }

      if (squash) {
        command += ' --squash';
      }

      if (message) {
        command += ` -m "${message}"`;
      }

      try {
        // 执行合并命令
        const { stdout } = await execGitCommand(command);

        res.json({
          success: true,
          message: '分支合并成功',
          output: stdout
        });
      } catch (error) {
        // 检查是否有合并冲突
        const errorMsg = error.message || '';
        const hasConflicts = errorMsg.includes('CONFLICT') ||
                            errorMsg.includes('Automatic merge failed');

        if (hasConflicts) {
          res.status(409).json({
            success: false,
            hasConflicts: true,
            error: '合并过程中发生冲突，需要手动解决',
            details: errorMsg
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error('合并分支失败:', error);
      res.status(500).json({
        success: false,
        error: `合并分支失败: ${error.message}`
      });
    }
  });

  // 获取Git用户配置信息
  app.get('/api/user-info', async (req, res) => {
    try {
      // 获取全局用户名
      const { stdout: userName } = await execGitCommand('git config --global user.name');
      // 获取全局用户邮箱
      const { stdout: userEmail } = await execGitCommand('git config --global user.email');

      res.json({
        name: userName.trim(),
        email: userEmail.trim()
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
