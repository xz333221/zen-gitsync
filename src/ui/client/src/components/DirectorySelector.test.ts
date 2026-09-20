import { test, expect, vi, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ElMessage } from 'element-plus'
import { mountWithSetup } from '@/test-utils/mount'
import { useConfigStore } from '@/stores/configStore'
import DirectorySelector from './DirectorySelector.vue'

vi.mock('local-file-picker/client', () => ({ FilePickerModal: { template: '<div />' } }))
vi.mock('@/stores/gitStore', () => ({ useGitStore: () => ({ isGitRepo: true }) }))

let wrapper: ReturnType<typeof mountWithSetup> | null = null
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); vi.clearAllMocks() })

function mountSelector() {
  wrapper = mountWithSetup(DirectorySelector, {
    props: { variant: 'header' },
    shallow: true,
    global: { stubs: {
      Warning: true,
      IconButton: {
        props: ['disabled', 'customClass', 'ariaLabel', 'iconClass'],
        emits: ['click'],
        template: '<button :class="customClass" :disabled="disabled" :aria-label="ariaLabel" :data-icon="iconClass" @click="$emit(\'click\')"><slot /></button>',
      },
    } },
  })
  return wrapper
}

test('header g ai button uses the current directory and suppresses duplicate launches', async () => {
  const requests: Array<{ url: string, body: any }> = []
  let finish!: (response: any) => void
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return new Promise(resolve => { finish = resolve })
  }))
  const view = mountSelector()
  const config = useConfigStore()
  config.currentDirectory = 'C:/first project'
  await flushPromises()
  const button = view.get('.g-ai-launch-button')
  expect(button.attributes('data-icon')).toBe('g-ai')
  await button.trigger('click')
  await button.trigger('click')
  expect(requests).toEqual([{ url: '/api/open-directory-with-g-ai', body: { path: 'C:/first project' } }])
  expect(button.attributes('disabled')).toBeDefined()
  finish({ ok: true, json: async () => ({ success: true }) })
  await flushPromises()
  config.currentDirectory = 'D:/中文 & second project'
  await flushPromises()
  await button.trigger('click')
  expect(requests[1].body.path).toBe(config.currentDirectory)
  finish({ ok: true, json: async () => ({ success: true }) })
  await flushPromises()
})

test('empty directories disable g ai; failed launches show an error and allow retry', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ success: false, error: 'terminal unavailable' }) }))
  const view = mountSelector()
  const config = useConfigStore()
  config.currentDirectory = ''
  await flushPromises()
  const button = view.get('.g-ai-launch-button')
  expect(button.attributes('disabled')).toBeDefined()
  config.currentDirectory = 'C:/project'
  await flushPromises()
  await button.trigger('click')
  await flushPromises()
  expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('terminal unavailable'))
  expect(button.attributes('disabled')).toBeUndefined()
})
