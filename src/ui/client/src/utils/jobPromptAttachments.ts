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
// 执行记录（job）→ 这一轮用户气泡上该展示的附件。
//
// `job.prompt` 末尾挂着一段「任务附件清单」（服务端 taskRunner.js 拼、pdfText.js
// 生成），每一轮 spawn 时冻结 —— 气泡文本（userFacingPrompt）把它剥掉了，但用户
// 希望附件别只躺在任务详情顶部的附件条里，提问的气泡上也要看得见（2026-11-25）。
//
// 这里把那段清单从 prompt 里解析回来。纯展示层函数：不改写任何落盘数据，
// 老 job 同样适用（附件清单自附件功能上线起就在 prompt 里，新旧两种行格式都认）。
// id / 大小不在清单里 —— 拿 absolutePath 去**任务当前**的 attachments 里认领；
// 认领到且是图片的，用 /api/workbench/attachments/:id/raw 当缩略图（与
// AttachmentZone / 看板封面同一个端点）。认领不到就只出文件名 chip
// （任务后来删过这张附件，或调用方没带任务上下文），不猜、不造端点。

import type { Attachment } from '@/types/workbench'

export interface JobMessageAttachment {
  /** 任务 attachments 里的记录 id；老 job / 附件已被删时没有（不设缩略图） */
  id?: string
  name: string
  mimeType: string
  size?: number
  absolutePath: string
  /** 图片缩略图端点（认领到 id 且是图片才有；否则库按文件 chip 渲染） */
  previewUrl?: string
}

/**
 * 附件清单尾块的锚点。必须与 taskRunner 拼 prompt 的写法对齐：
 *   `\n\n---\n本任务包含 N 个附件（请按文件路径读取，不要让用户重新提供）：${block}\n---`
 * 尾块一定是 prompt 的最后一段（`续接 #N` 在它前面），所以用 `$` 锚到结尾。
 * 旧版格式没有末尾的 `\n---`，这里一并在 body 里剥。
 */
const TAIL_RE = /\n\n---\n本任务包含 \d+ 个附件（请按文件路径读取[^\n]*）：\n?([\s\S]*)$/

/**
 * 清单里的一条。新格式带序号缩进（`  1. [image/png] C:\a.png`），
 * 旧格式不带（`[image/png] C:\a.png`），序号与缩进都做成可选。
 */
const ENTRY_RE = /^\s*(?:\d+\.\s*)?\[([^\]]+)\]\s*(.+)$/

/** PDF / 图片描述的内联文本块占位（pdfText.js），整块跳过 —— 里面是文档正文，不是清单 */
const INLINE_BLOCK_OPEN = /<(?:pdf_content|image_description)>/
const INLINE_BLOCK_CLOSE = /<\/(?:pdf_content|image_description)>/

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

function extOf(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/)
  return m ? m[1] : ''
}

function basename(p: string): string {
  const base = p.split(/[\\/]/).pop() || p
  return base
}

/**
 * 解析 `job.prompt` 末尾的附件清单。
 *
 * @param prompt           job.prompt 原文（发给 CLI 的那一整段）
 * @param taskAttachments  任务**当前**的附件记录（可选）。清单里只有路径没有 id，
 *                         拿路径到这里认领 id / 原始文件名 / 大小 —— 认领不到就
 *                         退回清单里自带的 mime 与路径末段当文件名。
 */
export function jobMessageAttachments(
  prompt: string | undefined,
  taskAttachments?: Attachment[]
): JobMessageAttachment[] {
  const text = typeof prompt === 'string' ? prompt : ''
  if (!text) return []
  const m = text.match(TAIL_RE)
  if (!m) return []
  const body = m[1].replace(/\n---\s*$/, '')

  // 认领表：原样 + 小写各放一份（Windows 盘符大小写在历史记录里漂过）
  const byPath = new Map<string, Attachment>()
  for (const a of Array.isArray(taskAttachments) ? taskAttachments : []) {
    if (a?.absolutePath) {
      byPath.set(a.absolutePath, a)
      byPath.set(a.absolutePath.toLowerCase(), a)
    }
  }

  const out: JobMessageAttachment[] = []
  const seen = new Set<string>()
  let inInlineBlock = false
  for (const line of body.split('\n')) {
    if (INLINE_BLOCK_OPEN.test(line)) { inInlineBlock = true; continue }
    if (INLINE_BLOCK_CLOSE.test(line)) { inInlineBlock = false; continue }
    if (inInlineBlock) continue
    const em = line.match(ENTRY_RE)
    if (!em) continue
    let mime = em[1].trim()
    let p = em[2].trim()
    // PDF 两条特殊行：[PDF 全文提取] / [PDF 解析失败]（后者路径后面还挂着中文说明括号）
    if (/^PDF\b/.test(mime)) mime = 'application/pdf'
    p = p.replace(/（[^）]*）$/, '')
    if (!p) continue
    // 同一轮清单里路径本身已去重（taskRunner 按 absolutePath 去过）；这里兜一层防旧格式重复
    const dedupeKey = p.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const rec = byPath.get(p) ?? byPath.get(dedupeKey)
    const ext = extOf(p)
    const isImage = mime.startsWith('image/') || IMAGE_EXTS.has(ext)
    out.push({
      id: rec?.id,
      name: rec?.originalName || basename(p),
      mimeType: rec?.mimeType || mime,
      size: rec?.size,
      absolutePath: p,
      previewUrl: isImage && rec?.id
        ? `/api/workbench/attachments/${encodeURIComponent(rec.id)}/raw`
        : undefined
    })
  }
  return out
}

/** 映射成 zen-ai-chat-ui 的 ChatAttachment 形状（两个对话视图共用，免得两处显示得不一样） */
export function toChatAttachments(atts: JobMessageAttachment[]) {
  return atts.map(a => ({
    id: a.id ?? a.absolutePath,
    name: a.name,
    size: a.size ?? 0,
    type: a.mimeType,
    preview: a.previewUrl
  }))
}

/**
 * 从某一轮的 prompt 尾块还原出**任务附件库里的原记录**（重试那一轮时原样重带）。
 * 只认领得到 id 的条目 —— 附件已从任务上删掉的（认领不到）不造假记录，
 * 服务端重建尾块拿不到真实路径，重试就只重发文字。
 */
export function jobMessageAttachmentRecords(
  prompt: string | undefined,
  taskAttachments?: Attachment[]
): Attachment[] {
  const byId = new Map(
    (Array.isArray(taskAttachments) ? taskAttachments : [])
      .filter(r => r?.id)
      .map(r => [r.id as string, r])
  )
  const out: Attachment[] = []
  for (const a of jobMessageAttachments(prompt, taskAttachments)) {
    if (!a.id) continue
    const rec = byId.get(a.id)
    if (rec && !out.includes(rec)) out.push(rec)
  }
  return out
}
