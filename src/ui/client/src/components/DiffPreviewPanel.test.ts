import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import DiffPreviewPanel from './DiffPreviewPanel.vue'

const $tMock = (key: string) => key

describe('DiffPreviewPanel', () => {
  test('renders iframe for .html files with sandboxed srcdoc', () => {
    const wrapper = mount(DiffPreviewPanel, {
      props: {
        filePath: 'demo/index.html',
        content: '<h1>Hello</h1>',
      },
      global: {
        mocks: { $t: $tMock },
        stubs: { MarkdownPreview: true, ElTooltip: true },
      },
    })
    const iframe = wrapper.find('iframe.diff-preview-iframe')
    expect(iframe.exists()).toBe(true)
    expect(iframe.attributes('sandbox')).toBe('allow-same-origin')
    expect((iframe.attributes('srcdoc') || '')).toContain('<h1>Hello</h1>')
  })

  test('renders MarkdownPreview for .md files', () => {
    const wrapper = mount(DiffPreviewPanel, {
      props: {
        filePath: 'docs/README.md',
        content: '# Title',
      },
      global: {
        mocks: { $t: $tMock },
        stubs: {
          MarkdownPreview: {
            props: ['content'],
            template: '<div class="md-stub" :data-content="content" />',
          },
          ElTooltip: true,
        },
      },
    })
    expect(wrapper.find('iframe').exists()).toBe(false)
    const md = wrapper.find('.md-stub')
    expect(md.exists()).toBe(true)
    expect(md.attributes('data-content')).toBe('# Title')
  })

  test('shows unsupported hint for non-previewable file types', () => {
    const wrapper = mount(DiffPreviewPanel, {
      props: {
        filePath: 'src/main.ts',
        content: 'console.log()',
      },
      global: {
        mocks: { $t: $tMock },
        stubs: { MarkdownPreview: true, ElTooltip: true },
      },
    })
    expect(wrapper.find('.diff-preview-iframe').exists()).toBe(false)
    expect(wrapper.find('.diff-preview-unsupported').exists()).toBe(true)
  })

  test('emits refresh event when refresh button is clicked', async () => {
    const wrapper = mount(DiffPreviewPanel, {
      props: {
        filePath: 'demo/index.html',
        content: '<p>x</p>',
      },
      global: {
        mocks: { $t: $tMock },
        stubs: {
          MarkdownPreview: true,
          ElTooltip: { template: '<div><slot /></div>' },
        },
      },
    })
    await wrapper.find('.diff-preview-btn').trigger('click')
    expect(wrapper.emitted('refresh')).toBeTruthy()
  })
})

