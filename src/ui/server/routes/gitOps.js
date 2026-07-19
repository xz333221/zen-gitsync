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
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { registerGitDiffRoutes } from './git/diff.js';
import { createDiffHelpers } from './git/diffUtils.js';
import { registerGitStashRoutes } from './git/stash.js';
import { registerGitTagRoutes } from './git/tags.js';

export function registerGitOpsRoutes({
  app,
  execGitCommand,
  configManager,
  execGitAddWithLockFilter,
  addCommandToHistory,
  clearCommandHistory,
  checkAndClearGitLock,
  getIsGitRepo,
  setRecentPushStatus
}) {
  // 提交更改
  app.post('/api/commit', express.json(), async (req, res) => {
    try {
      const { message, hasNewlines, noVerify } = req.body;

      // 构建 git commit 命令
      const commitArgs = ['commit'];

      // 如果消息包含换行符，使用文件方式提交
      let tempFile
      if (hasNewlines) {
        // 创建临时文件存储提交信息
        tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
        await fs.writeFile(tempFile, message);
        commitArgs.push('-F', tempFile);
      } else {
        // 否则直接在命令行中提供消息
        commitArgs.push('-m', message);
      }

      // 添加 --no-verify 参数
      if (noVerify) {
        commitArgs.push('--no-verify');
      }

      logger.info(`commitArgs ==>`, commitArgs);
      // 执行提交命令
      await execGitCommand(commitArgs);

      // 如果使用了临时文件，删除它
      if (hasNewlines && tempFile) {
        await fs.unlink(tempFile).catch(() => {});
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加 add 接口
  app.post('/api/add', async (req, res) => {
    try {
      // 直接执行 git add . - 前端已经做了锁定文件过滤判断
      await execGitCommand(['add', '.']);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加带锁定文件过滤的 add 接口
  app.post('/api/add-filtered', async (req, res) => {
    try {
      // 使用带锁定文件过滤的 git add
      await execGitAddWithLockFilter();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加 add-all 接口（直接执行 git add . 不考虑锁定文件）
  app.post('/api/add-all', async (req, res) => {
    try {
      // 直接执行 git add . 不考虑锁定文件
      await execGitCommand(['add', '.']);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 添加单个文件到暂存区
  app.post('/api/add-file', async (req, res) => {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少文件路径参数'
        });
      }

      // 执行 git add 命令添加特定文件
      await execGitCommand(['add', '--', filePath]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 批量添加文件到暂存区（一次 git add 命令，避免 index.lock 竞争）
  app.post('/api/add-files', async (req, res) => {
    try {
      const { filePaths } = req.body || {};

      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return res.status(400).json({
          success: false,
          error: '缺少文件路径参数',
          successCount: 0,
          failedCount: 0
        });
      }

      // 过滤掉空路径与重复路径
      const uniquePaths = [...new Set(filePaths.filter(p => typeof p === 'string' && p.length > 0))];
      if (uniquePaths.length === 0) {
        return res.status(400).json({
          success: false,
          error: '没有有效的文件路径',
          successCount: 0,
          failedCount: 0
        });
      }

      // 一次 git add 命令暂存所有文件(不再需要 shell 转义,execFile argv 数组天然支持任意路径)
      await execGitCommand(['add', ...uniquePaths]);

      res.json({
        success: true,
        successCount: uniquePaths.length,
        failedCount: 0,
        filePaths: uniquePaths
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message, successCount: 0, failedCount: 0 });
    }
  });

  // 从暂存区移除单个文件
  app.post('/api/unstage-file', async (req, res) => {
    try {
      const { filePath } = req.body;

      if (!filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少文件路径参数'
        });
      }

      // 执行 git reset HEAD 命令移除特定文件的暂存
      await execGitCommand(['reset', 'HEAD', '--', filePath]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送更改
  app.post('/api/push', async (req, res) => {
    try {
      // 防御性检查：空仓库直接返回明确错误,避免 git push 报
      // "src refspec master does not match any" 让用户摸不着头脑。
      const headCheck = await execGitCommand(
        ['rev-parse', '--verify', 'HEAD'],
        { ignoreError: true, log: false }
      );
      if (!headCheck.stdout || !headCheck.stdout.trim()) {
        return res.status(400).json({
          success: false,
          error: '当前仓库没有任何提交，请先在左侧暂存并提交至少一个文件后再推送。',
          errorCode: 'EMPTY_REPO'
        });
      }
      const { stdout } = await execGitCommand(['push']);

      // 推送成功后，设置推送状态标记
      setRecentPushStatus({
        justPushed: true,
        pushTime: Date.now(),
        validDuration: 10000 // 10秒内认为分支状态是同步的
      });

      logger.info('推送成功，已设置推送状态标记');
      res.json({ success: true, message: stdout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送并设置上游分支（git push -u origin <branch>）
  app.post('/api/git/push-with-upstream', async (req, res) => {
    try {
      const { branch } = req.body || {};
      if (!branch || typeof branch !== 'string') {
        return res.status(400).json({ success: false, error: '缺少 branch 参数' });
      }
      // 防御性检查：空仓库（没有任何 commit）直接返回明确错误，
      // 避免 git push -u 报 "src refspec master does not match any" 让用户摸不着头脑。
      // git rev-parse --verify HEAD 在空仓库下返回非零退出 → execGitCommand 用 ignoreError
      // 吞掉异常并 resolve({stdout:''}),用空 stdout 判定空仓库。
      const headCheck = await execGitCommand(
        ['rev-parse', '--verify', 'HEAD'],
        { ignoreError: true, log: false }
      );
      if (!headCheck.stdout || !headCheck.stdout.trim()) {
        return res.status(400).json({
          success: false,
          error: '当前仓库没有任何提交，请先在左侧暂存并提交至少一个文件后再推送。',
          errorCode: 'EMPTY_REPO'
        });
      }
      const { stdout } = await execGitCommand(['push', '-u', 'origin', branch]);
      setRecentPushStatus({
        justPushed: true,
        pushTime: Date.now(),
        validDuration: 10000
      });
      logger.info(`推送并设置上游成功: origin/${branch}`);
      res.json({ success: true, message: stdout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 读取单个 git 全局配置
  // GET /api/git/global-config?key=<name>
  // key 不存在时返回空串（与 git --get 行为一致；前端 getGlobalConfig 容错为空）
  app.get('/api/git/global-config', async (req, res) => {
    try {
      const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
      if (!key) {
        return res.status(400).json({ success: false, error: '缺少 key 参数' });
      }
      try {
        const { stdout } = await execGitCommand(['config', '--global', '--get', key], { log: false });
        return res.json({ success: true, value: String(stdout || '').trim() });
      } catch (err) {
        // git --get 在 key 不存在时返回非零退出码 → 视为"未设置",返回空串
        return res.json({ success: true, value: '' });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 写入单个 git 全局配置
  // POST /api/git/global-config  body: { key, value }
  // value 为空字符串时执行 --unset，与 git 语义一致（允许前端"清空某项"）
  app.post('/api/git/global-config', async (req, res) => {
    try {
      const { key, value } = req.body || {};
      if (!key || typeof key !== 'string') {
        return res.status(400).json({ success: false, error: '缺少 key 参数' });
      }
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (!trimmed) {
        await execGitCommand(['config', '--global', '--unset', key]);
      } else {
        await execGitCommand(['config', '--global', key, trimmed]);
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 带进度的推送更改 (SSE)
  app.post('/api/push-with-progress', async (req, res) => {
    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendProgress = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // 获取当前工作目录 - 与execGitCommand保持一致
      const cwdArg = process.argv.find(arg => arg.startsWith('--path')) || process.argv.find(arg => arg.startsWith('--cwd'));
      let workDir = process.cwd();
      if (cwdArg) {
        const [, value] = cwdArg.split('=');
        workDir = value || process.cwd();
      }

      // 防御性检查:空仓库直接返回 EMPTY_REPO,避免 git push 报
      // "src refspec master does not match any" 走完整个 spawn 流程。
      // 注意:SSE 通道一旦 flushHeaders 就无法再发普通 JSON,只能继续用 SSE 协议。
      const headCheck = await execGitCommand(
        ['rev-parse', '--verify', 'HEAD'],
        { ignoreError: true, log: false }
      );
      if (!headCheck.stdout || !headCheck.stdout.trim()) {
        sendProgress({
          type: 'error',
          error: '当前仓库没有任何提交，请先在左侧暂存并提交至少一个文件后再推送。',
          errorCode: 'EMPTY_REPO'
        });
        return res.end();
      }

      logger.info('开始推送，工作目录:', workDir);

      // 记录开始时间
      const startTime = Date.now();

      // 发送开始消息
      sendProgress({
        type: 'progress',
        message: 'Starting to push to the remote repository...'
      });

      // 使用spawn执行git push --progress
      const gitPush = spawn('git', ['push', '--progress'], {
        cwd: workDir,
        env: {
          ...process.env,
          GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" // 关闭路径转义
        }
      });

      let errorOutput = '';
      let standardOutput = '';

      // Git的进度信息在stderr中
      gitPush.stderr.on('data', (data) => {
        const output = data.toString();
        errorOutput += output;

        // 解析进度信息
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            // 发送原始行
            sendProgress({
              type: 'progress',
              message: line.trim()
            });

            // 识别不同阶段并解析百分比
            const percentMatch = line.match(/(\d+)%/);
            if (percentMatch) {
              const percent = parseInt(percentMatch[1]);
              let stage = 'unknown';

              if (line.includes('Enumerating objects')) {
                stage = 'enumerating';
              } else if (line.includes('Counting objects')) {
                stage = 'counting';
              } else if (line.includes('Compressing objects')) {
                stage = 'compressing';
              } else if (line.includes('Writing objects')) {
                stage = 'writing';
              } else if (line.includes('Resolving deltas')) {
                stage = 'resolving';
              }

              sendProgress({
                type: 'stage-progress',
                stage: stage,
                percent: percent,
                message: line.trim()
              });
            }
          }
        }
      });

      gitPush.stdout.on('data', (data) => {
        standardOutput += data.toString();
      });

      gitPush.on('close', (code) => {
        logger.info(`Git push 进程结束，退出码: ${code}`);
        logger.info('标准输出:', standardOutput);
        logger.info('错误输出:', errorOutput);

        // 计算执行时间
        const executionTime = Date.now() - startTime;

        if (code === 0) {
          // 推送成功
          setRecentPushStatus({
            justPushed: true,
            pushTime: Date.now(),
            validDuration: 10000
          });

          // 添加到命令历史
          addCommandToHistory(
            'git push --progress',
            standardOutput,
            errorOutput,
            null,
            executionTime
          );

          sendProgress({
            type: 'complete',
            success: true,
            message: standardOutput || errorOutput || 'Push successful'
          });
        } else {
          // 推送失败
          logger.error('推送失败:', errorOutput || standardOutput);

          // 添加到命令历史（失败情况）
          addCommandToHistory(
            'git push --progress',
            standardOutput,
            errorOutput,
            errorOutput || standardOutput || `Push failed with code ${code}`,
            executionTime
          );

          sendProgress({
            type: 'complete',
            success: false,
            error: errorOutput || standardOutput || `Push failed with code ${code}`
          });
        }
        res.end();
      });

      gitPush.on('error', (error) => {
        logger.error('Git push 进程错误:', error);

        // 计算执行时间
        const executionTime = Date.now() - startTime;

        // 添加到命令历史（错误情况）
        addCommandToHistory(
          'git push --progress',
          '',
          '',
          error.message,
          executionTime
        );

        sendProgress({
          type: 'complete',
          success: false,
          error: error.message
        });
        res.end();
      });

    } catch (error) {
      // 添加到命令历史（异常情况）
      addCommandToHistory(
        'git push --progress',
        '',
        '',
        error.message,
        0
      );

      sendProgress({
        type: 'complete',
        success: false,
        error: error.message
      });
      res.end();
    }
  });

  // 添加git pull API端点
  app.post('/api/pull', async (req, res) => {
    try {
      const { stdout } = await execGitCommand(['pull']);
      res.json({ success: true, message: stdout });
    } catch (error) {
      // 改进错误处理，检查是否需要合并
      // 合并冲突信息可能在 message 或 stderr 中
      const errorMsg = (error.message || '').toLowerCase();
      const stderrMsg = (error.stderr || '').toLowerCase();
      const stdoutMsg = (error.stdout || '').toLowerCase();
      const fullOutput = errorMsg + ' ' + stderrMsg + ' ' + stdoutMsg;
      
      const needsMerge = fullOutput.includes('merge') ||
                         fullOutput.includes('需要合并') ||
                         fullOutput.includes('conflict') ||
                         fullOutput.includes('冲突') ||
                         fullOutput.includes('automatic merge failed');

      // 返回更详细的错误信息和标记
      res.status(500).json({
        success: false,
        error: error.message,
        needsMerge: needsMerge,
        // 包含完整的错误输出
        fullError: error.stderr || error.message,
        pullOutput: error.stdout || ''
      });
    }
  });

  // 添加git fetch --all API端点
  app.post('/api/fetch-all', async (req, res) => {
    try {
      const { stdout } = await execGitCommand(['fetch', '--all']);
      res.json({ success: true, message: stdout });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 获取日志
  app.get('/api/log', async (req, res) => {
    try {
      // 获取分页参数
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      // 获取筛选参数
      const author = req.query.author ? req.query.author.split(',') : [];
      const message = req.query.message || '';
      const dateFrom = req.query.dateFrom || '';
      const dateTo = req.query.dateTo || '';
      const branch = req.query.branch ? req.query.branch.split(',') : [];
      const withParents = req.query.with_parents === 'true';

      // 如果指定了分支,直接走 executeGitLogCommand 处理 refs/ 前缀
      if (branch.length > 0) {
        const branchRefs = branch.map(b => b.trim()).join(' ');
        return executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, req.query.all === 'true', withParents);
      }

      // 构建 git log 的 argv 数组
      const logArgs = ['log', '--all'];

      // 作者筛选(支持多作者用正则 OR)
      if (author.length > 0) {
        const validAuthors = author.filter(a => a.trim() !== '');
        if (validAuthors.length === 1) {
          logArgs.push(`--author=${validAuthors[0].trim()}`);
        } else if (validAuthors.length > 1) {
          const authorPattern = validAuthors.map(a => a.trim()).join('\\|');
          logArgs.push(`--author=${authorPattern}`);
        }
      }

      // 日期范围筛选
      if (dateFrom && dateTo) {
        logArgs.push(`--after=${dateFrom}`, `--before=${dateTo} 23:59:59`);
      } else if (dateFrom) {
        logArgs.push(`--after=${dateFrom}`);
      } else if (dateTo) {
        logArgs.push(`--before=${dateTo} 23:59:59`);
      }

      // 提交信息筛选
      if (message) {
        logArgs.push(`--grep=${message}`);
      }

      // 分页
      if (req.query.all !== 'true') {
        logArgs.push('-n', String(limit), `--skip=${skip}`);
      }

      // format 字符串直接作为 argv 单元素(不再需要外层 shell 双引号)
      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }
      logArgs.push(`--pretty=format:${formatString}`);
      logArgs.push('--date=format-local:%Y-%m-%d %H:%M');

      let { stdout: logOutput } = await execGitCommand(logArgs);
      processAndSendLogOutput(res, logOutput, page, limit, withParents);
    } catch (error) {
      logger.error('获取Git日志失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  });

  // 抽取执行Git日志命令的函数
  async function executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, isAll, withParents = false) {
    try {
      // 构建 git log argv 数组
      const logArgs = ['log'];

      // 准备分支引用,确保它们被正确识别为分支而不是文件名
      // 使用 refs/heads/ 前缀明确指示这是分支
      const formattedBranchRefs = branchRefs.split(' ')
        .map(branch => {
          if (branch.startsWith('refs/') || branch.includes('/')) {
            return branch;
          }
          return `refs/heads/${branch}`;
        });
      logArgs.push(...formattedBranchRefs);

      // 作者筛选
      if (author.length > 0) {
        const validAuthors = author.filter(a => a.trim() !== '');
        if (validAuthors.length === 1) {
          logArgs.push(`--author=${validAuthors[0].trim()}`);
        } else if (validAuthors.length > 1) {
          const authorPattern = validAuthors.map(a => a.trim()).join('\\|');
          logArgs.push(`--author=${authorPattern}`);
        }
      }

      // 日期范围筛选
      if (dateFrom && dateTo) {
        logArgs.push(`--after=${dateFrom}`, `--before=${dateTo} 23:59:59`);
      } else if (dateFrom) {
        logArgs.push(`--after=${dateFrom}`);
      } else if (dateTo) {
        logArgs.push(`--before=${dateTo} 23:59:59`);
      }

      // 提交信息筛选
      if (message) {
        logArgs.push(`--grep=${message}`);
      }

      // 限制选项
      if (!isAll) {
        logArgs.push('-n', String(limit), `--skip=${skip}`);
      }

      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }
      logArgs.push(`--pretty=format:${formatString}`);
      logArgs.push('--date=format-local:%Y-%m-%d %H:%M');

      logger.info(`执行Git log 命令 argv:`, logArgs);

      const { stdout: logOutput } = await execGitCommand(logArgs);
      processAndSendLogOutput(res, logOutput, skip / limit + 1, limit, withParents);
    } catch (error) {
      logger.error('执行Git日志命令失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  }

  // 抽取处理输出并发送响应的函数（优化版本：不再依赖总数计算）
  function processAndSendLogOutput(res, logOutput, page, limit, withParents = false) {
    // 替换提交记录之间的换行符 - 使用 ASCII 控制字符 \x1E 匹配
    logOutput = logOutput.replace(/\n(?=[a-f0-9]{40}\x1E)/g, "<<<RECORD_SEPARATOR>>>");

  // 按分隔符拆分日志条目
  const logEntries = logOutput.split("<<<RECORD_SEPARATOR>>>");

  // 处理每个日志条目
  const data = logEntries.map(entry => {
    // 使用 ASCII 控制字符 \x1E 拆分字段
    const parts = entry.split('\x1E');
      if (parts.length >= 5) {
        const result = {
          hash: parts[0],
          author: parts[1],
          email: parts[2],
          date: parts[3],
          message: parts[4],
          branch: parts[5] || ''
        };

        // 如果请求了父提交信息，添加到结果中
        if (withParents && parts[6]) {
          result.parents = parts[6].split(' ');
        }

        return result;
      }
      return null;
    }).filter(item => item !== null);

    // 优化：通过返回的数据量判断是否有更多数据，而不依赖总数计算
    // 如果返回的数据量等于请求的limit，说明可能还有更多数据
    // 如果返回的数据量小于limit，说明已经到底了
    const hasMore = data.length === limit;


    // 返回提交历史数据，包括是否有更多数据的标志
    res.json({
      data: data,
      total: -1, // 不再提供总数，前端不应依赖此字段
      page: page,
      limit: limit,
      hasMore: hasMore
    });
  }

  // ========== Diff 大文件检测和过滤工具函数 ==========

  const { checkShouldSkipDiff, checkDiffSize, getDiffStats } = createDiffHelpers({ execGitCommand });

  registerGitDiffRoutes({
    app,
    execGitCommand
  });

  registerGitStashRoutes({
    app,
    execGitCommand,
    configManager
  });

  registerGitTagRoutes({
    app,
    execGitCommand,
    clearCommandHistory
  });

  // 重置暂存区 (git reset HEAD)
  app.post('/api/reset-head', async (req, res) => {
    try {
      // 执行 git reset HEAD 命令
      await execGitCommand(['reset', 'HEAD']);
      res.json({ success: true });
    } catch (error) {
      logger.error('重置暂存区失败:', error);
      res.status(500).json({
        success: false,
        error: `重置暂存区失败: ${error.message}`
      });
    }
  });

  // 重置到远程分支 (git reset --hard origin/branch)
  app.post('/api/reset-to-remote', async (req, res) => {
    try {
      const { branch } = req.body;

      if (!branch) {
        return res.status(400).json({
          success: false,
          error: '缺少分支名称参数'
        });
      }

      // 尝试清理 Git 锁文件(破坏性入口:force=true 绕过 mtime 判断,
      // 仍走 PID liveness 校验——用户主动触发的 reset --hard 不该被
      // 一个刚崩出来的新孤儿锁挡住)
      await checkAndClearGitLock({ force: true });

      // 执行 git reset --hard origin/branch 命令
      await execGitCommand(['reset', '--hard', `origin/${branch}`]);
      res.json({ success: true });
    } catch (error) {
      logger.error('重置到远程分支失败:', error);
      res.status(500).json({
        success: false,
        error: `重置到远程分支失败: ${error.message}`
      });
    }
  });

  // 清除本地所有更改，包括未跟踪文件 (git reset --hard && git clean -fd)
  app.post('/api/discard-all-changes', async (req, res) => {
    try {
      // 尝试清理 Git 锁文件(破坏性入口:force=true 绕过 mtime 判断,
      // 仍走 PID liveness 校验——用户主动触发的 discard-all 不该被
      // 一个刚崩出来的新孤儿锁挡住)
      await checkAndClearGitLock({ force: true });

      // 1. 执行 git reset --hard 丢弃已跟踪文件的更改
      await execGitCommand(['reset', '--hard']);

      // 2. 执行 git clean -fd 移除未跟踪的文件和目录
      await execGitCommand(['clean', '-fd']);
      
      res.json({ success: true });
    } catch (error) {
      logger.error('清除所有更改失败:', error);
      res.status(500).json({
        success: false,
        error: `清除所有更改失败: ${error.message}`
      });
    }
  });

  // 获取提交的文件列表
  app.get('/api/commit-files', async (req, res) => {
    try {
      const hash = req.query.hash;

      if (!hash) {
        return res.status(400).json({
          success: false,
          error: '缺少提交哈希参数'
        });
      }

      logger.info(`获取提交文件列表: hash=${hash}`);

      // 执行命令获取提交中修改的文件列表
      const { stdout } = await execGitCommand(['show', '--name-only', '--format=', hash]);

      // 将输出按行分割，并过滤掉空行
      const files = stdout.split('\n').filter(line => line.trim());
      logger.info(`找到${files.length}个文件:`, files);

      res.json({
        success: true,
        files
      });
    } catch (error) {
      logger.error('获取提交文件列表失败:', error);
      res.status(500).json({
        success: false,
        error: `获取提交文件列表失败: ${error.message}`
      });
    }
  });

  // 获取提交中特定文件的差异
  app.get('/api/commit-file-diff', async (req, res) => {
    try {
      const hash = req.query.hash;
      const filePath = req.query.file;

      if (!hash || !filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数'
        });
      }

      logger.info(`获取提交文件差异: hash=${hash}, file=${filePath}`);

      const diffCommandArgs = ['show', hash, '--', filePath];

      // 使用优化的检查函数
      // checkShouldSkipDiff 接受字符串命令,这里只用于大小判断,先按字面占位;
      // 走 execGitCommand 时仍用 argv 数组保证转义正确。
      const skipCheck = await checkShouldSkipDiff(filePath, `git show ${hash} -- "${filePath}"`);
      if (skipCheck.shouldSkip) {
        return res.json({
          success: true,
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }

      // 执行命令获取文件差异
      const { stdout } = await execGitCommand(diffCommandArgs);

      logger.info(`获取到差异内容，长度: ${stdout.length}`);

      // 检查实际diff大小
      const sizeCheck = checkDiffSize(stdout, 500);
      if (sizeCheck) {
        return res.json({
          success: true,
          ...sizeCheck
        });
      }

      // 统计增加和删除行数
      const stats = getDiffStats(stdout);

      res.json({
        success: true,
        diff: stdout,
        stats
      });
    } catch (error) {
      logger.error('获取提交文件差异失败:', error);
      res.status(500).json({
        success: false,
        error: `获取提交文件差异失败: ${error.message}`
      });
    }
  });

  app.get('/api/commit-file-content', async (req, res) => {
    try {
      const hash = req.query.hash;
      const filePath = req.query.file;
      const version = req.query.version;

      if (!hash || !filePath) {
        return res.status(400).json({
          success: false,
          error: '缺少必要参数'
        });
      }

      const isOld = String(version || 'new') === 'old';
      const targetHash = isOld ? `${hash}^` : `${hash}`;

      const skipExtensions = /\.(min\.js|umd\.cjs|bundle\.js|dist\.js|prod\.js|map|wasm|exe|dll|so|dylib|bin|zip|tar|gz|rar|7z|jar|war|ear|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|bmp|ico|mp3|mp4|avi|mov|wmv|flv|webm|mkv|ttf|woff|woff2|eot|otf)$/i;
      if (skipExtensions.test(String(filePath))) {
        return res.json({
          success: true,
          isBinary: true,
          content: '⚠️ 检测到二进制/编译产物文件，不支持以文本形式显示完整内容。\n\n提示：建议使用专业工具或命令行查看。'
        });
      }

      const spec = `${targetHash}:${filePath}`;

      let sizeBytes = 0;
      try {
        const { stdout: sizeOut } = await execGitCommand(['cat-file', '-s', spec], { log: false });
        sizeBytes = parseInt(String(sizeOut).trim(), 10) || 0;
      } catch (e) {
        return res.json({
          success: true,
          notFound: true,
          content: isOld
            ? '该文件在该提交的上一个版本中不存在（可能是新增文件）。'
            : '该文件在该提交版本中不存在（可能是删除文件或重命名）。'
        });
      }

      const maxBytes = 1024 * 1024;
      if (sizeBytes > maxBytes) {
        return res.json({
          success: true,
          isLargeFile: true,
          size: sizeBytes,
          content: `⚠️ 文件内容过大 (${(sizeBytes / 1024).toFixed(1)} KB)，已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行或编辑器打开查看。`
        });
      }

      try {
        const { stdout } = await execGitCommand(['show', spec], { log: false });
        res.json({
          success: true,
          content: stdout ?? ''
        });
      } catch (error) {
        res.status(500).json({
          success: false,
          error: `获取文件内容失败: ${error.message}`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });

  // 撤销某个提交 (revert)
  app.post('/api/revert-commit', async (req, res) => {
    try {
      const { hash } = req.body;

      if (!hash) {
        return res.status(400).json({
          success: false,
          error: '缺少提交哈希参数'
        });
      }

      logger.info(`执行撤销提交操作: hash=${hash}`);

      // 执行git revert命令
      await execGitCommand(['revert', '--no-edit', hash]);

      res.json({
        success: true,
        message: `已成功撤销提交 ${hash}`
      });
    } catch (error) {
      logger.error('撤销提交失败:', error);
      res.status(500).json({
        success: false,
        error: `撤销提交失败: ${error.message}`
      });
    }
  });

  // Cherry-pick某个提交
  app.post('/api/cherry-pick-commit', async (req, res) => {
    try {
      const { hash } = req.body;

      if (!hash) {
        return res.status(400).json({
          success: false,
          error: '缺少提交哈希参数'
        });
      }

      logger.info(`执行Cherry-pick操作: hash=${hash}`);

      // 执行git cherry-pick命令
      await execGitCommand(['cherry-pick', hash]);

      res.json({
        success: true,
        message: `已成功Cherry-pick提交 ${hash}`
      });
    } catch (error) {
      logger.error('Cherry-pick提交失败:', error);
      res.status(500).json({
        success: false,
        error: `Cherry-pick提交失败: ${error.message}`
      });
    }
  });

  // 重置到指定提交(hard)
  app.post('/api/reset-to-commit', async (req, res) => {
    try {
      const { hash } = req.body;

      if (!hash) {
        return res.status(400).json({
          success: false,
          error: '缺少提交哈希参数'
        });
      }

      logger.info(`执行重置到指定提交操作: hash=${hash}`);

      // 执行git reset --hard命令
      await execGitCommand(['reset', '--hard', hash]);

      res.json({
        success: true,
        message: `已成功重置到提交 ${hash}`
      });
    } catch (error) {
      logger.error('重置到指定提交失败:', error);
      res.status(500).json({
        success: false,
        error: `重置到指定提交失败: ${error.message}`
      });
    }
  });

  // 获取提交完整 diff（用于复制提交内容）
  app.get('/api/commit-diff-full', async (req, res) => {
    try {
      const hash = req.query.hash;
      if (!hash) {
        return res.status(400).json({ success: false, error: '缺少提交哈希参数' });
      }
      const { stdout } = await execGitCommand(['show', hash]);
      // 限制最大 200KB 防止内容过大
      const MAX = 200 * 1024;
      const content = stdout.length > MAX ? stdout.slice(0, MAX) + '\n\n[内容过大，已截断]' : stdout;
      res.json({ success: true, content });
    } catch (error) {
      res.status(500).json({ success: false, error: `获取提交内容失败: ${error.message}` });
    }
  });

  // 添加清理Git锁定文件的接口
  app.post('/api/remove-lock', async (req, res) => {
    try {
      const gitDir = path.join(process.cwd(), '.git')
      const indexLockFile = path.join(gitDir, 'index.lock')

      // 检查文件是否存在
      try {
        await fs.access(indexLockFile)
        // 如果文件存在，尝试删除它
        await fs.unlink(indexLockFile)
        res.json({ success: true, message: '已清理锁定文件' })
      } catch (error) {
        // 如果文件不存在，也返回成功
        if (error.code === 'ENOENT') {
          res.json({ success: true, message: '没有发现锁定文件' })
        } else {
          throw error
        }
      }
    } catch (error) {
      logger.error('清理锁定文件失败:', error)
      res.status(500).json({
        success: false,
        error: `清理锁定文件失败: ${error.message}`
      })
    }
  })

  // 清除Git用户配置
  app.post('/api/clear-user-config', async (req, res) => {
    try {
      // 检查全局配置是否存在，如果存在才删除
      try {
        const { stdout: userName } = await execGitCommand(['config', '--global', 'user.name']);
        if (userName.trim()) {
          await execGitCommand(['config', '--global', '--unset', 'user.name']);
        }
      } catch (error) {
        logger.info('全局用户名配置检查失败，可能不存在:', error.message);
        // 忽略错误继续执行
      }

      try {
        const { stdout: userEmail } = await execGitCommand(['config', '--global', 'user.email']);
        if (userEmail.trim()) {
          await execGitCommand(['config', '--global', '--unset', 'user.email']);
        }
      } catch (error) {
        logger.info('全局邮箱配置检查失败，可能不存在:', error.message);
        // 忽略错误继续执行
      }

      res.json({ success: true, message: '已清除全局Git用户配置' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: `清除全局Git用户配置失败: ${error.message}`
      });
    }
  });

  // 恢复Git用户配置
  app.post('/api/restore-user-config', async (req, res) => {
    try {
      const { name, email } = req.body;
      if (!name || !email) {
        return res.status(400).json({
          success: false,
          error: '需要提供用户名和邮箱'
        });
      }

      await execGitCommand(['config', '--global', 'user.name', name]);
      await execGitCommand(['config', '--global', 'user.email', email]);
      res.json({ success: true, message: '已更新全局Git用户配置' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: `更新全局Git用户配置失败: ${error.message}`
      });
    }
  });

  // 初始化Git仓库
  app.post('/api/git-init', async (req, res) => {
    try {
      const { stdout } = await execGitCommand(['init']);
      res.json({ success: true, output: stdout.trim() });
    } catch (error) {
      logger.error('git init 失败:', error);
      res.json({ success: false, error: error.message || 'git init 失败' });
    }
  });

  // 添加远程仓库的API
  app.post('/api/add-remote', express.json(), async (req, res) => {
    try {
      if (!getIsGitRepo()) {
        return res.json({ success: false, error: '当前目录不是Git仓库' });
      }
      const { name = 'origin', url } = req.body;
      if (!url || !url.trim()) {
        return res.json({ success: false, error: '远程仓库地址不能为空' });
      }
      await execGitCommand(['remote', 'add', name, url.trim()]);
      res.json({ success: true });
    } catch (error) {
      logger.error('添加远程仓库失败:', error);
      res.json({ success: false, error: error.message || '添加远程仓库失败' });
    }
  });

  // 获取远程仓库URL的API
  app.get('/api/remote-url', async (req, res) => {
    try {
      // 检查当前目录是否是Git仓库
      if (!getIsGitRepo()) {
        return res.json({ success: false, error: '当前目录不是Git仓库' });
      }

      // 执行git命令获取远程仓库URL
      const { stdout } = await execGitCommand(['config', '--get', 'remote.origin.url']);

      // 返回远程仓库URL
      res.json({
        success: true,
        url: stdout.trim()
      });
    } catch (error) {
      logger.error('获取远程仓库URL失败:', error);
      res.json({
        success: false,
        error: error.message || '获取远程仓库URL失败'
      });
    }
  });

  // 获取所有作者列表
  app.get('/api/authors', async (req, res) => {
    try {
      // 使用git命令获取所有提交者，不依赖Unix命令
      const { stdout } = await execGitCommand(['log', '--format=%an']);

      // 将结果按行分割并过滤空行
      const lines = stdout.split('\n').filter(author => author.trim() !== '');

      // 手动去重，不依赖Unix的uniq命令
      const uniqueAuthors = Array.from(new Set(lines)).sort();

      // 控制台输出一下搜索示例，方便调试
      if (uniqueAuthors.length > 1) {
        const searchExample = uniqueAuthors.slice(0, 2).join('|');
        logger.info(`多作者搜索示例: git log --author="${searchExample}"`);
      }

      res.json({
        success: true,
        authors: uniqueAuthors
      });
    } catch (error) {
      logger.error('获取作者列表失败:', error);
      res.status(500).json({
        success: false,
        error: '获取作者列表失败: ' + error.message
      });
    }
  });
}
