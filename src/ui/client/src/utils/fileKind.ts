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
