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
// 附件白名单 / mime→ext 映射 / 附件目录初始化。
// 拆分自原 routes/workbench.js 262-310 行。
//
// 设计要点：
//   - 白名单后缀：图片 + 常见文档（PDF / 纯文本 / Markdown / CSV / JSON / log）
//   - mime → ext 与前端 el-upload accept 对齐
//   - sanitizeExt 防路径穿越：未在白名单的后缀返回 fallback（默认 'bin'）

import fsp from 'fs/promises';
import { IMAGES_DIR } from './shared.js';

// 白名单后缀：图片 + 常见文档
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
export const DOC_EXTS = new Set(['pdf', 'txt', 'md', 'markdown', 'csv', 'json', 'log']);
export const ALLOWED_EXTS = new Set([...IMAGE_EXTS, ...DOC_EXTS]);

// mime → 文件后缀；与前端 el-upload accept 对齐
export const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/json': 'json',
  'text/x-log': 'log',
};

// 从文件名提取后缀，未在白名单内返回 fallback（防路径穿越）
export function sanitizeExt(name, fallback = 'bin') {
  if (typeof name !== 'string') return fallback;
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return fallback;
  return ALLOWED_EXTS.has(m[1]) ? m[1] : fallback;
}

export function isImageExt(ext) {
  return IMAGE_EXTS.has(String(ext || '').toLowerCase());
}

export async function ensureImagesDir() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
}

// 把 mime 或文件名规范成统一后缀；遇到不在白名单的情况返回 null
export function resolveExt({ originalName, mime }) {
  if (mime && MIME_TO_EXT[mime.toLowerCase()]) {
    return MIME_TO_EXT[mime.toLowerCase()];
  }
  const fromName = sanitizeExt(originalName, '');
  if (fromName) return fromName;
  return null;
}
