export function createDiffHelpers({ execGitCommand }) {
  /**
   * 检查文件是否应该跳过diff显示（参考GitLab策略）
   * @param {string} filePath - 文件路径
   * @param {string} diffCommand - 要执行的git diff命令
   * @returns {Promise<{shouldSkip: boolean, reason?: string, stats?: object}>}
   */
  async function checkShouldSkipDiff(filePath, diffCommand) {
    // 1. 检查文件扩展名 - 编译/压缩/二进制文件
    const skipExtensions = /\.(min\.js|umd\.cjs|bundle\.js|dist\.js|prod\.js|map|wasm|exe|dll|so|dylib|bin|zip|tar|gz|rar|7z|jar|war|ear|pdf|doc|docx|xls|xlsx|ppt|pptx|jpg|jpeg|png|gif|bmp|ico|mp3|mp4|avi|mov|wmv|flv|webm|mkv|ttf|woff|woff2|eot|otf)$/i;
    if (skipExtensions.test(filePath)) {
      return {
        shouldSkip: true,
        reason: '⚠️ 检测到编译/打包/二进制文件，diff已跳过显示。\n\n提示：这类文件通常是自动生成的或二进制文件，不适合查看diff。\n如需查看，请使用命令行。'
      };
    }

    // 2. 使用 --numstat 快速检查变更量（不获取实际内容，速度快）
    try {
      const numstatCommand = diffCommand.replace(/git (diff|show)/, 'git $1 --numstat');
      const { stdout: numstat } = await execGitCommand(numstatCommand, { log: false });

      if (numstat.trim()) {
        const lines = numstat.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const added = parts[0];
            const deleted = parts[1];

            // 检查是否是二进制文件（显示为 - -）
            if (added === '-' && deleted === '-') {
              return {
                shouldSkip: true,
                reason: '⚠️ 检测到二进制文件，diff已跳过显示。\n\n提示：二进制文件无法以文本形式显示diff。'
              };
            }

            // 检查变更行数是否过多（超过3000行）
            const totalChanges = parseInt(added) + parseInt(deleted);
            if (!isNaN(totalChanges) && totalChanges > 3000) {
              return {
                shouldSkip: true,
                reason: `⚠️ 变更内容过大 (${totalChanges.toLocaleString()} 行变更)，diff已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行或专业diff工具查看大文件变更。\n增加：${parseInt(added).toLocaleString()} 行\n删除：${parseInt(deleted).toLocaleString()} 行`,
                stats: { added: parseInt(added), deleted: parseInt(deleted), total: totalChanges }
              };
            }
          }
        }
      }
    } catch (error) {
      // numstat失败不影响后续流程
      console.log('numstat检查失败，继续执行:', error.message);
    }

    // 3. 通过了初步检查
    return { shouldSkip: false };
  }

  /**
   * 检查diff内容大小，如果过大则跳过
   * @param {string} diffContent - diff内容
   * @param {number} maxSizeKB - 最大大小（KB），默认500KB
   * @returns {object|null} - 如果需要跳过返回提示对象，否则返回null
   */
  function checkDiffSize(diffContent, maxSizeKB = 500) {
    const diffSizeKB = Buffer.byteLength(diffContent, 'utf8') / 1024;
    if (diffSizeKB > maxSizeKB) {
      return {
        diff: `⚠️ Diff内容过大 (${diffSizeKB.toFixed(1)} KB)，已跳过显示以避免浏览器卡顿。\n\n提示：建议使用命令行查看大文件diff。`,
        isLargeFile: true,
        size: diffSizeKB
      };
    }
    return null;
  }

  /**
   * 从 diff 内容中统计增加和删除行数
   * @param {string} diffContent - diff内容
   * @returns {object} - {added, deleted}
   */
  function getDiffStats(diffContent) {
    if (!diffContent) return { added: 0, deleted: 0 };

    const lines = diffContent.split('\n');
    let added = 0;
    let deleted = 0;

    for (const line of lines) {
      // 跳过diff头部信息
      if (line.startsWith('diff ') || line.startsWith('index ') ||
          line.startsWith('--- ') || line.startsWith('+++ ') ||
          line.startsWith('@@ ')) {
        continue;
      }

      // 统计增加和删除的行
      if (line.startsWith('+')) {
        added++;
      } else if (line.startsWith('-')) {
        deleted++;
      }
    }

    return { added, deleted };
  }

  return {
    checkShouldSkipDiff,
    checkDiffSize,
    getDiffStats
  };
}
