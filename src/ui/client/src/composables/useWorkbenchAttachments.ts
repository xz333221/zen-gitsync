import { ref } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Attachment, Task } from '@/types/workbench'

export const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv',
  'application/json', 'text/json', 'text/x-log'
])
export const ALLOWED_EXT_HINT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf,.txt,.md,.csv,.json,.log'
// 单个附件硬上限。原来是 5MB，4K 屏随手一张截图（3840px，PNG 5–15MB）就顶掉，
// 所以抬到 20MB：非图片附件（PDF / 日志 / JSON）本来就该按需给大，
// 图片则由下面的压缩逻辑保证真正落到下游时不会超限。
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * 图片超过这个体积就先压一刀再上传。
 *
 * 为什么不只把上限拉到 20MB 就完事：附件最终要么被下游按路径读取
 * （Claude Code 的 Read / 模型多模态接口），要么被 base64 塞进请求体，
 * 这两条路都在 5MB（base64 之后）附近把大图挡下来 —— 上传时不压，
 * 故障只是从"上传失败"推迟成更难排查的"读图失败 / 模型 400"。
 */
export const IMAGE_COMPRESS_THRESHOLD_BYTES = 3.5 * 1024 * 1024
/** 首轮压缩保留原分辨率（4K 截图不降采样），只换更省的编码；压不下去才逐级降采样 */
export const IMAGE_COMPRESS_MAX_EDGE = 3840
/** canvas 能重编码的位图格式。SVG 是矢量、GIF 带帧，都不走压缩 */
const COMPRESSIBLE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp'])

/** 是否需要压缩：可重编码的位图 + 超过阈值（剪贴板/拖拽的文件偶尔没 mime，退回看后缀） */
export function shouldCompressImage(file: File): boolean {
  if (file.size <= IMAGE_COMPRESS_THRESHOLD_BYTES) return false
  const mime = String(file.type || '').toLowerCase()
  if (mime) return COMPRESSIBLE_MIME.has(mime)
  return /\.(png|jpe?g|webp|bmp)$/i.test(file.name)
}

/** 换后缀（`paste-x.png` + `webp` → `paste-x.webp`），给压缩后的文件改名用 */
export function replaceExt(name: string, ext: string): string {
  const base = String(name || 'attachment').replace(/\.[^./\\]+$/, '')
  return `${base}.${ext}`
}

/** Blob → 可画的位图。createImageBitmap 失败（部分浏览器对超大图有限制）退回 <img> 解码 */
async function decodeImage(file: File): Promise<{
  source: CanvasImageSource; width: number; height: number; release: () => void
} | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file)
      return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() }
    } catch { /* 落到 <img> 分支 */ }
  }
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url)
    })
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(b => resolve(b && b.type === type ? b : null), type, quality)
    } catch { resolve(null) }
  })
}

/**
 * 大图上传前压缩。
 *
 * 策略：先按原分辨率换 WebP（q0.95，4K 截图基本一步到位且不掉分辨率），不行再依次
 * 降质量 / 降最长边，最后一档是 1920px q0.8 —— 目标仅仅是"能被下游读进去"，
 * 而不是追求最漂亮。任何一步失败（浏览器不支持 canvas 编码 / 解不开 / 压完反而更大）
 * 都返回 null，由调用方原样上传，再由 MAX_ATTACHMENT_BYTES 兜底。
 */
export async function compressImage(file: File): Promise<{ blob: Blob; ext: string } | null> {
  const decoded = await decodeImage(file)
  if (!decoded) return null
  try {
    const plans = [
      { edge: IMAGE_COMPRESS_MAX_EDGE, quality: 0.95 },
      { edge: IMAGE_COMPRESS_MAX_EDGE, quality: 0.85 },
      { edge: 2560, quality: 0.85 },
      { edge: 1920, quality: 0.8 }
    ]
    let best: Blob | null = null
    for (const plan of plans) {
      const scale = Math.min(1, plan.edge / Math.max(decoded.width, decoded.height))
      const w = Math.max(1, Math.round(decoded.width * scale))
      const h = Math.max(1, Math.round(decoded.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(decoded.source, 0, 0, w, h)
      const out = (await canvasToBlob(canvas, 'image/webp', plan.quality))
        || (await canvasToBlob(canvas, 'image/jpeg', plan.quality))
      if (!out) return null   // canvas 编码不可用，别拿半成品糊弄用户
      if (!best || out.size < best.size) best = out
      if (out.size <= IMAGE_COMPRESS_THRESHOLD_BYTES) break
    }
    if (!best || best.size >= file.size) return null
    return { blob: best, ext: best.type === 'image/webp' ? 'webp' : 'jpg' }
  } catch {
    return null
  } finally {
    decoded.release()
  }
}

export type AttachmentTarget =
  | { kind: 'task'; task: Task | null }
  /**
   * 派发前的草稿附件 —— 主 Agent 控制台用。
   * 这一刻任务还不存在，没有 task/sub 可挂，所以附件先落在服务端的暂存区
   * （`~/.zen-gitsync/workbench-images/_dispatch/`），派发成功才搬进任务目录。
   * `replace` 必须换成新数组：`uploadAttachment` 是先 push 再回写，
   * 若 replace 里赋值同一个引用，Vue 收不到变更、缩略图不会出现。
   */
  | { kind: 'draft'; list: Attachment[]; replace: (next: Attachment[]) => void }

export function useWorkbenchAttachments() {
  const uploadingTargets = ref<Record<string, boolean>>({})
  const pasteHoverId = ref<string | null>(null)

  function isUploading(id: string): boolean { return !!uploadingTargets.value[id] }

  function ensureFile(blob: Blob, fallbackName: string): File {
    if (blob instanceof File) return blob
    const mime = blob.type || 'application/octet-stream'
    return new File([blob], fallbackName, { type: mime })
  }

  function targetKey(t: AttachmentTarget): string {
    return t.kind === 'draft' ? 'draft' : `task-${t.task?.id ?? ''}`
  }
  function targetAttachments(t: AttachmentTarget): Attachment[] {
    if (t.kind === 'draft') return t.list
    const arr = t.task?.attachments
    return Array.isArray(arr) ? (arr as Attachment[]) : []
  }
  function setTargetAttachments(t: AttachmentTarget, att: Attachment[]) {
    if (t.kind === 'draft') { t.replace(att); return }
    if (t.task) t.task.attachments = att
  }
  function targetUploadUrl(t: AttachmentTarget): string {
    if (t.kind === 'draft') return '/api/workbench/orchestrator/attachments'
    return `/api/workbench/tasks/${t.task?.id ?? ''}/attachments`
  }
  function targetDeleteUrl(t: AttachmentTarget, attId: string): string {
    if (t.kind === 'draft') return `/api/workbench/orchestrator/attachments/${attId}`
    return `/api/workbench/tasks/${t.task?.id ?? ''}/attachments/${attId}`
  }

  function onAttachmentPaste(e: ClipboardEvent, t: AttachmentTarget) {
    if (!e.clipboardData) return
    const imageItems = Array.from(e.clipboardData.items).filter(
      it => it.kind === 'file' && it.type.startsWith('image/')
    )
    if (imageItems.length > 0) {
      e.preventDefault()
      for (const it of imageItems) {
        const blob = it.getAsFile()
        if (!blob) continue
        const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        uploadAttachment(t, ensureFile(blob, `paste-${stamp}.${ext}`))
      }
      return
    }
    const fileItems = Array.from(e.clipboardData.items).filter(
      it => it.kind === 'file' && !it.type.startsWith('image/')
    )
    if (fileItems.length > 0) {
      e.preventDefault()
      for (const it of fileItems) {
        const blob = it.getAsFile()
        if (!blob) continue
        uploadAttachment(t, ensureFile(blob, blob.name || 'pasted-file'))
      }
    }
  }

  function onAttachmentDrop(e: DragEvent, t: AttachmentTarget) {
    pasteHoverId.value = null
    const files = Array.from(e.dataTransfer?.files || [])
    files.forEach(f => uploadAttachment(t, f))
  }

  async function uploadAttachment(t: AttachmentTarget, file: File) {
    if (!ALLOWED_MIME.has(file.type) && !file.name.match(/\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|txt|md|markdown|csv|json|log)$/i)) {
      ElMessage.error(`${$t('@WORKBENCH:不支持的文件类型')}（${file.name}）`)
      return
    }
    const existing = targetAttachments(t)
    if (existing.length >= 9) {
      ElMessage.error($t('@WORKBENCH:单个任务最多 9 个附件'))
      return
    }
    const dup = existing.find(a => a.originalName === file.name && a.size === file.size)
    if (dup) {
      ElMessage.info(`${file.name} ${$t('@WORKBENCH:已存在，已复用')}`)
      return
    }
    const key = targetKey(t)
    uploadingTargets.value[key] = true
    try {
      // 大图先压再传：上限虽已放到 20MB，但下游（Claude Code 读图 / 模型 base64 多模态）
      // 只认 5MB 上下，上传前是唯一能同时满足两头的卡点。压不动就原样传，由大小上限兜底。
      let out = file
      if (shouldCompressImage(file)) {
        const packed = await compressImage(file)
        if (packed) {
          out = ensureFile(packed.blob, replaceExt(file.name, packed.ext))
          ElMessage.info($t('@WORKBENCH:图片过大，已压缩后上传：{from} → {to}', {
            from: humanSize(file.size),
            to: humanSize(out.size)
          }))
        }
      }
      if (out.size > MAX_ATTACHMENT_BYTES) {
        ElMessage.error(`「${file.name}」${$t('@WORKBENCH:超过 {size} 限制', { size: humanSize(MAX_ATTACHMENT_BYTES) })}`)
        return
      }
      const res = await fetch(targetUploadUrl(t), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Original-Name': out.name,
          'X-Mime-Type': out.type || 'application/octet-stream'
        },
        body: out
      }).then(r => r.json())
      if (res.success) {
        const list = targetAttachments(t)
        list.push(res.attachment)
        setTargetAttachments(t, list)
        ElMessage.success(`${$t('@WORKBENCH:已添加：')}${out.name}`)
      } else {
        ElMessage.error(res.error || $t('@WORKBENCH:上传失败'))
      }
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:上传失败') + '：' + (err && err.message || err))
    } finally {
      uploadingTargets.value[key] = false
    }
  }

  async function removeAttachment(t: AttachmentTarget, att: Attachment) {
    try {
      await ElMessageBox.confirm(
        $t('@WORKBENCH:删除附件「{name}」？', { name: att.originalName }),
        $t('@WORKBENCH:确认'),
        { type: 'warning' }
      )
    } catch { return }
    const res = await fetch(targetDeleteUrl(t, att.id), { method: 'DELETE' }).then(r => r.json())
    if (res.success) {
      const list = targetAttachments(t).filter(a => a.id !== att.id)
      setTargetAttachments(t, list)
      ElMessage.success($t('@WORKBENCH:已删除'))
    } else {
      ElMessage.error(res.error || $t('@WORKBENCH:删除失败'))
    }
  }

  function pickAttachmentFile(t: AttachmentTarget) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ALLOWED_EXT_HINT
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files || [])
      files.forEach(f => uploadAttachment(t, f))
    }
    input.click()
  }

  const IMAGE_EXTS_UI = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])
  function isImageAttachment(att: Attachment): boolean {
    const ext = String(att?.ext || '').toLowerCase()
    if (ext && IMAGE_EXTS_UI.has(ext)) return true
    const mime = String(att?.mimeType || '').toLowerCase()
    if (mime.startsWith('image/')) return true
    const name = String(att?.originalName || '').toLowerCase()
    return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)
  }

  function humanSize(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(2)} MB`
  }

  return {
    uploadingTargets,
    pasteHoverId,
    isUploading,
    ensureFile,
    isImageAttachment,
    humanSize,
    targetKey,
    targetAttachments,
    setTargetAttachments,
    targetUploadUrl,
    targetDeleteUrl,
    onAttachmentPaste,
    onAttachmentDrop,
    uploadAttachment,
    removeAttachment,
    pickAttachmentFile
  }
}
