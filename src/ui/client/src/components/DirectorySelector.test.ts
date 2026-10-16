import { test, expect, vi, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ElMessage } from 'element-plus'
import { mountWithSetup } from '@/test-utils/mount'
import { useConfigStore } from '@/stores/configStore'
import { useToolsStore } from '@/stores/toolsStore'
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

// ── 顶栏右键菜单：「添加 zen-gitsync MCP」 ──────────────────────────
// 入口只对支持 MCP 的工具显示（mcpInstallStore 的 TOOL_MCP_TARGETS 白名单）；
// 点击走 /api/mcp-install/install，写配置文件的真相在服务端。
// 这里必须**全量挂载**：shallow 会把 el-popover 换成桩，菜单内容根本不在 DOM 里
// （前四个用例只测 g ai 按钮和弹窗，用 shallow 就够）。Teleport 由 mountWithSetup
// 默认内联到 wrapper 树。

/** 把工具检测结果直接置成"已安装"，省掉 check-tools 往返 */
function markToolsInstalled() {
  const tools = useToolsStore()
  tools.lastCheckedAt = Date.now()
  tools.codexAvailable = true
  tools.vscodeAvailable = true
  tools.claudeAvailable = true
  tools.opencodeAvailable = true
  tools.codebuddyAvailable = true
  tools.piAvailable = true
  tools.kimiAvailable = true // 白名单外工具，用作反向对照
}

/** 桩掉 MCP 登记相关端点；返回记录到的 install 调用（{ target }） */
function stubMcpFetch(targets: any[] = [], installResult: any = { success: true, changed: true, message: 'Codex CLI: 已写入 C:\\Users\\x\\.codex\\config.toml' }) {
  const installCalls: Array<{ target: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (url.includes('/api/mcp-install/targets')) return json({ success: true, targets })
    if (url.includes('/api/mcp-install/install')) {
      installCalls.push(JSON.parse(init?.body ?? '{}'))
      return json(installResult)
    }
    if (url.includes('/api/latest-tool-versions')) return json({ success: true, latest: {} })
    return json({ success: true })
  }))
  return installCalls
}

function mountFull() {
  wrapper = mountWithSetup(DirectorySelector, {
    props: { variant: 'header' },
    global: { stubs: { ...baseStubs } },
  })
  return wrapper
}

/**
 * 从 document.body 上找某个工具的菜单。
 *
 * ⚠️ el-popover 的 popper 内容是真 teleport 到 body 的（VTU 的 Teleport stub 拦不住
 * 组件内部直接 import 的 Teleport），wrapper 树里看不到 —— 与探针
 * verify-open-with-permission-menus.cjs 一样按 aria-label 在 document 上找。
 * 同一工具只有一份菜单，aria-label 就够区分；其余工具的菜单也全在 DOM 里（藏着）。
 */
function menuInBody(ariaLabel: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('.claude-menu'))
    .find(m => m.getAttribute('aria-label') === ariaLabel)
}

/** 右键某个顶栏工具按钮，返回它那份菜单（trigger 自身在 wrapper 里，用 VTU 触发） */
async function openToolMenu(view: ReturnType<typeof mountFull>, ariaPrefix: string, menuAria: string) {
  const trigger = view.findAll('.simple-tool-trigger')
    .find((s: any) => s.find('button').attributes('aria-label')?.startsWith(ariaPrefix))
  expect(trigger, `顶栏找不到 ${ariaPrefix} 按钮`).toBeTruthy()
  await trigger!.trigger('contextmenu')
  await flushPromises()
  const menu = menuInBody(menuAria)
  expect(menu, `${menuAria} 的右键菜单没渲染`).toBeTruthy()
  return menu!
}

/** 菜单里的「添加 zen-gitsync MCP」项（没有就是 undefined） */
function mcpItemIn(menu: HTMLElement): HTMLElement | undefined {
  return Array.from(menu.querySelectorAll<HTMLElement>('.claude-menu__item'))
    .find(li => li.textContent?.includes('@67CE7:添加 zen-gitsync MCP'))
}

/** teleport 出去的菜单项用原生 click（Vue 的监听挂在元素本身，会照常触发） */
async function clickEl(el: HTMLElement) {
  el.click()
  await flushPromises()
}

test('右键 Codex:菜单含「添加 zen-gitsync MCP」,点击后一键登记并提示', async () => {
  const installCalls = stubMcpFetch([
    { id: 'codex', label: 'Codex CLI', file: 'C:\\Users\\x\\.codex\\config.toml', installed: false, parent_exists: true },
  ])
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  const menu = await openToolMenu(view, '@67CE7:用 Codex 打开', 'Codex')
  const item = mcpItemIn(menu)
  expect(item, 'Codex 菜单里没有 MCP 安装项').toBeTruthy()
  expect(item!.textContent).toContain('@67CE7:一键安装') // 没登记过 → 一键安装

  await clickEl(item!)
  expect(installCalls).toEqual([{ target: 'codex' }])
  expect(ElMessage.success).toHaveBeenCalledWith(expect.stringContaining('已写入'))
})

test('已登记的工具,菜单项提示翻成「已添加」', async () => {
  stubMcpFetch([
    { id: 'codex', label: 'Codex CLI', file: 'C:\\Users\\x\\.codex\\config.toml', installed: true, parent_exists: true },
  ])
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  const menu = await openToolMenu(view, '@67CE7:用 Codex 打开', 'Codex')
  expect(mcpItemIn(menu)!.textContent).toContain('@67CE7:已添加')
})

test('登记失败 → 错误提示带服务端给的原因', async () => {
  stubMcpFetch([], { success: false, error: '配置文件不是合法 JSON,已跳过: C:\\Users\\x\\.claude.json' })
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  const menu = await openToolMenu(view, '@67CE7:用 Codex 打开', 'Codex')
  await clickEl(mcpItemIn(menu)!)
  expect(ElMessage.error).toHaveBeenCalledWith(expect.stringContaining('不是合法 JSON'))
})

test('白名单外工具(kimi)的菜单没有 MCP 安装项', async () => {
  stubMcpFetch([])
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  // kimi 的 MCP 支持没核实过（mcpInstallStore 白名单里没有它）→ 不给入口
  const menu = await openToolMenu(view, '@67CE7:用 Kimi Code 打开', 'Kimi Code')
  expect(mcpItemIn(menu)).toBeUndefined()
})

test('没有权限档的 vscode 菜单 = MCP 项 + 更新项（档位表没漏成对所有工具生效）', async () => {
  stubMcpFetch([
    { id: 'vscode', label: 'VS Code', file: 'C:\\Users\\x\\AppData\\Roaming\\Code\\User\\mcp.json', installed: false, parent_exists: true },
  ])
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  const menu = await openToolMenu(view, '@67CE7:用 VSCode 打开', 'VSCode')
  const labels = Array.from(menu.querySelectorAll('.claude-menu__item')).map(li => li.textContent || '')
  expect(labels).toHaveLength(2)
  expect(labels[0]).toContain('@67CE7:添加 zen-gitsync MCP')
  expect(labels[1]).toContain('@67CE7:更新')
})

test('右键 Claude Code 按钮:MCP 入口登记到 claude-code（CLI 的 ~/.claude.json，不是 Desktop 那份）', async () => {
  const installCalls = stubMcpFetch([
    { id: 'claude-code', label: 'Claude Code（CLI）', file: 'C:\\Users\\x\\.claude.json', installed: false, parent_exists: true },
  ])
  const view = mountFull()
  markToolsInstalled()
  await flushPromises()

  await view.get('.claude-code-trigger').trigger('contextmenu')
  await flushPromises()
  const menu = menuInBody('@67CE7:Claude Code 启动模式')
  expect(menu, 'Claude Code 的右键菜单没渲染').toBeTruthy()

  const item = mcpItemIn(menu!)
  expect(item, 'Claude Code 菜单里没有 MCP 安装项').toBeTruthy()
  await clickEl(item!)
  expect(installCalls).toEqual([{ target: 'claude-code' }])
})
