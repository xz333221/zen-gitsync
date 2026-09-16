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
import { createDiffHelpers } from './diffUtils.js';
import logger from '../../utils/logger.js'
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import { assertGitRef } from '../../utils/gitArgs.js';

// git 空 blob 哈希:git add -N(intent-to-add)会在 index 中注册该空 blob,
// 真实内容只存在于工作区
const EMPTY_BLOB_HASH = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

// git stash push 无法处理 intent-to-add(git add -N)条目:
// index 里是空 blob、工作区有内容、HEAD 中不存在该文件,stash 内部 merge 会直接报
// "Entry '<path>' not uptodate. Cannot merge. Cannot save the current worktree state"。
// 本项目的 AI 提交 / commit message 生成流程会对 untracked 文件自动执行 git add -N,
// 因此 stash 前必须把这类文件真正暂存(内容写入 index),stash 才能正常工作。
// 返回被自动暂存的文件列表;失败不阻断主流程。
async function fullyStageIntentToAddFiles(execGitCommand) {
  try {
    const { stdout } = await execGitCommand(['ls-files', '-s'], { log: false });
    const intentFiles = stdout
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.includes(EMPTY_BLOB_HASH))
      .map(l => l.split('\t')[1])
      .filter(Boolean);
    if (intentFiles.length === 0) return [];
    await execGitCommand(['add', '--', ...intentFiles], { log: false });
    logger.warn(`检测到 ${intentFiles.length} 个 intent-to-add 文件(git add -N 产物),已自动完全暂存以兼容 git stash:`, intentFiles);
    return intentFiles;
  } catch (e) {
    logger.warn('intent-to-add 检测/修复失败(将继续尝试储藏):', e?.message || e);
    return [];
  }
}

export function registerGitStashRoutes({ app, execGitCommand, configManager }) {
  const { checkShouldSkipDiff, checkDiffSize, getDiffStats } = createDiffHelpers({ execGitCommand });

  // 获取stash列表
  app.get('/api/stash-list', asyncRoute(async (req, res) => {
      try {
        const { stdout } = await execGitCommand(['stash', 'list']);
      
        // 解析stash列表
        const stashList = stdout.split('\n')
          .filter(Boolean)
          .map(line => {
            // 尝试解析stash行，格式类似: stash@{0}: WIP on branch: commit message
            const match = line.match(/^(stash@\{\d+\}): (.+)$/);
            if (match) {
              return {
                id: match[1],
                description: match[2]
              };
            }
            return null;
          })
          .filter(item => item !== null);
      
        res.json({ success: true, stashes: stashList });
      } catch (error) {
        logger.error('获取stash列表失败:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 创建新的stash
  app.post('/api/stash-save', asyncRoute(async (req, res) => {
      try {
        const { message, includeUntracked, excludeLocked } = req.body;

        // 防御:intent-to-add 条目会导致 git stash push 报 "not uptodate. Cannot merge",先自动完全暂存
        await fullyStageIntentToAddFiles(execGitCommand);

        if (excludeLocked) {
          const lockedFiles = await configManager.getLockedFiles();
          // 包含未跟踪文件，确保状态与 UI 一致
          const { stdout: statusStdout } = await execGitCommand(['status', '--porcelain', '--untracked-files=all'], { log: false });
          const changedFiles = statusStdout
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
              const match = line.match(/^(..)\s+(.+)$/);
              if (match) {
                const status = match[1];
                let filename = match[2];
                if (filename.startsWith('"') && filename.endsWith('"')) {
                  filename = filename.slice(1, -1).replace(/\\(.)/g, '$1');
                }
                return { status, filename };
              }
              return null;
            })
            .filter(Boolean);
      
          const path = (await import('path')).default;
          const fs = (await import('fs')).default;
      
          // 过滤出未锁定且需要包含在 stash 中的路径
          // 修复：当 includeUntracked === true 且变更项是“新目录”时，不能直接把目录作为 pathspec
          // 否则会把目录里的“锁定文件”一起打入 stash。这里将目录展开为具体文件，并逐个过滤锁定路径。
          const filesToStashSet = new Set();
          for (const item of changedFiles) {
            const { status, filename } = item;
            const normalizedFile = path.normalize(filename);
      
            // 检查是否被锁定
            const isLocked = lockedFiles.some(locked => {
              const normalizedLocked = path.normalize(locked);
              return normalizedFile === normalizedLocked || normalizedFile.startsWith(normalizedLocked + path.sep);
            });
      
            if (!isLocked) {
              try {
                const fullPath = path.resolve(filename);
                const stats = fs.statSync(fullPath);
                // 1) 已存在的普通文件：直接加入
                if (stats.isFile()) {
                  filesToStashSet.add(filename);
                } else if (stats.isDirectory()) {
                  // 2) 目录：当勾选了 includeUntracked 时，展开目录下的文件（包含未跟踪和已跟踪修改）
                  if (includeUntracked) {
                    try {
                      // 使用 git 列出该目录下的未跟踪和已修改文件
                      const { stdout: listStdout } = await execGitCommand(['ls-files', '-mo', '--exclude-standard', '--', filename], { log: false });
                      const listed = listStdout
                        .split('\n')
                        .map(l => l.trim())
                        .filter(Boolean)
                        // 仅保留该目录下的条目
                        .filter(p => {
                          const n = path.normalize(p);
                          const base = path.normalize(filename);
                          return n === base || n.startsWith(base + path.sep);
                        });
                      for (const p of listed) {
                        const n = path.normalize(p);
                        const locked = lockedFiles.some(locked => {
                          const nl = path.normalize(locked);
                          return n === nl || n.startsWith(nl + path.sep);
                        });
                        if (!locked) {
                          filesToStashSet.add(p);
                        }
                      }
                    } catch (_) {
                      // 如果 git 列举失败，退化为不处理该目录
                    }
                  }
                }
              } catch (error) {
                // 3) 文件系统不可达的情况
                // 对于已删除的文件（D状态），我们仍然需要包含它们
                if (status.includes('D')) {
                  filesToStashSet.add(filename);
                }
                // 其他情况（如路径不存在且不是删除状态）则跳过
              }
            }
          }
      
          let filesToStash = Array.from(filesToStashSet);
          if (filesToStash.length === 0) {
            return res.json({ success: false, message: '所有更改都是锁定文件，无需储藏' });
          }
      
          // 在执行 stash 前进行候选校验：
          // 1) 仍有跟踪差异的文件
          try {
            const { stdout: diffNames } = await execGitCommand(['diff', '--name-only', '--', ...filesToStash], { log: false });
            const trackedChanged = new Set(diffNames.split('\n').map(s => s.trim()).filter(Boolean));
      
            // 2) 仍为未跟踪的文件（当 includeUntracked 才检查）
            let untrackedExisting = new Set();
            if (includeUntracked) {
              const { stdout: others } = await execGitCommand(['ls-files', '--others', '--exclude-standard', '--', ...filesToStash], { log: false });
              untrackedExisting = new Set(others.split('\n').map(s => s.trim()).filter(Boolean));
            }
      
            // 合并有效集合
            const validSet = new Set();
            for (const f of filesToStash) {
              if (trackedChanged.has(f) || untrackedExisting.has(f)) {
                validSet.add(f);
              }
            }
      
            filesToStash = Array.from(validSet);
          } catch (e) {
            // 校验失败不应中断主流程，保守继续使用原集合
            logger.warn('候选文件有效性校验失败（将继续尝试储藏）:', e?.message || e);
          }
      
          if (filesToStash.length === 0) {
            return res.json({ success: false, message: '没有可储藏的更改（可能刚刚已储藏，或被锁定过滤）' });
          }
      
          const stashArgs = ['stash', 'push'];
          if (message) stashArgs.push('-m', message);
          if (includeUntracked) stashArgs.push('--include-untracked');
          if (filesToStash.length > 0) stashArgs.push('--', ...filesToStash);
      
          const { stdout } = await execGitCommand(stashArgs);
          if (stdout.includes('No local changes to save')) {
            return res.json({ success: false, message: '没有本地更改需要保存' });
          }
          return res.json({ success: true, message: '成功保存未锁定的工作区更改', output: stdout });
        }
      
        const stashArgs = ['stash', 'push'];
        if (message) stashArgs.push('-m', message);
        if (includeUntracked) stashArgs.push('--include-untracked');
        const { stdout } = await execGitCommand(stashArgs);
        if (stdout.includes('No local changes to save')) {
          return res.json({ success: false, message: '没有本地更改需要保存' });
        }
        res.json({ success: true, message: '成功保存工作区更改', output: stdout });
      } catch (error) {
        // 友好处理：当 Git 返回 "No valid patches in input" 时，提示无可储藏更改
        const msg = error?.message || '';
        if (msg.includes('No valid patches in input')) {
          return res.json({ success: false, message: '没有可储藏的更改（可能刚刚已储藏，或被锁定过滤）' });
        }
        // 兜底翻译:intent-to-add 自动修复失败时,把 git 原始报错转成可操作的提示
        if (msg.includes('not uptodate') && msg.includes('Cannot merge')) {
          return res.json({ success: false, message: '存在 intent-to-add(git add -N)状态的文件导致储藏失败,请先暂存(git add)或取消标记(git reset)后重试' });
        }
        logger.error('保存stash失败:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 保存部分文件的stash
  app.post('/api/stash-save-partial', asyncRoute(async (req, res) => {
      try {
        const { files, message, includeUntracked } = req.body;
      
        if (!files || !Array.isArray(files) || files.length === 0) {
          return res.json({ success: false, message: '请选择要储藏的文件' });
        }

        // 防御:intent-to-add 条目会导致 git stash push 报 "not uptodate. Cannot merge",先自动完全暂存
        await fullyStageIntentToAddFiles(execGitCommand);

        // 构建 git stash push 命令
        const stashArgs = ['stash', 'push'];
        if (message) {
          stashArgs.push('-m', message);
        }
        if (includeUntracked) {
          stashArgs.push('--include-untracked');
        }
      
        // 添加文件列表
        stashArgs.push('--', ...files);
      
        const { stdout } = await execGitCommand(stashArgs);
      
        if (stdout.includes('No local changes to save')) {
          return res.json({ success: false, message: '没有本地更改需要保存' });
        }
      
        res.json({
          success: true,
          message: `成功储藏 ${files.length} 个文件`,
          output: stdout
        });
      } catch (error) {
        const msg = error?.message || '';
        if (msg.includes('No valid patches in input')) {
          return res.json({ success: false, message: '没有可储藏的更改' });
        }
        logger.error('保存部分stash失败:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 应用特定的stash
  app.post('/api/stash-apply', asyncRoute(async (req, res) => {
      try {
        const { stashId, pop } = req.body;
      
        if (!stashId) {
          return res.status(400).json({
            success: false,
            error: '缺少stash ID参数'
          });
        }
      
        // stashId 形如 stash@{0}(不含黑名单字符,能通过 ref 校验);
        // 以 - 开头的输入会被 git 当选项,必须挡掉
        const safeStashId = assertGitRef(stashId, 'stash ID');
        // 决定是使用apply(保留stash)还是pop(应用后删除stash)
        const command = pop ? ['stash', 'pop', safeStashId] : ['stash', 'apply', safeStashId];
      
        try {
          const { stdout } = await execGitCommand(command);
      
          res.json({
            success: true,
            message: `成功${pop ? '应用并删除' : '应用'}stash`,
            output: stdout
          });
        } catch (error) {
          // 检查是否有合并冲突
          if (error.message && error.message.includes('CONFLICT')) {
            return res.status(409).json({
              success: false,
              hasConflicts: true,
              error: '应用stash时发生冲突，需要手动解决',
              details: error.message
            });
          }
          throw error;
        }
      } catch (error) {
        logger.error('应用stash失败:', error);
        res.status(error?.statusCode || 500).json({ success: false, error: error.message });
      }
    }));

  // 删除特定的stash
  app.post('/api/stash-drop', asyncRoute(async (req, res) => {
      try {
        const { stashId } = req.body;
      
        if (!stashId) {
          return res.status(400).json({
            success: false,
            error: '缺少stash ID参数'
          });
        }
      
        const safeStashId = assertGitRef(stashId, 'stash ID');
        const { stdout } = await execGitCommand(['stash', 'drop', safeStashId]);
      
        res.json({
          success: true,
          message: '成功删除stash',
          output: stdout
        });
      } catch (error) {
        logger.error('删除stash失败:', error);
        res.status(error?.statusCode || 500).json({ success: false, error: error.message });
      }
    }));

  // 清空所有stash
  app.post('/api/stash-clear', asyncRoute(async (req, res) => {
      try {
        const { stdout } = await execGitCommand(['stash', 'clear']);
      
        res.json({
          success: true,
          message: '成功清空所有stash',
          output: stdout
        });
      } catch (error) {
        logger.error('清空stash失败:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    }));

  // 获取stash中的文件列表（包含未跟踪文件）
  app.get('/api/stash-files', asyncRoute(async (req, res) => {
      try {
        const { stashId } = req.query;
      
        if (!stashId) {
          return res.status(400).json({
            success: false,
            error: '缺少stash ID参数'
          });
        }
        const safeStashId = assertGitRef(stashId, 'stash ID');

        logger.info(`获取stash文件列表: stashId=${safeStashId}`);

        // 0) 解析出当前 stash 提交及其父提交哈希，避免在 Windows 上使用 ^ 语法
        const { stdout: parentsLine } = await execGitCommand(['rev-list', '--parents', '-n', '1', safeStashId], { log: false });
        const hashes = parentsLine.trim().split(/\s+/).filter(Boolean);
        const stashCommit = hashes[0] || '';
        const parent1 = hashes[1] || '';
        const parent3 = hashes[3] || ''; // 当包含未跟踪文件时，第三父才存在
      
        // 1) 跟踪文件的变更列表：父1 与 stash 提交的差异（若无父1则为空）
        let trackedFiles = [];
        if (parent1) {
          const { stdout: trackedOut } = await execGitCommand(['diff', '--name-only', parent1, stashCommit], { log: false });
          trackedFiles = trackedOut.split('\n').map(s => s.trim()).filter(Boolean);
        }
      
        // 2) 未跟踪文件：来自第三父（若存在）
        let untrackedFiles = [];
        if (parent3) {
          const { stdout: untrackedOut } = await execGitCommand(['ls-tree', '-r', '--name-only', parent3], { log: false });
          untrackedFiles = untrackedOut.split('\n').map(s => s.trim()).filter(Boolean);
        }
      
        // 合并并去重
        const fileSet = new Set([ ...trackedFiles, ...untrackedFiles ]);
        const files = Array.from(fileSet);
        logger.info(`找到${files.length}个stash文件(含未跟踪):`, files);
      
        res.json({
          success: true,
          files
        });
      } catch (error) {
        logger.error('获取stash文件列表失败:', error);
        res.status(error?.statusCode || 500).json({
          success: false,
          error: `获取stash文件列表失败: ${error.message}`
        });
      }
    }));

  // 获取stash中特定文件的差异（包含未跟踪文件）
  app.get('/api/stash-file-diff', asyncRoute(async (req, res) => {
      try {
        const { stashId, file } = req.query;
      
        if (!stashId || !file) {
          return res.status(400).json({
            success: false,
            error: '缺少必要参数'
          });
        }
        const safeStashId = assertGitRef(stashId, 'stash ID');
        const safeFile = assertGitPath(file, '文件路径');

        logger.info(`获取stash文件差异: stashId=${safeStashId}, file=${safeFile}`);

        // 先解析父提交哈希，避免使用 ^ 语法
        const { stdout: parentsLine } = await execGitCommand(['rev-list', '--parents', '-n', '1', safeStashId], { log: false });
        const hashes = parentsLine.trim().split(/\s+/).filter(Boolean);
        const stashCommit = hashes[0] || '';
        const parent1 = hashes[1] || '';
        const parent3 = hashes[3] || '';
      
        // 检查该文件是否来自第三父(未跟踪文件)
        let isFromThirdParent = false;
        if (parent3) {
          try {
            await execGitCommand(['cat-file', '-e', `${parent3}:${safeFile}`], { log: false });
            isFromThirdParent = true;
          } catch (_) {
            isFromThirdParent = false;
          }
        }
      
        if (isFromThirdParent) {
          // 未跟踪文件：读取第三父中的内容，构造新增文件的统一diff
          const { stdout: blob } = await execGitCommand(['show', `${parent3}:${safeFile}`], { log: false });
      
          // 检查文件大小
          const sizeCheck = checkDiffSize(blob, 500);
          if (sizeCheck) {
            return res.json({ success: true, ...sizeCheck });
          }
      
          const lines = blob.endsWith('\n') ? blob.slice(0, -1).split('\n') : blob.split('\n');
          const lineCount = lines.length;
      
          // 检查行数
          if (lineCount > 10000) {
            return res.json({
              success: true,
              diff: `⚠️ 变更内容过大 (${lineCount.toLocaleString()} 行)，diff已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行查看大文件变更。`,
              isLargeFile: true,
              stats: { added: lineCount, deleted: 0, total: lineCount }
            });
          }
      
          const plusLines = lines.map(l => `+${l}`).join('\n');
          const diffText = [
            `diff --git a/${safeFile} b/${safeFile}`,
            `new file mode 100644`,
            `--- /dev/null`,
            `+++ b/${safeFile}`,
            `@@ -0,0 +${lineCount} @@`,
            `${plusLines}`
          ].join('\n');
      
          return res.json({ success: true, diff: diffText });
        }
      
        // 否则，使用原有方式获取与父1的变更
        // checkShouldSkipDiff 接受字符串命令用于日志展示,这里只用于大小判断;
        // 走 execGitCommand 时用 argv 数组,避免 Windows 下 cmd.exe 拼引号被破坏。
        const diffCommandForCheck = `git show ${stashCommit} -- "${safeFile}"`;
        const diffCommandArgs = ['show', stashCommit, '--', safeFile];

        // 使用优化的检查函数
        const skipCheck = await checkShouldSkipDiff(safeFile, diffCommandForCheck);
        if (skipCheck.shouldSkip) {
          return res.json({
            success: true,
            diff: skipCheck.reason,
            isLargeFile: true,
            stats: skipCheck.stats
          });
        }
      
        const { stdout } = await execGitCommand(diffCommandArgs);
      
        logger.info(`获取到差异内容，长度: ${stdout.length}`);
      
        // 检查实际diff大小
        const sizeCheck = checkDiffSize(stdout, 500);
        if (sizeCheck) {
          return res.json({ success: true, ...sizeCheck });
        }
      
        // 统计增加和删除行数
        const stats = getDiffStats(stdout);
      
        res.json({ success: true, diff: stdout, stats });
      } catch (error) {
        logger.error('获取stash文件差异失败:', error);
        res.status(error?.statusCode || 500).json({
          success: false,
          error: `获取stash文件差异失败: ${error.message}`
        });
      }
    }));

  // 获取stash中特定文件的完整内容对比（原始 vs 储藏后）
  app.get('/api/stash-file-compare', asyncRoute(async (req, res) => {
      try {
        const { stashId, file } = req.query;

        if (!stashId || !file) {
          throw new HttpError(400, '缺少必要参数');
        }
        const safeStashId = assertGitRef(stashId, 'stash ID');
        const safeFile = assertGitPath(file, '文件路径');

        // 解析父提交哈希
        const { stdout: parentsLine } = await execGitCommand(['rev-list', '--parents', '-n', '1', safeStashId], { log: false });
        const hashes = parentsLine.trim().split(/\s+/).filter(Boolean);
        const stashCommit = hashes[0] || '';
        const parent1 = hashes[1] || '';
        const parent3 = hashes[3] || '';
      
        // 检查是否为未跟踪文件（来自第三父）
        let isFromThirdParent = false;
        if (parent3) {
          try {
            await execGitCommand(['cat-file', '-e', `${parent3}:${safeFile}`], { log: false });
            isFromThirdParent = true;
          } catch (_) {
            isFromThirdParent = false;
          }
        }
      
        // 获取原始内容（储藏前，来自 parent1）
        let original = '';
        if (!isFromThirdParent && parent1) {
          try {
            const { stdout: origOut } = await execGitCommand(['show', `${parent1}:${safeFile}`], { log: false });
            original = origOut ?? '';
          } catch (_) {
            original = ''; // 文件在储藏前不存在
          }
        }
      
        // 获取储藏后的内容
        let modified = '';
        const modRef = isFromThirdParent ? parent3 : stashCommit;
        if (modRef) {
          try {
            const { stdout: modOut } = await execGitCommand(['show', `${modRef}:${safeFile}`], { log: false });
            modified = modOut ?? '';
          } catch (_) {
            modified = ''; // 文件已被删除
          }
        }
      
        res.json({ success: true, original, modified });
      } catch (error) {
        logger.error('获取stash文件对比失败:', error);
        res.status(error?.statusCode || 500).json({ success: false, error: `获取stash文件对比失败: ${error.message}` });
      }
    }));
}
