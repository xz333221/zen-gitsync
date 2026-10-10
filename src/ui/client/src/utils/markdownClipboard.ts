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
 * Markdown 预览 → 剪贴板
 *
 * 把"文件空间里渲染出来的预览 DOM"整理成可以直接粘到公众号编辑器 /
 * 其它富文本编辑器的产物：
 * - 本地图片（`/api/editor/raw?...` 这类同源地址）转成 Base64 内嵌，
 *   否则外部平台拿不到本机图，粘过去就是裂图。
 * - 富文本分支额外补一套**行内样式** —— 公众号会丢掉 `<style>`，
 *   flowdash-md-preview 那套类名样式在那边一律失效。
 *
 * 只影响复制产物：磁盘上的原图和预览里的显示都不动。
 */

/** 内嵌前把超宽图降到这个宽度（公众号正文图有宽度上限，也避免剪贴板过大）。 */
const INLINE_MAX_WIDTH = 1080
/** base64 字符数超过这个量就重编码（字符数 ≈ 字节 × 1.37）。 */
const INLINE_MAX_CHARS = 600_000
const INLINE_JPEG_QUALITY = 0.86

/** 判断一张图的 src 是否是"我们能 fetch 到、需要内嵌"的同源图。 */
export function isSameOriginImageSrc(src: string): boolean {
  if (!src) return false
  if (src.startsWith('data:')) return false
  if (src.startsWith('blob:')) return true
  if (src.startsWith('/')) return true
  try {
    return new URL(src, location.href).origin === location.origin
  } catch {
    return false
  }
}

/** 取图 → data URI；失败返回 null。 */
export async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise<string>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve((reader.result as string) || '')
      reader.onerror = () => resolve('')
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * 按需降采样 + 转 JPEG；任何一步失败都退回原图，绝不因为"瘦身"把图弄丢。
 * 图片迟迟不解码时也会退回原图，避免整个复制流程卡住。
 */
export function shrinkDataUrlIfNeeded(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    if (typeof Image === 'undefined') { done(dataUrl); return }
    const img = new Image()
    const timer = setTimeout(() => done(dataUrl), 4000)
    img.onload = () => {
      clearTimeout(timer)
      const needsShrink =
        img.naturalWidth > INLINE_MAX_WIDTH || dataUrl.length > INLINE_MAX_CHARS
      if (!needsShrink) { done(dataUrl); return }
      try {
        const scale = Math.min(1, INLINE_MAX_WIDTH / img.naturalWidth)
        const width = Math.max(1, Math.round(img.naturalWidth * scale))
        const height = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        if (!ctx) { done(dataUrl); return }
        // 先铺白底再画：原图带透明通道时，直接转 JPEG 会把透明区变黑。
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        done(canvas.toDataURL('image/jpeg', INLINE_JPEG_QUALITY))
      } catch {
        done(dataUrl)
      }
    }
    img.onerror = () => { clearTimeout(timer); done(dataUrl) }
    img.src = dataUrl
  })
}

async function fetchAsInlineDataUrl(url: string): Promise<string | null> {
  const original = await fetchAsDataUrl(url)
  if (!original) return null
  return shrinkDataUrlIfNeeded(original)
}

/**
 * 就地把 DOM 里同源图片的 src 换成 Base64，返回**没能内嵌**的图片数量
 * （调用方据此给出可见告警 —— 静默失败是这类功能最容易藏 bug 的地方）。
 */
export async function inlineSameOriginImages(root: HTMLElement): Promise<number> {
  const images = Array.from(root.querySelectorAll('img'))
    .filter((img) => isSameOriginImageSrc(img.getAttribute('src') || ''))
  let leftover = 0
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute('src') || ''
      const dataUrl = await fetchAsInlineDataUrl(src)
      if (dataUrl) img.setAttribute('src', dataUrl)
      else leftover += 1
    })
  )
  return leftover
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 标签 → 公众号友好的行内样式。仅用于"复制富文本"，不影响预览。 */
const RICH_TEXT_STYLE_BY_TAG: Record<string, string> = {
  h1: 'font-size:26px;font-weight:700;line-height:1.35;margin:28px 0 16px;color:#111;',
  h2: 'font-size:22px;font-weight:700;line-height:1.4;margin:26px 0 14px;color:#111;',
  h3: 'font-size:19px;font-weight:700;line-height:1.45;margin:22px 0 12px;color:#222;',
  h4: 'font-size:17px;font-weight:600;line-height:1.5;margin:20px 0 10px;color:#333;',
  h5: 'font-size:16px;font-weight:600;line-height:1.5;margin:18px 0 8px;color:#333;',
  h6: 'font-size:15px;font-weight:600;line-height:1.5;margin:18px 0 8px;color:#555;',
  p: 'font-size:16px;line-height:1.8;margin:16px 0;color:#333;',
  li: 'font-size:16px;line-height:1.8;margin:0 0 6px;color:#333;',
  ul: 'margin:16px 0;padding-left:24px;',
  ol: 'margin:16px 0;padding-left:24px;',
  blockquote: 'margin:16px 0;padding:8px 16px;border-left:4px solid #e2e2e2;background:#f7f7f7;color:#666;font-size:15px;line-height:1.8;',
  hr: 'border:none;border-top:1px solid #e5e5e5;margin:26px 0;',
  a: 'color:#576b95;text-decoration:none;',
  strong: 'font-weight:700;color:#111;',
  em: 'font-style:italic;color:#555;',
  code: 'font-family:Menlo,Consolas,Monaco,monospace;font-size:0.92em;background:#f2f3f5;color:#c7254e;padding:1px 5px;border-radius:3px;',
  pre: 'font-family:Menlo,Consolas,Monaco,monospace;font-size:13px;line-height:1.6;background:#f6f8fa;color:#24292f;padding:12px 14px;border-radius:6px;overflow-x:auto;margin:16px 0;',
  table: 'border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;',
  th: 'border:1px solid #e0e0e0;padding:8px 10px;background:#f6f8fa;font-weight:600;text-align:left;color:#333;',
  td: 'border:1px solid #e0e0e0;padding:8px 10px;color:#333;',
  img: 'max-width:100%;height:auto;display:block;margin:16px auto;border-radius:6px;',
}

function applyRichTextStyles(root: HTMLElement): void {
  root.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase()
    const style = RICH_TEXT_STYLE_BY_TAG[tag]
    if (style) el.setAttribute('style', style)
  })
  // pre 里的 code 不要再套一层浅色底，否则代码块变成补丁状。
  root.querySelectorAll('pre code').forEach((el) => el.setAttribute('style', 'background:none;padding:0;color:inherit;font-size:inherit;'))
}

export interface PreparedClipboard {
  /** 整理后的 HTML（图片已按需内嵌） */
  html: string
  /** 未能内嵌的本地图片数量 */
  leftover: number
}

/** 克隆预览 DOM → 内联同源图片 → 返回 HTML 片段（无额外样式）。 */
export async function prepareHtml(root: HTMLElement, inline: boolean): Promise<PreparedClipboard> {
  const clone = root.cloneNode(true) as HTMLElement
  const leftover = inline ? await inlineSameOriginImages(clone) : 0
  return { html: clone.innerHTML, leftover }
}

/**
 * 克隆预览 DOM → 内联同源图片 → 补行内样式 → 包一层 `<section>`。
 * 这就是「复制富文本」（粘到公众号编辑器）的产物。
 */
export async function prepareRichText(
  root: HTMLElement,
  opts: { inline: boolean; title?: string }
): Promise<PreparedClipboard> {
  const clone = root.cloneNode(true) as HTMLElement
  const leftover = opts.inline ? await inlineSameOriginImages(clone) : 0
  applyRichTextStyles(clone)
  const title = (opts.title || '').trim()
  const titleHtml = title
    ? `<h1 style="font-size:26px;font-weight:700;line-height:1.35;margin:0 0 22px;color:#111;">${escapeHtml(title)}</h1>`
    : ''
  const html =
    `<section style="font-size:16px;line-height:1.8;color:#333;word-break:break-word;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;">` +
    `${titleHtml}${clone.innerHTML}</section>`
  return { html, leftover }
}
