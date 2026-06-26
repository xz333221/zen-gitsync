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
import fs from 'fs/promises';
import logger from '../utils/logger.js'
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';

import { createDiffHelpers } from './diffUtils.js';

import { ensureWithinCwd } from '../../utils/pathGuard.js';

/**
 * SEC-PATH-1: resolve user path to be inside process.cwd(), returns null on escape
 * @param {string} userPath
 * @returns {Promise<string|null>}
 */
async function safePathInProject(userPath) {
  if (typeof userPath !== 'string' || !userPath) return null;
  if (/[\x00-\x1f]/.test(userPath)) return null;
  const cwd = process.cwd();
  const result = await ensureWithinCwd(userPath, cwd);
  return result ? result.safePath : null;
}

export function registerGitDiffRoutes({
  app,
  execGitCommand
}) {
  const { checkShouldSkipDiff, checkDiffSize, getDiffStats } = createDiffHelpers({ execGitCommand });

  const skipExtensions = /\.(min\.js|umd\.cjs|bundle\.js|dist\.js|prod\.js|map|wasm|exe|dll|so|dylib|bin|zip|tar|gz|rar|7z|jar|war|ear|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|bmp|ico|mp3|mp4|avi|mov|wmv|flv|webm|mkv|ttf|woff|woff2|eot|otf)$/i;
  const maxBytes = 1024 * 1024;

  // 获取文件差异
  app.get('/api/diff', asyncRoute(async (req, res) => {
      try {
        const filePath = req.query.file;
      
        if (!filePath) {
          return res.status(400).json({ error: '缺少文件路径参数' });
        }
      
        const diffArgs = ['diff', '--', filePath];
      
        // 使用优化的检查函数(diffCommand 用于内部 numstat 检测的字符串转换,
        // 实际走 git 时用 argv 数组,避免 Windows cmd.exe 拼引号问题)
        const skipCheck = await checkShouldSkipDiff(filePath, `git diff -- "${filePath}"`);
        if (skipCheck.shouldSkip) {
          return res.json({
            diff: skipCheck.reason,
            isLargeFile: true,
            stats: skipCheck.stats
          });
        }
      
        // 执行git diff命令获取文件差异
        const { stdout } = await execGitCommand(diffArgs);
      
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
    }));
  // 获取已暂存文件差异
  app.get('/api/diff-cached', asyncRoute(async (req, res) => {
      try {
        const filePath = req.query.file;
      
        if (!filePath) {
          return res.status(400).json({ error: '缺少文件路径参数' });
        }
      
        const diffArgs = ['diff', '--cached', '--', filePath];
      
        // 使用优化的检查函数
        const skipCheck = await checkShouldSkipDiff(filePath, `git diff --cached -- "${filePath}"`);
        if (skipCheck.shouldSkip) {
          return res.json({
            diff: skipCheck.reason,
            isLargeFile: true,
            stats: skipCheck.stats
          });
        }
      
        // 执行git diff --cached命令获取已暂存文件差异
        const { stdout } = await execGitCommand(diffArgs);
      
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
    }));

  // 获取全量 diff（git diff HEAD，含已暂存与未暂存的所有变更）
  app.get('/api/diff-head', asyncRoute(async (req, res) => {
      try {
        const { stdout } = await execGitCommand(['diff', 'HEAD']);
        const MAX = 500 * 1024;
        const content = stdout.length > MAX
          ? stdout.slice(0, MAX) + '\n\n[内容过大，已截断]'
          : stdout;
        res.json({ success: true, diff: content });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 获取文件内容 (用于未跟踪文件)
  app.get('/api/file-content', asyncRoute(async (req, res) => {
      try {
        const filePath = req.query.file;

        if (!filePath) {
          return res.status(400).json({ error: '缺少文件路径参数' });
        }

        // SEC-PATH-1:resolve 到 cwd 内,越界返回 403
        const safeFilePath = await safePathInProject(String(filePath));
        if (!safeFilePath) {
          return res.status(403).json({ error: '禁止访问工作目录以外的文件' });
        }

        try {
          // 二进制/产物文件：直接告知前端 isBinary，不读取内容
          if (skipExtensions.test(safeFilePath)) {
            const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|ico|svg)$/i.test(safeFilePath);
            return res.json({
              success: true,
              isBinary: true,
              isImage,
              content: isImage
                ? '⚠️ 该文件是图片，建议在预览中查看。'
                : '⚠️ 检测到二进制/编译产物文件，不支持以文本形式显示完整内容。'
            });
          }

          // 读取文件内容(走 safePath,不是 user input)
          const content = await fs.readFile(safeFilePath, 'utf8');
          res.json({ success: true, content });
        } catch (readError) {
          res.status(500).json({ success: false, error: `无法读取文件: ${readError.message}` });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    }));

  app.get('/api/git-file-content', asyncRoute(async (req, res) => {
      try {
        const filePath = req.query.file;
        const rev = req.query.rev;

        if (!filePath || !rev) {
          throw new HttpError(400, '缺少必要参数');
        }

        // SEC-PATH-1:路径必须在 cwd 内,越界返回 403
        const safeFilePath = await safePathInProject(String(filePath));
        if (!safeFilePath) {
          return res.status(403).json({ success: false, error: '禁止访问工作目录以外的文件' });
        }

        if (skipExtensions.test(safeFilePath)) {
          return res.json({
            success: true,
            isBinary: true,
            content: '⚠️ 检测到二进制/编译产物文件，不支持以文本形式显示完整内容。'
          });
        }

        const r = String(rev);
        // 用 safeFilePath 而不是 user input,防注入
        const spec = r === ':' ? `:${safeFilePath}` : `${r}:${safeFilePath}`;

        let sizeBytes = 0;
        try {
          const { stdout: sizeOut } = await execGitCommand(['cat-file', '-s', spec], { log: false });
          sizeBytes = parseInt(String(sizeOut).trim(), 10) || 0;
        } catch (e) {
          return res.json({ success: true, notFound: true, content: '' });
        }

        if (sizeBytes > maxBytes) {
          return res.json({
            success: true,
            isLargeFile: true,
            size: sizeBytes,
            content: `⚠️ 文件内容过大 (${(sizeBytes / 1024).toFixed(1)} KB)，已跳过显示以避免浏览器卡顿。`
          });
        }

        const { stdout } = await execGitCommand(['show', spec], { log: false });
        return res.json({ success: true, content: stdout ?? '' });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 解决冲突：保存解决后的文件内容
  app.post('/api/resolve-conflict', asyncRoute(async (req, res) => {
      try {
        const { filePath, content } = req.body;

        if (!filePath) {
          return res.status(400).json({
            success: false,
            error: '缺少文件路径参数'
          });
        }

        // SEC-PATH-1:resolve 到 cwd 内,越界 403
        const safeFilePath = await safePathInProject(String(filePath));
        if (!safeFilePath) {
          return res.status(403).json({ success: false, error: '禁止访问工作目录以外的文件' });
        }

        if (content === undefined) {
          return res.status(400).json({
            success: false,
            error: '缺少文件内容参数'
          });
        }

        try {
          // 写入解决后的内容到文件(走 safePath)
          await fs.writeFile(safeFilePath, content, 'utf8');

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
        logger.error('解决冲突失败:', error);
        res.status(500).json({
          success: false,
          error: `解决冲突失败: ${error.message}`
        });
      }
    }));

  // 撤回文件修改
  app.post('/api/revert_file', asyncRoute(async (req, res) => {
      try {
        const { filePath } = req.body;

        if (!filePath) {
          return res.status(400).json({
            success: false,
            error: '缺少文件路径参数'
          });
        }

        // SEC-PATH-1:resolve 到 cwd 内
        const safeFilePath = await safePathInProject(String(filePath));
        if (!safeFilePath) {
          return res.status(403).json({ success: false, error: '禁止访问工作目录以外的文件' });
        }

        // 检查文件状态：未跟踪文件需要删除，修改文件需要恢复
        const { stdout: statusOutput } = await execGitCommand(['status', '--porcelain', '--', safeFilePath]);

        // 未跟踪的文件 (??), 需要删除它
        if (statusOutput.startsWith('??')) {
          try {
            await fs.unlink(safeFilePath);
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
          await execGitCommand(['reset', 'HEAD', '--', safeFilePath]);
        }

        // 已修改文件，取消所有本地修改
        if (statusOutput) {
          await execGitCommand(['checkout', '--', safeFilePath]);
          return res.json({ success: true, message: '文件修改已撤回' });
        } else {
          return res.status(400).json({
            success: false,
            error: '文件没有修改或不存在'
          });
        }
      } catch (error) {
        logger.error('撤回文件修改失败:', error);
        res.status(500).json({
          success: false,
          error: `撤回文件修改失败: ${error.message}`
        });
      }
    }));

  // 批量撤回文件修改（未跟踪删除，已修改 checkout 还原）
  // body: { filePaths: string[] }
  // 返回: { success, count, results: [{ path, success, error? }] }
  app.post('/api/revert_files', asyncRoute(async (req, res) => {
      const filePaths = Array.isArray(req.body?.filePaths) ? req.body.filePaths : []
      if (filePaths.length === 0) {
        return res.status(400).json({ success: false, error: '缺少文件路径参数' })
      }

      // 批量大小限制,防止 DoS
      const MAX_BATCH = 200;
      if (filePaths.length > MAX_BATCH) {
        return res.status(400).json({ success: false, error: `批量大小不能超过 ${MAX_BATCH}` });
      }

      const results = []
      let successCount = 0

      for (const filePath of filePaths) {
        try {
          // SEC-PATH-1:每个 path 都校验在 cwd 内,越界直接报错
          const safeFilePath = await safePathInProject(String(filePath));
          if (!safeFilePath) {
            results.push({ path: filePath, success: false, error: '禁止访问工作目录以外的文件' });
            continue;
          }

          // 检查文件状态：未跟踪 ??、已暂存 A/M/D、已修改（空状态会返回空字符串）
          const { stdout: statusOutput } = await execGitCommand(['status', '--porcelain', '--', safeFilePath])

          // 未跟踪的文件 (??) → 直接删除
          if (statusOutput.startsWith('??')) {
            try {
              await fs.unlink(safeFilePath)
              results.push({ path: filePath, success: true, message: '未跟踪的文件已删除' })
              successCount++
              continue
            } catch (err) {
              results.push({ path: filePath, success: false, error: `删除文件失败: ${err?.message || err}` })
              continue
            }
          }

          // 已暂存的文件，先取消暂存（不影响工作区）
          if (statusOutput.startsWith('A ') || statusOutput.startsWith('M ') || statusOutput.startsWith('D ')) {
            await execGitCommand(['reset', 'HEAD', '--', safeFilePath])
          }

          // 已修改文件：丢弃工作区修改
          if (statusOutput) {
            await execGitCommand(['checkout', '--', safeFilePath])
            results.push({ path: filePath, success: true, message: '文件修改已撤回' })
            successCount++
          } else {
            // 文件已无修改（可能在并发中被处理掉了）
            results.push({ path: filePath, success: true, message: '文件无修改' })
            successCount++
          }
        } catch (err) {
          results.push({ path: filePath, success: false, error: err?.message || String(err) })
        }
      }

      res.json({
        success: true,
        count: filePaths.length,
        successCount,
        results
      })
    }));
}
