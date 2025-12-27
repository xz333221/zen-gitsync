import express from 'express';
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
  getIsGitRepo,
  setRecentPushStatus
}) {
  // 提交更改
  app.post('/api/commit', express.json(), async (req, res) => {
    try {
      const { message, hasNewlines, noVerify } = req.body;

      // 构建 git commit 命令
      let commitCommand = 'git commit';

      // 如果消息包含换行符，使用文件方式提交
      if (hasNewlines) {
        // 创建临时文件存储提交信息
        const tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
        await fs.writeFile(tempFile, message);
        commitCommand += ` -F "${tempFile}"`;
      } else {
        // 否则直接在命令行中提供消息
        commitCommand += ` -m "${message}"`;
      }

      // 添加 --no-verify 参数
      if (noVerify) {
        commitCommand += ' --no-verify';
      }

      console.log(`commitCommand ==>`, commitCommand);
      // 执行提交命令
      await execGitCommand(commitCommand);

      // 如果使用了临时文件，删除它
      if (hasNewlines) {
        const tempFile = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
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
      await execGitCommand('git add .');
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
      await execGitCommand('git add .');
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
      await execGitCommand(`git add "${filePath}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
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
      await execGitCommand(`git reset HEAD -- "${filePath}"`);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // 推送更改
  app.post('/api/push', async (req, res) => {
    try {
      const { stdout } = await execGitCommand('git push');

      // 推送成功后，设置推送状态标记
      setRecentPushStatus({
        justPushed: true,
        pushTime: Date.now(),
        validDuration: 10000 // 10秒内认为分支状态是同步的
      });

      console.log('推送成功，已设置推送状态标记');
      res.json({ success: true, message: stdout });
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

      console.log('开始推送，工作目录:', workDir);

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
        console.log(`Git push 进程结束，退出码: ${code}`);
        console.log('标准输出:', standardOutput);
        console.log('错误输出:', errorOutput);

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
          console.error('推送失败:', errorOutput || standardOutput);

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
        console.error('Git push 进程错误:', error);

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
      const { stdout } = await execGitCommand('git pull');
      res.json({ success: true, message: stdout });
    } catch (error) {
      // 改进错误处理，检查是否需要合并
      const errorMsg = error.message || '';
      const needsMerge = errorMsg.includes('merge') ||
                         errorMsg.includes('需要合并') ||
                         errorMsg.includes('CONFLICT') ||
                         errorMsg.includes('冲突');

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
      const { stdout } = await execGitCommand('git fetch --all');
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

      // 构建Git命令选项
      let commandOptions = [];

      // 修改分支筛选处理 - 使用正确的引用格式
      if (branch.length > 0) {
        // 不再简单拼接分支名，而是将它们作为引用路径处理
        // 如果指定了分支，不再使用--all参数，而是直接用分支名
        commandOptions = commandOptions.filter(opt => opt !== '--all');

        // 将分支名格式化为Git可理解的引用格式
        const branchRefs = branch.map(b => b.trim()).join(' ');

        // 直接将分支名作为命令参数，并确保后面添加 -- 分隔符防止歧义
        return executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, req.query.all === 'true', withParents);
      }

      // 如果没有指定分支，则使用--all参数
      // 作者筛选（支持多作者，使用正则表达式OR操作）
      if (author.length > 0) {
        // 过滤掉空作者
        const validAuthors = author.filter(a => a.trim() !== '');

        if (validAuthors.length === 1) {
          // 单个作者，直接使用--author
          commandOptions.push(`--author="${validAuthors[0].trim()}"`);
        } else if (validAuthors.length > 1) {
          // 多个作者，使用正则表达式OR条件
          // 只转义OR运算符，保持其他内容不变
          const authorPattern = validAuthors
            .map(a => a.trim())
            .join('\\|');  // 在JavaScript字符串中\\|会变成\|，在shell中会成为|

          commandOptions.push(`--author="${authorPattern}"`);
        }
      }

      // 日期范围筛选
      if (dateFrom && dateTo) {
        commandOptions.push(`--after="${dateFrom}" --before="${dateTo} 23:59:59"`);
      } else if (dateFrom) {
        commandOptions.push(`--after="${dateFrom}"`);
      } else if (dateTo) {
        commandOptions.push(`--before="${dateTo} 23:59:59"`);
      }

      // 提交信息筛选
      if (message) {
        commandOptions.push(`--grep="${message}"`);
      }

      // 如果all=true，则不使用限制，否则按页码和limit精确获取
      // 修复：只获取当前页的数据，而不是累计所有之前页的数据
      const limitOption = req.query.all === 'true' ? '' : `-n ${limit} --skip=${skip}`;

      // 合并所有命令选项
      const options = [...commandOptions, limitOption].filter(Boolean).join(' ');

      // 添加父提交信息的格式
      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }

      // console.log(`执行Git命令: git log --all --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`);

      // 使用 git log 命令获取提交历史
      let { stdout: logOutput } = await execGitCommand(
        `git log --all --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`
      );

      // 分页加载优化：不需要获取总数，通过实际返回的数据量判断是否还有更多
      // 这里直接处理已获取的数据，通过返回数据量判断是否还有更多
      processAndSendLogOutput(res, logOutput, page, limit, withParents);
    } catch (error) {
      console.error('获取Git日志失败:', error);
      res.status(500).json({ error: '获取日志失败: ' + error.message });
    }
  });

  // 抽取执行Git日志命令的函数
  async function executeGitLogCommand(res, branchRefs, author, message, dateFrom, dateTo, limit, skip, isAll, withParents = false) {
    try {
      // 构建命令选项
      const commandOptions = [];

      // 作者筛选
      if (author.length > 0) {
        const validAuthors = author.filter(a => a.trim() !== '');

        if (validAuthors.length === 1) {
          commandOptions.push(`--author="${validAuthors[0].trim()}"`);
        } else if (validAuthors.length > 1) {
          const authorPattern = validAuthors.map(a => a.trim()).join('\\|');
          commandOptions.push(`--author="${authorPattern}"`);
        }
      }

      // 日期范围筛选
      if (dateFrom && dateTo) {
        commandOptions.push(`--after="${dateFrom}" --before="${dateTo} 23:59:59"`);
      } else if (dateFrom) {
        commandOptions.push(`--after="${dateFrom}"`);
      } else if (dateTo) {
        commandOptions.push(`--before="${dateTo} 23:59:59"`);
      }

      // 提交信息筛选
      if (message) {
        commandOptions.push(`--grep="${message}"`);
      }

      // 限制选项
      const limitOption = isAll ? '' : `-n ${limit} --skip=${skip}`;

      // 合并所有选项
      const options = [...commandOptions, limitOption].filter(Boolean).join(' ');

      // 准备分支引用，确保它们被正确识别为分支而不是文件名
      // 使用 refs/heads/ 前缀明确指示这是分支
      const formattedBranchRefs = branchRefs.split(' ')
        .map(branch => {
          // 检查是否已经是完整引用
          if (branch.startsWith('refs/') || branch.includes('/')) {
            return branch;
          }
          // 添加refs/heads/前缀
          return `refs/heads/${branch}`;
        })
        .join(' ');

      // 添加父提交信息的格式
      // 确认格式字符串使用 %x1E 作为分隔符
      let formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D';
      if (withParents) {
        formatString = '%H%x1E%an%x1E%ae%x1E%ad%x1E%B%x1E%D%x1E%P';
      }

      // 构建执行的命令
      const command = `git log ${formattedBranchRefs} --pretty=format:"${formatString}" --date=format-local:"%Y-%m-%d %H:%M" ${options}`;
      console.log(`执行Git命令(带分支引用): ${command}`);

      // 执行命令
      const { stdout: logOutput } = await execGitCommand(command);

      // 分页加载优化：不需要获取总数，通过实际返回的数据量判断是否还有更多
      processAndSendLogOutput(res, logOutput, skip / limit + 1, limit, withParents);
    } catch (error) {
      console.error('执行Git日志命令失败:', error);
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

    // console.log(`分页查询 - 页码: ${page}, 每页数量: ${limit}, 返回数量: ${data.length}, 是否有更多: ${hasMore} (优化版本，不计算总数)`);

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
      await execGitCommand('git reset HEAD');
      res.json({ success: true });
    } catch (error) {
      console.error('重置暂存区失败:', error);
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

      // 执行 git reset --hard origin/branch 命令
      await execGitCommand(`git reset --hard origin/${branch}`);
      res.json({ success: true });
    } catch (error) {
      console.error('重置到远程分支失败:', error);
      res.status(500).json({
        success: false,
        error: `重置到远程分支失败: ${error.message}`
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

      console.log(`获取提交文件列表: hash=${hash}`);

      // 执行命令获取提交中修改的文件列表
      const { stdout } = await execGitCommand(`git show --name-only --format="" ${hash}`);

      // 将输出按行分割，并过滤掉空行
      const files = stdout.split('\n').filter(line => line.trim());
      console.log(`找到${files.length}个文件:`, files);

      res.json({
        success: true,
        files
      });
    } catch (error) {
      console.error('获取提交文件列表失败:', error);
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

      console.log(`获取提交文件差异: hash=${hash}, file=${filePath}`);

      const diffCommand = `git show ${hash} -- "${filePath}"`;

      // 使用优化的检查函数
      const skipCheck = await checkShouldSkipDiff(filePath, diffCommand);
      if (skipCheck.shouldSkip) {
        return res.json({
          success: true,
          diff: skipCheck.reason,
          isLargeFile: true,
          stats: skipCheck.stats
        });
      }

      // 执行命令获取文件差异
      const { stdout } = await execGitCommand(diffCommand);

      console.log(`获取到差异内容，长度: ${stdout.length}`);

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
      console.error('获取提交文件差异失败:', error);
      res.status(500).json({
        success: false,
        error: `获取提交文件差异失败: ${error.message}`
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

      console.log(`执行撤销提交操作: hash=${hash}`);

      // 执行git revert命令
      await execGitCommand(`git revert --no-edit ${hash}`);

      res.json({
        success: true,
        message: `已成功撤销提交 ${hash}`
      });
    } catch (error) {
      console.error('撤销提交失败:', error);
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

      console.log(`执行Cherry-pick操作: hash=${hash}`);

      // 执行git cherry-pick命令
      await execGitCommand(`git cherry-pick ${hash}`);

      res.json({
        success: true,
        message: `已成功Cherry-pick提交 ${hash}`
      });
    } catch (error) {
      console.error('Cherry-pick提交失败:', error);
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

      console.log(`执行重置到指定提交操作: hash=${hash}`);

      // 执行git reset --hard命令
      await execGitCommand(`git reset --hard ${hash}`);

      res.json({
        success: true,
        message: `已成功重置到提交 ${hash}`
      });
    } catch (error) {
      console.error('重置到指定提交失败:', error);
      res.status(500).json({
        success: false,
        error: `重置到指定提交失败: ${error.message}`
      });
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
      console.error('清理锁定文件失败:', error)
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
        const { stdout: userName } = await execGitCommand('git config --global user.name');
        if (userName.trim()) {
          await execGitCommand('git config --global --unset user.name');
        }
      } catch (error) {
        console.log('全局用户名配置检查失败，可能不存在:', error.message);
        // 忽略错误继续执行
      }

      try {
        const { stdout: userEmail } = await execGitCommand('git config --global user.email');
        if (userEmail.trim()) {
          await execGitCommand('git config --global --unset user.email');
        }
      } catch (error) {
        console.log('全局邮箱配置检查失败，可能不存在:', error.message);
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

      await execGitCommand(`git config --global user.name "${name}"`);
      await execGitCommand(`git config --global user.email "${email}"`);
      res.json({ success: true, message: '已更新全局Git用户配置' });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: `更新全局Git用户配置失败: ${error.message}`
      });
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
      const { stdout } = await execGitCommand('git config --get remote.origin.url');

      // 返回远程仓库URL
      res.json({
        success: true,
        url: stdout.trim()
      });
    } catch (error) {
      console.error('获取远程仓库URL失败:', error);
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
      const { stdout } = await execGitCommand('git log --format="%an"');

      // 将结果按行分割并过滤空行
      const lines = stdout.split('\n').filter(author => author.trim() !== '');

      // 手动去重，不依赖Unix的uniq命令
      const uniqueAuthors = Array.from(new Set(lines)).sort();

      // 控制台输出一下搜索示例，方便调试
      if (uniqueAuthors.length > 1) {
        const searchExample = uniqueAuthors.slice(0, 2).join('|');
        console.log(`多作者搜索示例: git log --author="${searchExample}"`);
      }

      res.json({
        success: true,
        authors: uniqueAuthors
      });
    } catch (error) {
      console.error('获取作者列表失败:', error);
      res.status(500).json({
        success: false,
        error: '获取作者列表失败: ' + error.message
      });
    }
  });
}
