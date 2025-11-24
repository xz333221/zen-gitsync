/**
 * 路径处理工具函数
 */

/**
 * 从完整路径中提取文件夹名称
 * @param path 完整路径
 * @returns 文件夹名称，如果路径为空则返回默认值
 */
export function getFolderNameFromPath(path: string): string {
  if (!path) return 'Zen GitSync'
  
  // 处理Windows和Unix路径
  const parts = path.replace(/\\/g, '/').split('/')
  
  // 过滤空字符串并返回最后一个部分
  const filtered = parts.filter(p => p)
  
  return filtered.length > 0 ? filtered[filtered.length - 1] : 'Zen GitSync'
}
