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
import express from 'express';
import logger from '../utils/logger.js'
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import { assertGitRef } from '../utils/gitArgs.js';

export function registerGitRoutes({
  app,
  execGitCommand,
  clearBranchCache
}) {
  // 获取所有分支
  app.get('/api/branches', asyncRoute(async (req, res) => {
      try {
        // 获取本地分支 - 使用简单的git branch命令
        const { stdout: localBranches } = await execGitCommand(['branch']);
      
        // 获取远程分支
        const { stdout: remoteBranches } = await execGitCommand(['branch', '-r']);
      
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
        logger.error('获取分支列表失败:', error);
        res.status(500).json({ error: error.message });
      }
    }));

  // 创建新分支
  app.post('/api/create-branch', express.json(), async (req, res) => {
    try {
      const { newBranchName, baseBranch } = req.body;

      if (!newBranchName) {
        throw new HttpError(400, '分支名称不能为空');
      }
      // 分支名落在 git 的参数位上,不校验的话 --upload-pack=... 这类能被当选项解析
      const safeBranchName = assertGitRef(newBranchName, '分支名');

      // 构建创建分支的命令
      let commandArgs = ['branch', safeBranchName];

      // 如果指定了基础分支，则基于该分支创建
      if (baseBranch) {
        commandArgs = ['branch', safeBranchName, assertGitRef(baseBranch, '基础分支名')];
      }

      // 执行创建分支命令
      await execGitCommand(commandArgs);

      // 切换到新创建的分支
      await execGitCommand(['checkout', safeBranchName]);

      // 清除分支缓存，因为分支已切换
      clearBranchCache();

      res.json({ success: true, branch: safeBranchName });
    } catch (error) {
      logger.error('创建分支失败:', error);
      res.status(error?.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  // 切换分支
  app.post('/api/checkout', asyncRoute(async (req, res) => {
      try {
        const { branch } = req.body;
        if (!branch) {
          throw new HttpError(400, '分支名称不能为空');
        }
        // 下面的 refs/remotes/<branch> 是拼字符串(有前缀,不以 - 开头,安全),
        // 但 checkout 的参数位必须校验
        const safeBranch = assertGitRef(branch, '分支名');

        let finalBranch = safeBranch;

        // 远程分支（如 origin/xxx）：直接 checkout 远程引用会进入 detached HEAD，
        // 需要先解析出同名本地分支——已存在则直接切换，不存在则基于远程分支创建并跟踪。
        if (safeBranch.includes('/')) {
          const { stdout: remoteRef } = await execGitCommand(
            ['rev-parse', '--verify', '--quiet', `refs/remotes/${safeBranch}`],
            { ignoreError: true, log: false }
          );

          if (remoteRef.trim()) {
            // 去掉第一个路径段（远程名），得到本地分支名，支持 origin/feature/x 这类多级名称
            const localName = safeBranch.substring(safeBranch.indexOf('/') + 1);
            const { stdout: localRef } = await execGitCommand(
              ['rev-parse', '--verify', '--quiet', `refs/heads/${localName}`],
              { ignoreError: true, log: false }
            );

            if (localRef.trim()) {
              // 本地已有同名分支，直接切换
              finalBranch = localName;
            } else {
              // 本地没有：创建同名本地分支并跟踪该远程分支
              await execGitCommand(['checkout', '--track', safeBranch]);
              clearBranchCache();
              res.json({ success: true, branch: localName, created: true });
              return;
            }
          }
        }

        // 执行分支切换
        await execGitCommand(['checkout', finalBranch]);

        // 清除分支缓存，因为分支已切换
        clearBranchCache();

        res.json({ success: true, branch: finalBranch });
      } catch (error) {
        logger.error('切换分支失败:', error);
        res.status(error?.statusCode || 500).json({ success: false, error: error.message });
      }
    }));

  // 合并分支
  app.post('/api/merge', asyncRoute(async (req, res) => {
      try {
        const { branch, noCommit, noFf, squash, message } = req.body;
      
        if (!branch) {
          throw new HttpError(400, '分支名称不能为空');
        }
      
        // 构建Git合并命令 - 直接使用传入的分支名（可能包含origin/前缀）
        const commandArgs = ['merge', branch];
      
        // 添加可选参数
        if (noCommit) commandArgs.push('--no-commit');
        if (noFf) commandArgs.push('--no-ff');
        if (squash) commandArgs.push('--squash');
        if (message) commandArgs.push('-m', message);
      
        try {
          // 执行合并命令
          const { stdout } = await execGitCommand(commandArgs);
      
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
        logger.error('合并分支失败:', error);
        res.status(500).json({
          success: false,
          error: `合并分支失败: ${error.message}`
        });
      }
    }));

  // 获取Git用户配置信息
  app.get('/api/user-info', asyncRoute(async (req, res) => {
      try {
        // 获取全局用户名
        const { stdout: userName } = await execGitCommand(['config', '--global', 'user.name']);
        // 获取全局用户邮箱
        const { stdout: userEmail } = await execGitCommand(['config', '--global', 'user.email']);
      
        res.json({
          name: userName.trim(),
          email: userEmail.trim()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }));
}
