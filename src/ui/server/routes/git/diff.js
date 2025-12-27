import fs from 'fs/promises';

import { createDiffHelpers } from './diffUtils.js';

export function registerGitDiffRoutes({
  app,
  execGitCommand
}) {
  const { checkShouldSkipDiff, checkDiffSize, getDiffStats } = createDiffHelpers({ execGitCommand });

  // 获取文件差异
  app.get('/api/diff', async (req, res) => {
    try {
      const filePath = req.query.file;

      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }

      const diffCommand = `git diff -- "${filePath}"`;

      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }

      // 执行git diff命令获取文件差异
      const { stdout } = await execGitCommand(diffCommand);

      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json(sizeCheck);
      }

      // 统计增加和删除行数
      const stats = getDiffStats(stdout);

      res.json({ diff: stdout, stats });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  // 获取已暂存文件差异
  app.get('/api/diff-cached', async (req, res) => {
    try {
      const filePath = req.query.file;

      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }

      const diffCommand = `git diff --cached -- "${filePath}"`;

      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }

      // 执行git diff --cached命令获取已暂存文件差异
      const { stdout } = await execGitCommand(diffCommand);

      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json(sizeCheck);
      }

      // 统计增加和删除行数
      const stats = getDiffStats(stdout);

      res.json({ diff: stdout, stats });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 获取文件内容 (用于未跟踪文件)
  app.get('/api/file-content', async (req, res) => {
    try {
      const filePath = req.query.file;

      if (!filePath) {
        return res.status(400).json({ error: '缺少文件路径参数' });
      }

      try {
        // 读取文件内容
        const content = await fs.readFile(filePath, 'utf8');
        res.json({ success: true, content });
      } catch (readError) {
        res.status(500).json({ success: false, error: `无法读取文件: ${readError.message}` });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // 解决冲突：保存解决后的文件内容
  app.post('/api/resolve-conflict', async (req, res) => {
    try {
      const { filePath, content } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少文件路径参数'
        });
      }

      if (content === undefined) {
        return res.status(400).json({
          success: false,
          error: '缺少文件内容参数'
        });
      }

      try {
        // 写入解决后的内容到文件
        await fs.writeFile(filePath, content, 'utf8');

        // 不自动添加到暂存区，让用户手动决定
        // Git 会自动将冲突已解决的文件标记为"已修改"状态
        // await execGitCommand(`git add "${filePath}"`);

        res.json({
          success: true,
          message: '冲突已解决，文件已更新'
        });
      } catch (writeError) {
        res.status(500).json({
          success: false,
          error: `保存文件失败: ${writeError.message}`
        });
      }
    } catch (error) {
      console.error('解决冲突失败:', error);
      res.status(500).json({
        success: false,
        error: `解决冲突失败: ${error.message}`
      });
    }
  });

  // 撤回文件修改
  app.post('/api/revert_file', async (req, res) => {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少文件路径参数'
        });
      }

      // 检查文件状态：未跟踪文件需要删除，修改文件需要恢复
      const { stdout: statusOutput } = await execGitCommand(`git status --porcelain -- "${filePath}"`);

      // 未跟踪的文件 (??), 需要删除它
      if (statusOutput.startsWith('??')) {
        try {
          await fs.unlink(filePath);
          return res.json({ success: true, message: '未跟踪的文件已删除' });
        } catch (error) {
          return res.status(500).json({
            success: false,
            error: `删除文件失败: ${error.message}`
          });
        }
      }
      // 已暂存的文件，先取消暂存
      else if (statusOutput.startsWith('A ') || statusOutput.startsWith('M ') || statusOutput.startsWith('D ')) {
        // 先取消暂存
        await execGitCommand(`git reset HEAD -- "${filePath}"`);
      }

      // 已修改文件，取消所有本地修改
      if (statusOutput) {
        await execGitCommand(`git checkout -- "${filePath}"`);
        return res.json({ success: true, message: '文件修改已撤回' });
      } else {
        return res.status(400).json({
          success: false,
          error: '文件没有修改或不存在'
        });
      }
    } catch (error) {
      console.error('撤回文件修改失败:', error);
      res.status(500).json({
        success: false,
        error: `撤回文件修改失败: ${error.message}`
      });
    }
  });
}
