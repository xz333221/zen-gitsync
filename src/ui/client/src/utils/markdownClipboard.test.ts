import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { prepareHtml, prepareRichText, isSameOriginImageSrc } from './markdownClipboard'

/** jsdom 的 Image 不会真的加载图片；这里让它 decode 即回调，避免降采样分支卡住。 */
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 20
  naturalHeight = 20
  set src(_value: string) { queueMicrotask(() => this.onload?.()) }
}

function makeRoot(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

function stubOkFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markdownClipboard', () => {
  test('isSameOriginImageSrc: 同源 / 根路径 / blob 为真，外部与 data 为假', () => {
    expect(isSameOriginImageSrc('/api/editor/raw?path=x')).toBe(true)
    expect(isSameOriginImageSrc('blob:http://localhost/abc')).toBe(true)
    expect(isSameOriginImageSrc('data:image/png;base64,AAAA')).toBe(false)
    expect(isSameOriginImageSrc('https://cdn.example.com/a.png')).toBe(false)
    expect(isSameOriginImageSrc('')).toBe(false)
  })

  test('prepareHtml 内联同源图片、放行外部与 data:，无残留', async () => {
    stubOkFetch()
    const root = makeRoot(
      '<p>x</p>' +
      '<img src="/api/editor/raw?path=a.png">' +
      '<img src="https://cdn.example.com/b.png">' +
      '<img src="data:image/png;base64,AAAA">'
    )

    const { html, leftover } = await prepareHtml(root, true)

    expect(leftover).toBe(0)
    expect(html).toContain('src="data:image/png;base64,AQID"')
    expect(html).toContain('https://cdn.example.com/b.png')
    expect(html).toContain('data:image/png;base64,AAAA')
    // 源 DOM 不被改动（只在 clone 上操作）
    expect(root.querySelectorAll('img')[0].getAttribute('src')).toBe('/api/editor/raw?path=a.png')
  })

  test('prepareHtml：内联关闭时不发请求，全部保留原地址', async () => {
    const fetchMock = stubOkFetch()
    const root = makeRoot('<img src="/api/editor/raw?path=a.png">')

    const { html, leftover } = await prepareHtml(root, false)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(leftover).toBe(0)
    expect(html).toContain('/api/editor/raw?path=a.png')
  })

  test('prepareHtml：抓图失败时计入 leftover 并保留原地址', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as unknown as Response))
    const root = makeRoot('<img src="/api/editor/raw?path=a.png">')

    const { html, leftover } = await prepareHtml(root, true)

    expect(leftover).toBe(1)
    expect(html).toContain('/api/editor/raw?path=a.png')
  })

  test('prepareRichText 补行内样式并包裹 section（标题转义）', async () => {
    stubOkFetch()
    const root = makeRoot('<h2>标题</h2><p>正文</p>')

    const { html } = await prepareRichText(root, { inline: true, title: 'A <b> & B' })

    expect(html.startsWith('<section style=')).toBe(true)
    expect(html).toContain('A &lt;b&gt; &amp; B')
    expect(html).toMatch(/<h2 style="[^"]*font-weight:700/)
    expect(html).toMatch(/<p style="[^"]*line-height:1\.8/)
  })
})
