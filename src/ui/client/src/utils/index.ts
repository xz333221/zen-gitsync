/**
 * 公共工具函数库
 * 包含diff格式化、HTML转义、提交信息处理等通用功能
 */

/**
 * 转义HTML标签
 * @param text 需要转义的文本
 * @returns 转义后的文本
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * 格式化Git diff内容，添加语法高亮
 * @param diffText Git diff原始文本
 * @returns 格式化后的HTML字符串
 */
export function formatDiff(diffText: string): string {
  if (!diffText) return "";

  // 将差异内容按行分割
  const lines = diffText.split("\n");

  // 为每行添加适当的CSS类
  return lines
    .map((line) => {
      // 先转义HTML标签，再添加样式
      const escapedLine = escapeHtml(line);

      if (line.startsWith("diff --git")) {
        return `<div class="diff-header">${escapedLine}</div>`;
      } else if (line.startsWith("---")) {
        return `<div class="diff-old-file">${escapedLine}</div>`;
      } else if (line.startsWith("+++")) {
        return `<div class="diff-new-file">${escapedLine}</div>`;
      } else if (line.startsWith("@@")) {
        return `<div class="diff-hunk-header">${escapedLine}</div>`;
      } else if (line.startsWith("+")) {
        return `<div class="diff-added">${escapedLine}</div>`;
      } else if (line.startsWith("-")) {
        return `<div class="diff-removed">${escapedLine}</div>`;
      } else {
        return `<div class="diff-context">${escapedLine}</div>`;
      }
    })
    .join("");
}

/**
 * 格式化stash差异内容（与formatDiff功能相同，保持向后兼容）
 * @param diffText Git stash diff原始文本
 * @returns 格式化后的HTML字符串
 */
export function formatStashDiff(diffText: string): string {
  return formatDiff(diffText);
}

/**
 * 格式化提交信息，支持多行显示
 * @param message 提交信息
 * @returns 格式化后的提交信息
 */
export function formatCommitMessage(message: string): string {
  if (!message) return "(无提交信息)";
  return message.trim();
}

/**
 * 提取纯净的提交信息（去除类型前缀）
 * @param message 完整的提交信息
 * @returns 去除格式前缀后的描述内容
 */
export function extractPureMessage(message: string): string {
  if (!message) return "";

  // 匹配常见的提交信息格式：type(scope): description 或 type: description
  // 使用 dotAll 标志来匹配多行内容
  const conventionalCommitRegex = /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?\s*:\s*(.+)$/s;
  const match = message.match(conventionalCommitRegex);

  if (match) {
    // 如果匹配到标准格式，返回描述部分（保留多行结构）
    return match[3].trim();
  }

  // 如果不是标准格式，返回原始信息
  return message.trim();
}

/**
 * 处理文件路径，标准化路径分隔符
 * @param filePath 文件路径
 * @returns 标准化后的路径（使用正斜杠）
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * 判断是否为空字符串或只包含空白字符
 * @param str 要检查的字符串
 * @returns 是否为空或空白
 */
export function isBlank(str: string | null | undefined): boolean {
  return !str || str.trim() === '';
}

/**
 * 截断长文本，超出指定长度时添加省略号
 * @param text 原始文本
 * @param maxLength 最大长度
 * @returns 截断后的文本
 */
export function truncateText(text: string, maxLength: number): string {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * 格式化时间戳为可读的相对时间
 * @param timestamp 时间戳或日期字符串
 * @returns 相对时间描述
 */
export function formatRelativeTime(timestamp: string | number | Date): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) {
    return `${days}天前`;
  } else if (hours > 0) {
    return `${hours}小时前`;
  } else if (minutes > 0) {
    return `${minutes}分钟前`;
  } else {
    return '刚刚';
  }
}

// 默认导出所有函数
export default {
  escapeHtml,
  formatDiff,
  formatStashDiff,
  formatCommitMessage,
  extractPureMessage,
  normalizePath,
  isBlank,
  truncateText,
  formatRelativeTime
};
