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

import path from 'path';
import fsp from 'fs/promises';
import { HttpError } from '../../utils/asyncRoute.js';
import { IMAGES_DIR, nowIso } from './shared.js';

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

// ════════════════════════════════════════════════════════════════════════════
// 派发附件暂存区
//
// 主 Agent 控制台要能在**任务被建出来之前**收附件（粘贴的截图 / 选的文件），
// 而 §17 的上传端点都要求 taskId / subId 作为挂载点 —— 派发那一刻两者都还不存在。
// 所以先落到这个暂存目录：文件名 `{attId}.{ext}`，不写任何 JSON，
// 附件记录由前端持有；派发成功时服务端再把它 move 进 `_task-{taskId}/`。
//
// 目录名带下划线前缀是为了不和 `_task-{id}` / `{subId}` 撞名
// （genId 形如 `mu55toof-2555ou`，不会以 `_` 开头）。
// ════════════════════════════════════════════════════════════════════════════
export const DISPATCH_STAGING_DIR = path.join(IMAGES_DIR, '_dispatch');

/** genId 的实际形状；暂存区只认这种 id，挡掉 `../` 之类的路径穿越 */
const ATT_ID_RE = /^[a-z0-9][a-z0-9-]{4,62}$/i;

export function isSafeAttId(id) {
  return typeof id === 'string' && ATT_ID_RE.test(id);
}

// 反向映射（raw 端点用）：暂存附件没有 JSON 记录，mime 只能从后缀推。
// MIME_TO_EXT 里同一族只登记了规范后缀，白名单中的别名要单独补，
// 否则 `a.jpeg` 会被当成 octet-stream 下载而不是 inline 显示。
const EXT_TO_MIME = (() => {
  const out = {};
  for (const [mime, ext] of Object.entries(MIME_TO_EXT)) {
    if (!out[ext]) out[ext] = mime;
  }
  const aliases = { jpeg: 'image/jpeg', markdown: 'text/markdown' };
  for (const [ext, mime] of Object.entries(aliases)) {
    if (!out[ext]) out[ext] = mime;
  }
  return out;
})();

export function mimeForExt(ext) {
  return EXT_TO_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * 暂存文件的绝对路径。
 * id 与后缀都要过白名单/形状校验，任一不合法返回 null —— 路径完全由服务端拼，
 * 前端只提供 id + ext，因此不存在把文件写到暂存区之外的可能。
 */
export function stagingPath(attId, ext) {
  if (!isSafeAttId(attId)) return null;
  const e = String(ext || '').toLowerCase();
  if (!ALLOWED_EXTS.has(e)) return null;
  return path.join(DISPATCH_STAGING_DIR, `${attId}.${e}`);
}

/** 按 id 在暂存区里找实际文件（删除 / 预览用，不需要前端提供 ext） */
export async function findStagingFile(attId) {
  if (!isSafeAttId(attId)) return null;
  let names;
  try {
    names = await fsp.readdir(DISPATCH_STAGING_DIR);
  } catch {
    return null; // 目录还不存在 = 没有任何暂存文件
  }
  const hit = names.find(n => n.startsWith(attId + '.'));
  return hit ? path.join(DISPATCH_STAGING_DIR, hit) : null;
}

/**
 * 清理超时的暂存文件（用户粘了图却没派发就关页面 → 不留永久垃圾）。
 * 进程启动时跑一次即可，不必定时器：暂存区的生命周期本来就是"几分钟内派发掉"。
 */
export async function cleanupDispatchStaging(maxAgeMs = 24 * 60 * 60 * 1000) {
  let names;
  try {
    names = await fsp.readdir(DISPATCH_STAGING_DIR);
  } catch {
    return 0; // 目录不存在，没什么可清
  }
  const deadline = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    const full = path.join(DISPATCH_STAGING_DIR, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile() || st.mtimeMs >= deadline) continue;
      await fsp.unlink(full);
      removed++;
    } catch { /* 单个文件出问题不该让整轮清理中断 */ }
  }
  if (removed > 0) {
    try { await fsp.rmdir(DISPATCH_STAGING_DIR); } catch { /* 还有别的文件留在里面，留着目录 */ }
  }
  return removed;
}

/**
 * 认领暂存区里的附件：搬进 `_task-{taskId}/`，产出可直接写进 `task.attachments` 的记录。
 *
 * 两条链路共用它，刻意不各写一份：
 *   1. 派发一条指令（主 Agent 控制台 / 内置智能体的 dispatch_task）—— 见 dispatchInstruction.js；
 *   2. 看板「新建任务」弹窗 —— 任务同样是在附件之后才被建出来的。
 * 各写一份的失效方式很隐蔽：**不报错**，只是其中一条链路建出来的任务把附件弄丢了
 * （与 dispatchInstruction 文件头列的"四处提示词 / 三处路径归一"是同一类坑）。
 *
 * 调用方只回传 `{ id, ext, originalName }`（前端持有草稿记录，服务端在这里**无状态**），
 * 路径完全由服务端拼 —— stagingPath 会同时校验 id 形状与 ext 白名单，
 * 所以不存在"调用方指定任意路径"这回事，比"信任 absolutePath 再校验前缀"干净。
 *
 * 校验是**先全量、后动文件**：一个附件失效时前面几个还没被搬走，
 * 否则暂存区与任务目录会各留一半，谁也说不清哪边是完整的。
 *
 * @param {Array<{id?: string, ext?: string, originalName?: string}>} items
 * @param {string} taskId 必须由服务端生成（genId），本函数直接拿它拼目录名
 * @returns {Promise<Array<object>>} 附件记录；数量不设上限（真正的卡点只有下游读得动读不动）
 */
export async function claimStagedAttachments(items, taskId, now = nowIso()) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const staged = [];
  for (const item of list) {
    const attId = typeof item?.id === 'string' ? item.id : '';
    const ext = typeof item?.ext === 'string' ? item.ext : '';
    const from = stagingPath(attId, ext);
    if (!from) throw new HttpError(400, '附件参数不合法');
    let st = null;
    try { st = await fsp.stat(from); } catch { /* 下面统一报错 */ }
    if (!st || !st.isFile()) throw new HttpError(400, '附件已失效，请重新添加');
    staged.push({
      id: attId,
      ext,
      from,
      size: st.size,
      originalName: String(item?.originalName || `attachment.${ext}`).slice(0, 200),
    });
  }

  const dir = path.join(IMAGES_DIR, '_task-' + taskId);
  await fsp.mkdir(dir, { recursive: true });
  const attachments = [];
  for (const s of staged) {
    const storedName = `${s.id}.${s.ext}`;
    const dest = path.join(dir, storedName);
    try {
      await fsp.rename(s.from, dest);
    } catch {
      // 极端情况（跨卷等）退化成复制 + 删除；仍失败就跳过这个附件，
      // 而不是让整次创建失败 —— 任务本身是好的，不该被一个文件拖死。
      try {
        await fsp.copyFile(s.from, dest);
        await fsp.unlink(s.from);
      } catch { continue; }
    }
    attachments.push({
      id: s.id,
      originalName: s.originalName,
      mimeType: mimeForExt(s.ext),
      size: s.size,
      ext: s.ext,
      storedName,
      absolutePath: dest,
      createdAt: now,
    });
  }
  return attachments;
}
