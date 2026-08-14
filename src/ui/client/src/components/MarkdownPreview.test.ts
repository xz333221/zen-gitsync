import { describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownPreview from './MarkdownPreview.vue'

describe('MarkdownPreview', () => {
  test('sanitizes raw HTML and unsafe markdown URLs for untrusted content', () => {
    const wrapper = mount(MarkdownPreview, {
      props: {
        content: '<img src=x onerror="alert(1)"> [click](javascript:alert(1))',
        allowHtml: false
      },
      global: { stubs: { MindMap: true } }
    })

    expect(wrapper.find('img').exists()).toBe(false)
    const link = wrapper.find('a')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBeUndefined()
    expect(wrapper.find('[onerror]').exists()).toBe(false)
  })
})
