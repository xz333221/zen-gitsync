// CustomCommandsPanel.vue 定时提交逻辑单元测试。
// 覆盖:非 git 仓库早退、无变更跳过、默认/AI 提交信息、add 失败、commit 失败、
//       目录守卫自动停止、armNextTimer 防重复定时器、设置持久化(运行状态不持久化)。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@stores/gitStore', () => ({ useGitStore: () => mockGitStore }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => mockConfigStore }))

import CustomCommandsPanel from './CustomCommandsPanel.vue'
import { mockGitStore, mockConfigStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'
import { resetFetch } from '@/test-utils/mockFetch'
import { ElMessage } from 'element-plus'

const SCHEDULE_SETTINGS_KEY = 'zen-gitsync:schedule-commit-settings'

let _lastWrapper: any = null
function mountPanel() {
  if (_lastWrapper) { try { _lastWrapper.unmount() } catch {} }
  _lastWrapper = mountWithSetup(CustomCommandsPanel, {
    global: { stubs: {
      IconButton: true,
      SvgIcon: true,
      CustomCommandManager: true,
    } },
  })
  return _lastWrapper
}

// 同时 mock AI 生成 + add-all 两个端点的 fetch
function mockScheduleFetch(aiBody: any, addAllBody: any = { success: true }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const u = typeof input === 'string' ? input : input.url
    let body: any = {}
    if (u.includes('/api/config/generate-commit-message')) body = aiBody
    else if (u.includes('/api/add-all')) body = addAllBody
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function unmountAll() {
  if (_lastWrapper) {
    try { (_lastWrapper.vm as any).scheduleEnabled = false } catch {}
    try { _lastWrapper.unmount() } catch {}
    _lastWrapper = null
  }
}

describe('CustomCommandsPanel.vue 定时提交', () => {
  beforeEach(() => {
    localStorage.clear()
    mockGitStore.isGitRepo = true
    mockGitStore.fileList = [{ path: 'a.ts', type: 'M' }]
    mockGitStore.fetchStatusPorcelain = vi.fn().mockResolvedValue(undefined)
    mockGitStore.commitChanges = vi.fn().mockResolvedValue(true)
    mockGitStore.pushToRemote = vi.fn().mockResolvedValue(true)
    mockConfigStore.customCommands = []
    mockConfigStore.currentDirectory = '/proj'
    mockConfigStore.defaultCommitMessage = ''
    vi.mocked(ElMessage).mockClear()
    vi.mocked(ElMessage.success).mockClear()
    vi.mocked(ElMessage.error).mockClear()
    vi.mocked(ElMessage.warning).mockClear()
    vi.mocked(ElMessage.info).mockClear()
  })

  afterEach(() => {
    resetFetch()
    unmountAll()
  })

  test('CCP-01: 非 git 仓库 → 直接返回,不发任何请求', async () => {
    mockGitStore.isGitRepo = false
    const fetchSpy = mockScheduleFetch({})
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockGitStore.commitChanges).not.toHaveBeenCalled()
    // 日志里记了错误
    expect((w.vm as any).scheduleLogs[0].ok).toBe(false)
  })

  test('CCP-02: 无变更 → 记 skip 日志,不调 add-all / commitChanges', async () => {
    mockGitStore.fileList = []
    const fetchSpy = mockScheduleFetch({})
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(mockGitStore.fetchStatusPorcelain).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mockGitStore.commitChanges).not.toHaveBeenCalled()
    const log = (w.vm as any).scheduleLogs[0]
    expect(log.ok).toBe(true)
    expect(log.skipped).toBe(true)
  })

  test('CCP-03: 默认信息模式 → add-all + commitChanges(默认信息)', async () => {
    mockConfigStore.defaultCommitMessage = 'chore: daily sync'
    const fetchSpy = mockScheduleFetch({})
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    const calledUrls = fetchSpy.mock.calls.map((c: any[]) =>
      typeof c[0] === 'string' ? c[0] : c[0].url
    )
    expect(calledUrls.some((u: string) => u.includes('/api/add-all'))).toBe(true)
    expect(mockGitStore.commitChanges).toHaveBeenCalledWith('chore: daily sync', false)
    const log = (w.vm as any).scheduleLogs[0]
    expect(log.ok).toBe(true)
    expect(log.message).toBe('chore: daily sync')
  })

  test('CCP-04: 默认信息为空 → 兜底 chore: auto commit at HH:MM:SS', async () => {
    mockScheduleFetch({})
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledTimes(1)
    const msg = mockGitStore.commitChanges.mock.calls[0][0]
    expect(msg).toMatch(/^chore: auto commit at \d{2}:\d{2}:\d{2}$/)
  })

  test('CCP-05: AI 模式成功(含 scope) → commitChanges(type(scope): desc)', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleMessageMode = 'ai'
    mockScheduleFetch({ success: true, type: 'fix', scope: 'ui', description: '修复按钮' })
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledWith('fix(ui): 修复按钮', false)
  })

  test('CCP-06: AI 模式成功(无 scope) → commitChanges(type: desc)', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleMessageMode = 'ai'
    mockScheduleFetch({ success: true, type: 'feat', scope: '', description: '新增功能' })
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledWith('feat: 新增功能', false)
  })

  test('CCP-07: AI 生成失败 → 不提交,log ok=false', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleMessageMode = 'ai'
    mockScheduleFetch({ success: false, error: 'NO_MODEL' })
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).not.toHaveBeenCalled()
    expect(vm.scheduleLogs[0].ok).toBe(false)
  })

  test('CCP-08: add-all 失败 → 不提交,log ok=false', async () => {
    mockScheduleFetch({}, { success: false, error: 'git add failed' })
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(mockGitStore.commitChanges).not.toHaveBeenCalled()
    expect((w.vm as any).scheduleLogs[0].ok).toBe(false)
  })

  test('CCP-09: commitChanges 返回 false → log ok=false', async () => {
    mockGitStore.commitChanges = vi.fn().mockResolvedValue(false)
    mockScheduleFetch({})
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalled()
    expect((w.vm as any).scheduleLogs[0].ok).toBe(false)
  })

  test('CCP-10: 目录守卫 → 项目目录切换后自动停止,不提交', async () => {
    mockScheduleFetch({})
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleEnabled = true
    vm.scheduleStartDir = '/other-dir' // 与 mockConfigStore.currentDirectory('/proj') 不一致
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).not.toHaveBeenCalled()
    expect(vm.scheduleEnabled).toBe(false)
    expect(vm.scheduleLogs[0].ok).toBe(false)
    expect(ElMessage.warning).toHaveBeenCalled()
  })

  test('CCP-11: armNextTimer 二次调用 → 先清旧定时器再排新,不叠加', () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleEnabled = true
    const st = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(111 as any)
    const ct = vi.spyOn(globalThis, 'clearTimeout').mockReturnValue(undefined as any)
    try {
      vm.armNextTimer()
      expect(st).toHaveBeenCalledTimes(1)
      expect(ct).not.toHaveBeenCalled()
      vm.armNextTimer()
      expect(st).toHaveBeenCalledTimes(2)
      expect(ct).toHaveBeenCalledWith(111)
    } finally {
      st.mockRestore()
      ct.mockRestore()
    }
  })

  test('CCP-12: toggleSchedule(false) → 清定时器、置停、提示', () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleCommitNow = false
    const st = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(222 as any)
    const ct = vi.spyOn(globalThis, 'clearTimeout').mockReturnValue(undefined as any)
    try {
      vm.toggleSchedule(true)
      expect(vm.scheduleEnabled).toBe(true)
      expect(st).toHaveBeenCalledTimes(1)
      expect(ElMessage.success).toHaveBeenCalled()
      vm.toggleSchedule(false)
      expect(ct).toHaveBeenCalledWith(222)
      expect(vm.scheduleEnabled).toBe(false)
      expect(ElMessage.info).toHaveBeenCalled()
    } finally {
      st.mockRestore()
      ct.mockRestore()
    }
  })

  test('CCP-13: 设置变更持久化到 localStorage;运行状态不持久化', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleInterval = 15
    vm.scheduleMessageMode = 'ai'
    await w.vm.$nextTick()
    await new Promise(r => setTimeout(r, 0))
    const raw = localStorage.getItem(SCHEDULE_SETTINGS_KEY)
    expect(raw).toBeTruthy()
    const saved = JSON.parse(raw!)
    expect(saved.interval).toBe(15)
    expect(saved.messageMode).toBe('ai')
    expect(saved.unit).toBe('min')
    // 运行状态不该被持久化(刷新后默认停止)
    expect(Object.keys(saved)).not.toContain('enabled')
    expect(Object.keys(saved)).not.toContain('running')
  })

  test('CCP-14: intervalMs 按单位换算', () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleInterval = 30
    vm.scheduleUnit = 'min'
    expect(vm.intervalMs).toBe(30 * 60_000)
    vm.scheduleUnit = 'hour'
    expect(vm.intervalMs).toBe(30 * 3_600_000)
    vm.scheduleUnit = 'day'
    expect(vm.intervalMs).toBe(30 * 86_400_000)
    // 非法输入兜底为最小 1 个单位
    vm.scheduleInterval = 0
    expect(vm.intervalMs).toBe(86_400_000)
  })

  test('CCP-15: 自定义信息非空 → 优先于全局默认信息', async () => {
    mockConfigStore.defaultCommitMessage = 'chore: daily sync'
    mockScheduleFetch({})
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleCustomMessage = 'docs: 定时归档笔记'
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledWith('docs: 定时归档笔记', false)
  })

  test('CCP-16: 自定义信息为空白 → trim 后回落到全局默认信息', async () => {
    mockConfigStore.defaultCommitMessage = 'chore: daily sync'
    mockScheduleFetch({})
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleCustomMessage = '   '
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledWith('chore: daily sync', false)
  })

  test('CCP-17: 自动推送默认开启 → 提交成功后推送远程', async () => {
    mockScheduleFetch({})
    const w = mountPanel()
    const vm: any = w.vm
    expect(vm.scheduleAutoPush).toBe(true) // 默认开启
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledTimes(1)
    expect(mockGitStore.pushToRemote).toHaveBeenCalledTimes(1)
  })

  test('CCP-18: 关闭自动推送 → 只提交不推送', async () => {
    mockScheduleFetch({})
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleAutoPush = false
    await vm.runScheduledCommit()
    expect(mockGitStore.commitChanges).toHaveBeenCalledTimes(1)
    expect(mockGitStore.pushToRemote).not.toHaveBeenCalled()
  })

  test('CCP-19: 提交失败 → 不推送(不会推上一次的提交)', async () => {
    mockScheduleFetch({})
    mockGitStore.commitChanges = vi.fn().mockResolvedValue(false)
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    expect(mockGitStore.pushToRemote).not.toHaveBeenCalled()
  })

  test('CCP-20: 推送失败 → 记一条推送失败日志,提交的日志仍为成功', async () => {
    mockScheduleFetch({})
    mockGitStore.pushToRemote = vi.fn().mockResolvedValue(false)
    const w = mountPanel()
    await (w.vm as any).runScheduledCommit()
    const logs = (w.vm as any).scheduleLogs
    // 最新的在最前面:0 = 推送失败,1 = 提交成功
    expect(logs[0].ok).toBe(false)
    expect(logs[0].stage).toBe('push')
    expect(logs[1].ok).toBe(true)
    expect(logs[1].message).toMatch(/^chore: auto commit at/)
  })

  test('CCP-21: 自动推送开关持久化(默认 true 落盘)', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleAutoPush = false
    await w.vm.$nextTick()
    await new Promise(r => setTimeout(r, 0))
    expect(JSON.parse(localStorage.getItem(SCHEDULE_SETTINGS_KEY)!).autoPush).toBe(false)
  })

  test('CCP-22: 自定义信息持久化到 localStorage', async () => {
    const w = mountPanel()
    const vm: any = w.vm
    vm.scheduleCustomMessage = 'docs: 定时归档笔记'
    await w.vm.$nextTick()
    await new Promise(r => setTimeout(r, 0))
    const saved = JSON.parse(localStorage.getItem(SCHEDULE_SETTINGS_KEY)!)
    expect(saved.customMessage).toBe('docs: 定时归档笔记')
  })
})
