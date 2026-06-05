/**
 * 文件类型辅助工具
 * - 图片/二进制/文本分类
 * - mime 推断
 */

export const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
])

/** 根据文件扩展名判断是否为图片 */
export function isImageFile(path: string): boolean {
  if (!path) return false
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

/** 根据文件扩展名返回 mime，未知返回 application/octet-stream */
export function getMimeByExt(path: string): string {
  if (!path) return 'application/octet-stream'
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    case 'ico': return 'image/x-icon'
    case 'svg': return 'image/svg+xml'
    case 'txt':
    case 'log': return 'text/plain'
    case 'md': return 'text/markdown'
    case 'json': return 'application/json'
    case 'html':
    case 'htm': return 'text/html'
    default: return 'application/octet-stream'
  }
}

/** 通过 raw 端点生成预览 URL（用于 img.src） */
export function getRawFileUrl(path: string): string {
  return `/api/editor/raw?path=${encodeURIComponent(path)}`
}
