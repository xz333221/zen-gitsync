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

/** 音频扩展名（交给 <audio> 直接播放，不走 Monaco / 文本读取） */
export const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba',
])

/** 视频扩展名（交给 <video> 直接播放） */
export const VIDEO_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi',
])

export const MEDIA_EXTS = new Set([...AUDIO_EXTS, ...VIDEO_EXTS])

/** 根据文件扩展名判断是否为图片 */
export function isImageFile(path: string): boolean {
  if (!path) return false
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTS.has(ext)
}

/** 音视频播放器类型；非媒体返回 null */
export function getMediaKind(path: string): 'audio' | 'video' | null {
  if (!path) return null
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (VIDEO_EXTS.has(ext)) return 'video'
  return null
}

export function isMediaFile(path: string): boolean {
  return getMediaKind(path) !== null
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
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'ogg':
    case 'oga': return 'audio/ogg'
    case 'm4a': return 'audio/mp4'
    case 'aac': return 'audio/aac'
    case 'flac': return 'audio/flac'
    case 'opus': return 'audio/opus'
    case 'weba': return 'audio/webm'
    case 'mp4':
    case 'm4v': return 'video/mp4'
    case 'webm': return 'video/webm'
    case 'ogv': return 'video/ogg'
    case 'mov': return 'video/quicktime'
    case 'mkv': return 'video/x-matroska'
    case 'avi': return 'video/x-msvideo'
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
