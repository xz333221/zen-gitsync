import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  IMAGE_COMPRESS_THRESHOLD_BYTES,
  replaceExt,
  shouldCompressImage,
  useWorkbenchAttachments
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

describe('uploadAttachment 数量不限', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function taskWith(n: number) {
    return {
      id: 't1',
      attachments: Array.from({ length: n }, (_, i) => ({
        id: `a${i}`,
        originalName: `shot-${i}.png`,
        mimeType: 'image/png',
        size: 1000 + i,
        ext: 'png'
      }))
    } as any
  }

  function stubFetchOk() {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return {
        json: async () => ({
          success: true,
          attachment: { id: 'new-1', originalName: 'more.png', mimeType: 'image/png', size: 8, ext: 'png' }
        })
      } as any
    }))
    return urls
  }

  // 曾经按 9 个封顶：一次性交十几张截图是常态，封顶只会逼人分批建任务。
  test('已经挂了 12 个附件时，第 13 个照样能传出去', async () => {
    const urls = stubFetchOk()
    const { uploadAttachment } = useWorkbenchAttachments()
    const task = taskWith(12)

    await uploadAttachment({ kind: 'task', task }, fakeFile('more.png', 'image/png', 8))

    expect(urls).toHaveLength(1)
    expect(task.attachments).toHaveLength(13)
  })

  test('派发前的草稿附件同样不限量', async () => {
    const urls = stubFetchOk()
    const { uploadAttachment } = useWorkbenchAttachments()
    // replace 必须换新数组（真实调用方就是这么写的），
    // 否则 replace 里改同一个引用会把刚 push 进去的那条一起抹掉。
    let list = taskWith(30).attachments

    await uploadAttachment(
      { kind: 'draft', list, replace: (next) => { list = next } },
      fakeFile('more.png', 'image/png', 8)
    )

    expect(urls[0]).toContain('/api/workbench/orchestrator/attachments')
    expect(list).toHaveLength(31)
  })

  test('取消数量上限不等于取消其它卡点：白名单与大小仍然拦得住', async () => {
    const urls = stubFetchOk()
    const { uploadAttachment } = useWorkbenchAttachments()
    const task = taskWith(12)

    await uploadAttachment({ kind: 'task', task }, fakeFile('evil.exe', '', 8))
    await uploadAttachment({ kind: 'task', task }, fakeFile('huge.png', 'image/png', MAX_ATTACHMENT_BYTES + 1))

    expect(urls).toHaveLength(0)
    expect(task.attachments).toHaveLength(12)
  })
})
