/**
 * 文件锁定判断单点 — 替换 CommitForm/GitStatus/CommitButton/QuickCommitButton/QuickPushButton 5 处复制。
 *
 * 行为:
 *   - 标准化路径分隔符(\\ → /)
 *   - 精确匹配(完全相等)
 *
 * 与后端 /api/check-file-lock 异步检测不同:本函数纯前端计算,适用于按钮禁用 / 列表图标渲染等高频同步场景。
 */

/** 路径标准化:Windows 反斜杠 → 正斜杠 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 给定一组已锁文件路径,判断目标路径是否被锁定。
 * @param filePath   待检测路径(相对 / 绝对均可)
 * @param lockedFiles 已锁文件路径数组(来自 configStore.lockedFiles)
 */
export function isFilePathLocked(filePath: string, lockedFiles: readonly string[] = []): boolean {
  if (!filePath || !lockedFiles?.length) return false
  const target = normalizePath(filePath)
  return lockedFiles.some(locked => normalizePath(locked) === target)
}