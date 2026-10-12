import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownPreview from './MarkdownPreview.vue'

function mountPreview(content: string, allowHtml?: boolean, basePath?: string) {
  return mount(MarkdownPreview, {
    props: { content, allowHtml, basePath },
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

  test('rewrites relative image paths against basePath to the raw endpoint', () => {
    const wrapper = mountPreview(
      '![shot](screenshots/article/01-board.png)\n\n![up](../assets/x.png)',
      undefined,
      'D:\\ws\\proj\\docs\\wechat-article.md'
    )

    const srcs = wrapper.findAll('img').map(img => img.attributes('src'))
    expect(srcs).toEqual([
      `/api/editor/raw?path=${encodeURIComponent('D:/ws/proj/docs/screenshots/article/01-board.png')}`,
      `/api/editor/raw?path=${encodeURIComponent('D:/ws/proj/assets/x.png')}`
    ])
  })

  test('leaves external and root-relative image URLs untouched', () => {
    const wrapper = mountPreview(
      '![a](https://cdn.example.com/a.png)\n\n![b](/static/b.png)\n\n![c](data:image/png;base64,AAAA)',
      undefined,
      'D:\\ws\\proj\\docs\\wechat-article.md'
    )

    const srcs = wrapper.findAll('img').map(img => img.attributes('src'))
    expect(srcs).toEqual([
      'https://cdn.example.com/a.png',
      '/static/b.png',
      'data:image/png;base64,AAAA'
    ])
  })

  test('theme prop scopes the theme to this instance instead of the global one', () => {
    // 不传 theme：跟全局那套走，根节点不带实例级类名
    expect(mountPreview('正文').classes()).not.toContain('md-preview--scoped-github')

    const scoped = mount(MarkdownPreview, {
      props: { content: '正文', theme: 'github-dark' },
      global: { stubs: { MindMap: true } }
    })
    expect(scoped.classes()).toContain('md-preview--scoped-github-dark')

    // 注入的样式把选择器抬成两段类名（特异性 0-2-0 > 全局那套 0-1-0），
    // 且不留裸的 .md-preview 选择器，否则会反过来盖掉全局主题
    const style = document.getElementById('flowdash-md-preview-scoped-github-dark')
    expect(style).not.toBeNull()
    expect(style!.textContent).toContain('.md-preview.md-preview--scoped-github-dark')
    expect(style!.textContent).not.toMatch(/\.md-preview\s*[,{]/)
  })

  test('two scoped themes never collide (each carries its own class)', () => {
    // 类名里带主题名，两套实例级样式表的选择器只匹配自己的节点。
    // 曾经共用一个类名：两套特异性相同 → 后进 <head> 的那套通吃，
    // 于是"深色→浅色→深色"来回切之后深色下会读到浅色那套。
    const dark = mount(MarkdownPreview, {
      props: { content: '正文', theme: 'github-dark' },
      global: { stubs: { MindMap: true } }
    })
    const light = mount(MarkdownPreview, {
      props: { content: '正文', theme: 'github' },
      global: { stubs: { MindMap: true } }
    })

    expect(dark.classes()).toContain('md-preview--scoped-github-dark')
    expect(dark.classes()).not.toContain('md-preview--scoped-github')
    expect(light.classes()).toContain('md-preview--scoped-github')
    expect(light.classes()).not.toContain('md-preview--scoped-github-dark')

    const darkStyle = document.getElementById('flowdash-md-preview-scoped-github-dark')
    const lightStyle = document.getElementById('flowdash-md-preview-scoped-github')
    expect(darkStyle!.textContent).toContain('.md-preview.md-preview--scoped-github-dark')
    expect(darkStyle!.textContent).not.toContain('.md-preview.md-preview--scoped-github ')
    expect(lightStyle!.textContent).toContain('.md-preview.md-preview--scoped-github ')
    expect(lightStyle!.textContent).not.toContain('--scoped-github-dark')
  })

  test('an unknown theme name falls back to the default theme class', () => {
    const wrapper = mount(MarkdownPreview, {
      props: { content: '正文', theme: 'not-a-real-theme' },
      global: { stubs: { MindMap: true } }
    })
    // 类名必须与实际注入的样式表一致，否则会出现"标了 scoped 却还是全局配色"
    expect(wrapper.classes()).toContain('md-preview--scoped-github')
  })

  test('a blank theme prop keeps the global theme', () => {
    const wrapper = mount(MarkdownPreview, {
      props: { content: '正文', theme: '' },
      global: { stubs: { MindMap: true } }
    })
    expect(wrapper.classes().some((c) => c.startsWith('md-preview--scoped-'))).toBe(false)
  })
})
