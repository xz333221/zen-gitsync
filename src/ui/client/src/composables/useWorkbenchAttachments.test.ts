import { describe, expect, test } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  IMAGE_COMPRESS_THRESHOLD_BYTES,
  replaceExt,
  shouldCompressImage
} from './useWorkbenchAttachments'

// size 是只读 getter，用同名的自有属性盖掉，避免真去分配几 MB 的 buffer
function fakeFile(name: string, type: string, size: number): File {
  const f = new File([new Uint8Array(8)], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

const MB = 1024 * 1024

describe('shouldCompressImage', () => {
  test('阈值以下的图片不压 —— 4K 截图之外的小图没必要重编码', () => {
    expect(shouldCompressImage(fakeFile('a.png', 'image/png', 1 * MB))).toBe(false)
    expect(shouldCompressImage(fakeFile('a.png', 'image/png', IMAGE_COMPRESS_THRESHOLD_BYTES))).toBe(false)
  })

  test('超过阈值的位图要压', () => {
    expect(shouldCompressImage(fakeFile('a.png', 'image/png', 8 * MB))).toBe(true)
    expect(shouldCompressImage(fakeFile('a.jpg', 'image/jpeg', 8 * MB))).toBe(true)
    expect(shouldCompressImage(fakeFile('a.webp', 'image/webp', 8 * MB))).toBe(true)
  })

  test('SVG（矢量）与 GIF（带帧）不压 —— canvas 重编码只会压坏', () => {
    expect(shouldCompressImage(fakeFile('a.svg', 'image/svg+xml', 8 * MB))).toBe(false)
    expect(shouldCompressImage(fakeFile('a.gif', 'image/gif', 8 * MB))).toBe(false)
  })

  test('非图片附件不压', () => {
    expect(shouldCompressImage(fakeFile('a.pdf', 'application/pdf', 8 * MB))).toBe(false)
    expect(shouldCompressImage(fakeFile('a.log', 'text/x-log', 8 * MB))).toBe(false)
  })

  test('没有 mime 时退回看后缀（剪贴板/拖拽偶尔给不出 type）', () => {
    expect(shouldCompressImage(fakeFile('shot.PNG', '', 8 * MB))).toBe(true)
    expect(shouldCompressImage(fakeFile('notes.txt', '', 8 * MB))).toBe(false)
  })

  test('硬上限抬到 20MB，覆盖 4K 截图的常见体积', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * MB)
    expect(MAX_ATTACHMENT_BYTES).toBeGreaterThan(IMAGE_COMPRESS_THRESHOLD_BYTES)
  })
})

describe('replaceExt', () => {
  test('换掉最后一个后缀', () => {
    expect(replaceExt('paste-2026-09-20.png', 'webp')).toBe('paste-2026-09-20.webp')
    expect(replaceExt('shot.tar.gz', 'webp')).toBe('shot.tar.webp')
  })

  test('没有后缀 / 空名字也能兜住', () => {
    expect(replaceExt('screenshot', 'jpg')).toBe('screenshot.jpg')
    expect(replaceExt('', 'jpg')).toBe('attachment.jpg')
  })
})
