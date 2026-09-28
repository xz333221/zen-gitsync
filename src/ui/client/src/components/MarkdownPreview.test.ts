import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownPreview from './MarkdownPreview.vue'

function mountPreview(content: string, allowHtml?: boolean) {
  return mount(MarkdownPreview, {
    props: { content, allowHtml },
    global: { stubs: { MindMap: true } }
  })
}

describe('MarkdownPreview', () => {
  test('sanitizes raw HTML and unsafe markdown URLs for untrusted content', () => {
    const wrapper = mountPreview('<img src=x onerror="alert(1)"> [click](javascript:alert(1))', false)

    // allowHtml: false → 原始 HTML 整段转义,不会落成节点
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[onerror]').exists()).toBe(false)
    // 危险协议(markdown-it 的 validateLink)不会被渲染成可点的链接
    expect(wrapper.findAll('a')).toHaveLength(0)
    expect(wrapper.find('[href]').exists()).toBe(false)
    expect(wrapper.find('[src]').exists()).toBe(false)
  })

  test('keeps trusted raw html but never emits javascript: links', () => {
    const wrapper = mountPreview('<img src="/a.png" alt="x"> [ok](https://example.com) [bad](javascript:alert(1))')

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/a.png')

    // markdown-it 的 validateLink 会把危险协议整段退化成纯文本,不产生 <a>
    const links = wrapper.findAll('a')
    expect(links).toHaveLength(1)
    expect(links[0].attributes('href')).toBe('https://example.com')
    expect(wrapper.html()).not.toMatch(/href="javascript:/i)
  })
})
