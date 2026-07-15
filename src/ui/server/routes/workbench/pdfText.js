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
// PDF 文本预提取工具。
//
// Claude CLI (claude.exe v2.1.x) 在解析 PDF 时内部 pdfParse 函数不可用,
// 报错 "pdfParse is not a function"。本模块在服务端用 pdf-parse 库
// 预提取 PDF 文本,将提取出的内容直接拼入 prompt,绕过 Claude CLI
// 的 PDF 解析 bug。
//
// 核心 API:
//   - extractPdfText(filePath)  读取 PDF 文件并返回纯文本,失败返回 null
//   - isPdfAttachment(att)      判断附件是否为 PDF
//   - buildAttachmentBlock(attachments)  构建附件文本块,PDF 自动预提取

import fs from 'fs';
import { isImageExt } from './attachmentUtils.js';

// 最大提取字符数(避免超大 PDF 把 prompt 撑爆)
const MAX_PDF_TEXT_CHARS = 80_000;

/**
 * 判断附件是否为 PDF
 * @param {{ext?: string, mimeType?: string}} att
 * @returns {boolean}
 */
export function isPdfAttachment(att) {
  if (!att) return false;
  const ext = String(att.ext || '').toLowerCase();
  const mime = String(att.mimeType || '').toLowerCase();
  return ext === 'pdf' || mime === 'application/pdf';
}

/**
 * 从 PDF 文件中提取纯文本。
 * 使用 pdf-parse 库(node 端),失败时返回 null。
 *
 * @param {string} filePath  PDF 文件的绝对路径
 * @returns {Promise<string|null>}  提取的文本(可能截断),失败返回 null
 */
export async function extractPdfText(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    // 动态 import 避免在非 PDF 场景加载 pdfjs
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();
    const text = result?.text || '';
    if (!text.trim()) return null;
    // 截断超长文本
    if (text.length > MAX_PDF_TEXT_CHARS) {
      return text.slice(0, MAX_PDF_TEXT_CHARS) + '\n\n[... 文档过长,已截断 ...]';
    }
    return text;
  } catch (err) {
    // 常见失败:加密 PDF / 扫描版 PDF(无可提取文本) / 损坏文件
    console.error('[pdfText] PDF 解析失败:', err?.message || String(err));
    return null;
  }
}

/**
 * 构建附件信息块。
 * - 图片:列路径(Claude CLI 可直接读取)
 * - PDF:预提取文本并内联,不列路径(绕过 Claude CLI 的 pdfParse bug)
 * - 其他:列路径
 *
 * @param {Array<{absolutePath?: string, ext?: string, mimeType?: string}>} attachments
 * @param {object} [opts]
 * @param {boolean} [opts.withImageData=false]  是否读取图片为 data URL(预览/拆分场景需要)
 * @returns {Promise<{ block: string, imageDataUrls: string[] }>}
 */
export async function buildAttachmentBlock(attachments, opts) {
  const withImages = opts?.withImageData ?? false;
  const imageDataUrls = [];
  if (!attachments || attachments.length === 0) {
    return { block: '', imageDataUrls };
  }

  const lines = [];
  let pdfCount = 0;
  let pdfFailedCount = 0;

  for (let i = 0; i < attachments.length; i++) {
    const a = attachments[i];
    if (!a || !a.absolutePath) continue;

    if (isPdfAttachment(a)) {
      // PDF:预提取文本,不把路径交给 Claude CLI
      const text = await extractPdfText(a.absolutePath);
      if (text) {
        pdfCount++;
        lines.push(`  ${i + 1}. [PDF 全文提取] ${a.absolutePath}`);
        lines.push(`     <pdf_content>\n${text}\n     </pdf_content>`);
      } else {
        pdfFailedCount++;
        lines.push(`  ${i + 1}. [PDF 解析失败] ${a.absolutePath}（可能是扫描版/加密/损坏,请尝试用其他工具转换为文本后重新上传）`);
      }
    } else if (isImageExt(a.ext)) {
      // 图片:列路径,可选读 data URL
      lines.push(`  ${i + 1}. [${a.mimeType || 'image'}] ${a.absolutePath}`);
      if (withImages) {
        try {
          const buf = fs.readFileSync(a.absolutePath);
          const mime = a.mimeType || 'image/png';
          imageDataUrls.push(`data:${mime};base64,${buf.toString('base64')}`);
        } catch { /* 文件丢失就跳过 */ }
      }
    } else {
      // 其他文件:列路径
      lines.push(`  ${i + 1}. [${a.mimeType || 'application/octet-stream'}] ${a.absolutePath}`);
    }
  }

  if (lines.length === 0) {
    return { block: '', imageDataUrls };
  }

  const parts = [];
  if (pdfCount > 0) {
    parts.push(`其中 ${pdfCount} 个 PDF 已预提取全文`);
  }
  if (pdfFailedCount > 0) {
    parts.push(`${pdfFailedCount} 个 PDF 解析失败`);
  }
  const imgNote = withImages && imageDataUrls.length > 0
    ? `（其中 ${imageDataUrls.length} 张图片已随消息一并发送，请直接基于图片内容分析）`
    : '';
  const note = parts.length > 0 ? `（${parts.join('，')}）` : imgNote;

  const block = `\n\n## 任务附件${note}\n${lines.join('\n')}`;
  return { block, imageDataUrls };
}
