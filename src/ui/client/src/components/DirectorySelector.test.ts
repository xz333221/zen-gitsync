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

// <Warning /> 是模板里直接用的图标(靠全局组件解析),测试里要 stub 掉,
// 否则每次渲染都刷一条 "Failed to resolve component: Warning"
const baseStubs = { Warning: true }

function mountSelector() {
  wrapper = mountWithSetup(DirectorySelector, {
    props: { variant: 'header' },
    shallow: true,
    global: { stubs: {
      ...baseStubs,
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

// 弹窗「常用目录」标题行右端的「刷新全部」:与首屏「最近项目」面板上那一个是同一个
// 按钮组件(同一个 .dir-list__refresh)、同一份刷新逻辑。列表在弹窗里是 variant="bare",
// 没有自己的标题行,按钮由弹窗从列表 expose 出来的状态渲染 —— 这条用例锁的就是这根接线。
const DIRS = [
  { path: 'D:\\a', exists: true },
  { path: 'D:\\b', exists: true },
]

/** 只桩住常用目录那三个端点;返回记录到的 fetch 路径,供断言"刷了哪几个目录" */
function stubDirectoryFetch(dirs: Array<{ path: string; exists: boolean }> = DIRS) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input.url
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      // 顺序要紧:'/api/recent_directories' 是前两者的前缀
      if (url.includes('/api/recent_directories/git-state')) return json({ success: true, results: {} })
      if (url.includes('/api/recent_directories/fetch')) {
        const path = JSON.parse(init?.body ?? '{}').path
        calls.push(path)
        return json({ success: true, path, status: 'ok' })
      }
      if (url.includes('/api/recent_directories')) return json({ success: true, directories: dirs })
      return json({ success: true })
    }),
  )
  return calls
}

async function openDirectoryDialog() {
  // 这一条要真挂载(不能用 shallow):shallow 会把 RecentDirectoriesList 换成 stub,
  // 模板 ref 拿不到真实实例,expose 出来的刷新状态也就无从验证。
  // Teleport 必须 stub 成 true:弹窗内容被 teleport 到 body,不 stub 的话它不在
  // wrapper 的 DOM 树里,get('.form-label--dirs …') 必然找不到。
  // (mountWithSetup 里 `...passedGlobal` 排在最后,传了 global.stubs 会**整体覆盖**
  //  它默认合进去的 Teleport/el-table 那份,所以这里得自己带上。)
  const view = mountWithSetup(DirectorySelector, {
    props: { variant: 'header' },
    global: { stubs: { ...baseStubs, Teleport: true } },
  })
  await flushPromises()
  await view.get('.directory-display').trigger('click')
  await flushPromises()
  await flushPromises()
  return view
}

test('常用目录标题行带「刷新全部」,点击后逐目录 fetch 并显示进度', async () => {
  const calls = stubDirectoryFetch()
  const view = await openDirectoryDialog()
  wrapper = view

  const btn = view.get('.form-label--dirs button.dir-list__refresh')
  // 与面板上那一个同款:同一个类名、同一段文案(这里 $t 是 identity mock,断言 key 本身)
  expect(btn.text()).toContain('@13D1C:刷新全部')
  expect(btn.attributes('aria-label')).toBe('@13D1C:刷新全部')
  expect((btn.element as HTMLButtonElement).disabled).toBe(false)
  // 挂在 label 行里(不是列表内部另起一行),与面板"标题在左、动作在右"同一版式
  expect(btn.classes()).toContain('form-label__refresh')

  await btn.trigger('click')
  await flushPromises()
  await flushPromises()

  expect(calls.sort()).toEqual(['D:\\a', 'D:\\b'])
  // 刷完回到「刷新全部」且恢复可点
  const done = view.get('.form-label--dirs button.dir-list__refresh')
  expect((done.element as HTMLButtonElement).disabled).toBe(false)
  expect(done.text()).toContain('@13D1C:刷新全部')
})

test('常用目录为空时「刷新全部」禁用,不发任何 fetch', async () => {
  const calls = stubDirectoryFetch([])
  const view = await openDirectoryDialog()
  wrapper = view

  const btn = view.get('.form-label--dirs button.dir-list__refresh')
  expect((btn.element as HTMLButtonElement).disabled).toBe(true)
  await btn.trigger('click')
  await flushPromises()
  expect(calls).toHaveLength(0)
})
