import { ref } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Attachment, Task, SubTask } from '@/types/workbench'

export const ALLOWED_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
  'image/bmp', 'image/svg+xml',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/csv',
  'application/json', 'text/json', 'text/x-log'
])
export const ALLOWED_EXT_HINT = '.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf,.txt,.md,.csv,.json,.log'
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export type AttachmentTarget =
  | { kind: 'task'; task: Task | null }
  | { kind: 'sub'; task: Task | null; sub: SubTask }

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
    return t.kind === 'task' ? `task-${t.task?.id ?? ''}` : `sub-${t.sub.id}`
  }
  function targetAttachments(t: AttachmentTarget): Attachment[] {
    const arr = t.kind === 'task' ? t.task?.attachments : t.sub.attachments
    return Array.isArray(arr) ? (arr as Attachment[]) : []
  }
  function setTargetAttachments(t: AttachmentTarget, att: Attachment[]) {
    if (t.kind === 'task') { if (t.task) t.task.attachments = att }
    else t.sub.attachments = att
  }
  function targetUploadUrl(t: AttachmentTarget): string {
    return t.kind === 'task'
      ? `/api/workbench/tasks/${t.task?.id ?? ''}/attachments`
      : `/api/workbench/subtasks/${t.sub.id}/attachments`
  }
  function targetDeleteUrl(t: AttachmentTarget, attId: string): string {
    return t.kind === 'task'
      ? `/api/workbench/tasks/${t.task?.id ?? ''}/attachments/${attId}`
      : `/api/workbench/subtasks/${t.sub.id}/attachments/${attId}`
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
    if (file.size > MAX_ATTACHMENT_BYTES) {
      ElMessage.error(`「${file.name}」${$t('@WORKBENCH:超过 5MB 限制')}`)
      return
    }
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
      const res = await fetch(targetUploadUrl(t), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Original-Name': file.name,
          'X-Mime-Type': file.type || 'application/octet-stream'
        },
        body: file
      }).then(r => r.json())
      if (res.success) {
        const list = targetAttachments(t)
        list.push(res.attachment)
        setTargetAttachments(t, list)
        ElMessage.success(`${$t('@WORKBENCH:已添加：')}${file.name}`)
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
