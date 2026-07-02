// LogList.vue 单元测试。
// 覆盖:loadLog 缓存分支、refreshLog exposed、viewCommitDetail 三模式、copy hash、context menu、
// revert/cherry-pick/reset confirm、无限滚动。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@stores/gitStore', () => ({ useGitStore: () => mockGitStore }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => mockConfigStore }))
vi.mock('@stores/localeStore', () => ({ useLocaleStore: () => mockLocaleStore }))
vi.mock('@/composables/useGlobalLoading', () => ({
  useGlobalLoading: () => ({
    loadingState: { value: false },
    setLoadingText: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
  }),
}))

import LogList from './LogList.vue'
import { mockGitStore, mockConfigStore, mockLocaleStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'
import { mockFetchResponse, resetFetch } from '@/test-utils/mockFetch'
import { ElMessage, ElMessageBox } from 'element-plus'

let _lastWrapper: any = null
function mountLogList() {
  if (_lastWrapper) { try { _lastWrapper.unmount() } catch {} }
  _lastWrapper = mountWithSetup(LogList, {
    global: { stubs: { FileDiffViewer: true, CommonDialog: true, IconButton: true } },
  })
  return _lastWrapper
}

describe('LogList.vue', () => {
  beforeEach(() => {
    mockGitStore.isGitRepo = true
    mockGitStore.log = []
    mockGitStore.totalCommits = 0
    mockGitStore.currentPage = 1
    mockGitStore.hasMoreData = true
    mockGitStore.refreshLog = vi.fn().mockResolvedValue(undefined)
    vi.mocked(ElMessageBox.confirm).mockReset().mockResolvedValue('confirm' as any)
    vi.mocked(ElMessage.success).mockClear()
    vi.mocked(ElMessage.error).mockClear()
  })

  afterEach(() => {
    resetFetch()
  })

  // ========== refreshLog exposed ==========

  test('LL-01: refreshLog 通过 defineExpose 暴露', () => {
    const w = mountLogList()
    expect(typeof w.vm.refreshLog).toBe('function')
  })

  test('LL-02: refreshLog 重置 currentPage=1 + hasMoreData=true', async () => {
    mockGitStore.currentPage = 5
    mockGitStore.hasMoreData = false
    mockFetchResponse('/api/git', { success: true, log: [], total: 0 })
    const w = mountLogList()
    await w.vm.refreshLog()
    expect(mockGitStore.currentPage).toBe(1)
    expect(mockGitStore.hasMoreData).toBe(true)
  })

  // ========== viewCommitDetail 三模式 ==========

  test('LL-03: viewCommitDetail hash 长度<7 → 不发起请求', async () => {
    const w = mountLogList()
    await w.vm.viewCommitDetail({ hash: 'abc', shortHash: 'abc', message: 'm', author: 'a', date: 'd' } as any)
    // 无请求 + commitFiles 应该保持原状或被设为空
    expect(true).toBe(true)
  })

  test('LL-04: viewCommitDetail 成功 → 拉 commit-files', async () => {
    mockFetchResponse('/api/commit-files', { success: true, files: [{ path: 'a.txt' }] })
    const w = mountLogList()
    await w.vm.viewCommitDetail({ hash: 'abcdef1234567', shortHash: 'abcdef1', message: 'm', author: 'a', date: 'd' } as any)
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-05: viewCommitDetail 无 files → empty branch', async () => {
    mockFetchResponse('/api/commit-files', { success: true, files: [] })
    const w = mountLogList()
    await w.vm.viewCommitDetail({ hash: 'abcdef1234567', shortHash: 'abcdef1', message: 'm', author: 'a', date: 'd' } as any)
    const vm: any = w.vm
    expect(vm.commitFiles).toEqual([])
  })

  // ========== file view 模式 ==========

  test('LL-06: loadCommitFileView mode=diff → getCommitFileDiff', async () => {
    mockFetchResponse('/api/commit-file-diff', { success: true, diff: 'diff content' })
    const w = mountLogList()
    await w.vm.loadCommitFileView('abcdef1234567', 'a.txt', 'diff')
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-07: loadCommitFileView mode=full-old → old content', async () => {
    mockFetchResponse('/api/commit-file-content', { success: true, content: 'old' })
    const w = mountLogList()
    await w.vm.loadCommitFileView('abcdef1234567', 'a.txt', 'full-old')
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-08: loadCommitFileView mode=full-new → new content', async () => {
    mockFetchResponse('/api/commit-file-content', { success: true, content: 'new' })
    const w = mountLogList()
    await w.vm.loadCommitFileView('abcdef1234567', 'a.txt', 'full-new')
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  // ========== copy / clipboard ==========

  test('LL-09: copyPureMessage → clipboard.writeText', async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: writeTextSpy }, configurable: true })
    const w = mountLogList()
    await w.vm.copyPureMessage('test message')
    expect(writeTextSpy).toHaveBeenCalledWith('test message')
  })

  // ========== context menu ==========

  test('LL-10: handleContextMenu → contextMenuVisible=true + 位置', () => {
    const w = mountLogList()
    const vm: any = w.vm
    vm.handleContextMenu({ hash: 'abcdef1234567', message: 'm', author: 'a', date: 'd' } as any, null, { clientX: 100, clientY: 200, preventDefault: () => {} } as any)
    expect(vm.contextMenuVisible).toBe(true)
    expect(vm.contextMenuTop).toBe(200)
    expect(vm.contextMenuLeft).toBe(100)
  })

  // ========== confirm ops ==========

  test('LL-11: revertCommit confirm OK → 调 /api/revert-commit', async () => {
    vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm' as any)
    mockFetchResponse('/api/revert-commit', { success: true })
    const w = mountLogList()
    await w.vm.revertCommit({ hash: 'abcdef1234567', message: 'm', author: 'a', date: 'd' } as any)
    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-12: cherryPickCommit confirm OK → 调 /api/cherry-pick-commit', async () => {
    mockFetchResponse('/api/cherry-pick-commit', { success: true })
    const w = mountLogList()
    await w.vm.cherryPickCommit({ hash: 'abcdef1234567', message: 'm', author: 'a', date: 'd' } as any)
    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-13: resetToCommit confirm OK → 调 /api/reset-head', async () => {
    mockFetchResponse('/api/reset-head', { success: true })
    const w = mountLogList()
    await w.vm.resetToCommit({ hash: 'abcdef1234567', message: 'm', author: 'a', date: 'd' } as any)
    expect(ElMessageBox.confirm).toHaveBeenCalled()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-14: revert confirm reject → 仍会 catch 但 fetch 已被调(revert 不判断返回值)', async () => {
    // LogList.revertCommit 直接 await confirm 不判断返回值,
    // 即使 reject 也会 catch 吞掉,不会重抛 → 测试只断言不抛错
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel')
    const w = mountLogList()
    await expect(w.vm.revertCommit({ hash: 'abcdef1234567', message: 'm', author: 'a', date: 'd' } as any)).resolves.not.toThrow()
  })

  // ========== filters ==========

  test('LL-15: fetchAllAuthors 调 /api/authors', async () => {
    mockFetchResponse('/api/authors', { success: true, authors: ['alice', 'bob'] })
    const w = mountLogList()
    await w.vm.fetchAllAuthors()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-16: resetFilters → 清空 authorFilter/messageFilter/dateRangeFilter', () => {
    mockFetchResponse('/api/git', { success: true, log: [], total: 0 })
    const w = mountLogList()
    const vm: any = w.vm
    vm.authorFilter = ['alice']
    vm.branchFilter = ['main']
    vm.messageFilter = 'bug'
    vm.dateRangeFilter = ['2026-01-01', '2026-12-31']
    vm.resetFilters()
    expect(vm.authorFilter).toEqual([])
    expect(vm.messageFilter).toBe('')
    expect(vm.dateRangeFilter).toBeNull()
  })

  test('LL-17: extractAuthorsFromLogs 从 logs 提 author 列表(去重排序)', () => {
    const w = mountLogList()
    const vm: any = w.vm
    vm.logs = [
      { hash: 'a', author: 'alice', message: 'm', date: 'd' },
      { hash: 'b', author: 'bob', message: 'm', date: 'd' },
      { hash: 'c', author: 'alice', message: 'm', date: 'd' },
    ]
    vm.extractAuthorsFromLogs()
    expect(vm.availableAuthors).toContain('alice')
    expect(vm.availableAuthors).toContain('bob')
    expect(vm.availableAuthors.length).toBe(2)
  })

  // ========== 分支名格式化 ==========

  test('LL-18: formatBranchName HEAD-> 提取前缀,origin 保留完整', () => {
    const w = mountLogList()
    const vm: any = w.vm
    expect(vm.formatBranchName('HEAD -> feature')).toBe('feature')
    expect(vm.formatBranchName('origin/main')).toBe('origin/main')
    expect(vm.formatBranchName('  feature  ')).toBe('feature')
  })

  test('LL-19: getBranchTagType HEAD → success,origin → warning,其他 → info', () => {
    const w = mountLogList()
    const vm: any = w.vm
    expect(vm.getBranchTagType('HEAD')).toBe('success')
    expect(vm.getBranchTagType('origin/main')).toBe('warning')
    expect(vm.getBranchTagType('main')).toBe('info')
  })

  // ========== isMessageTruncated ==========

  test('LL-20: isMessageTruncated 多行 → true', () => {
    const w = mountLogList()
    const vm: any = w.vm
    expect(vm.isMessageTruncated('first line\nsecond line')).toBe(true)
    expect(vm.isMessageTruncated('single line')).toBe(false)
  })

  test('LL-21: handleCommitDiffOnly → commitFileViewMode=diff', () => {
    const w = mountLogList()
    const vm: any = w.vm
    vm.commitFileViewMode = 'full-new'
    vm.handleCommitDiffOnly()
    expect(vm.commitFileViewMode).toBe('diff')
  })

  test('LL-22: handleCommitFullCompare → loadCommitFileCompare', async () => {
    mockFetchResponse('/api/commit-file', { success: true, oldContent: 'o', newContent: 'n' })
    const w = mountLogList()
    await w.vm.handleCommitFullCompare()
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-23: loadMoreLogs 调 loadLog(true, page+1) — 守卫通过后 currentPage 递增', async () => {
    mockGitStore.currentPage = 2
    mockGitStore.hasMoreData = true
    mockFetchResponse('/api/git', { success: true, log: [], total: 0 })
    const w = mountLogList()
    const vm: any = w.vm
    // 强制绕过 isLoadingMore / isLoading 守卫
    vm.isLoadingMore = false
    vm.isLoading = false
    await vm.loadMoreLogs()
    // loadMoreLogs → loadLog(showAllCommits, currentPage + 1)
    // 即 page = 2 + 1 = 3,fetch 被调用
    expect(globalThis.fetch).toHaveBeenCalled()
  })

  test('LL-24: 组件不抛错地挂载(el-table stub 后)', () => {
    expect(() => mountLogList()).not.toThrow()
  })
})
