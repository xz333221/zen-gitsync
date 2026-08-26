import { describe, it, expect } from 'vitest'
import { PREVIEW_IFRAME_SANDBOX, injectHtmlPreviewShims } from './previewSandbox'

/**
 * 覆盖点: sandbox 标志包含 allow-scripts(交互可用)且不含 allow-same-origin(隔离宿主);
 * shim 注入位置优先级 charset → head → html → doctype → 前置; 空内容直通。
 */

describe('PREVIEW_IFRAME_SANDBOX', () => {
  it('允许脚本执行且不允许同源(不透明 origin 隔离宿主)', () => {
    expect(PREVIEW_IFRAME_SANDBOX).toContain('allow-scripts')
    expect(PREVIEW_IFRAME_SANDBOX).not.toContain('allow-same-origin')
  })
})

describe('injectHtmlPreviewShims', () => {
  it('优先注入到 <meta charset> 之后', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>t</title></head><body></body></html>'
    const out = injectHtmlPreviewShims(html)
    const metaEnd = html.indexOf('<meta charset="UTF-8">') + '<meta charset="UTF-8">'.length
    expect(out.slice(metaEnd, metaEnd + '<script>'.length)).toBe('<script>')
    expect(out).toContain('</script>')
  })

  it('无 charset 时注入到 <head> 开标签之后', () => {
    const html = '<html><head><title>t</title></head><body></body></html>'
    const out = injectHtmlPreviewShims(html)
    const headEnd = html.indexOf('<head>') + '<head>'.length
    expect(out.slice(headEnd, headEnd + '<script>'.length)).toBe('<script>')
  })

  it('无 head 时注入到 <html> 开标签之后', () => {
    const html = '<html><body>hi</body></html>'
    const out = injectHtmlPreviewShims(html)
    const htmlEnd = html.indexOf('<html>') + '<html>'.length
    expect(out.slice(htmlEnd, htmlEnd + '<script>'.length)).toBe('<script>')
  })

  it('裸片段(无任何标签)直接前置且不破坏原内容', () => {
    const out = injectHtmlPreviewShims('<div>hi</div>')
    expect(out.startsWith('<script>')).toBe(true)
    expect(out.endsWith('<div>hi</div>')).toBe(true)
  })

  it('空字符串原样返回', () => {
    expect(injectHtmlPreviewShims('')).toBe('')
  })

  it('shim 自身的 </script> 已转义, 不会截断宿主 HTML 结构', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>x</p></body></html>'
    const out = injectHtmlPreviewShims(html)
    // 注入段内不允许出现未转义的闭合标签导致的提前截断: 整体仍应包含原始 <p>x</p>
    expect(out).toContain('<p>x</p>')
    // 注入脚本只出现一次闭合标签
    expect(out.split('</script>').length - 1).toBe(1)
  })
})
