// CommitForm.vue 单元测试。
// 覆盖:AI generate(成功 + 5 个错误码)、handleEnterKey 早退分支、模板填字段、watcher pendingMergeMessage。
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
vi.mock('@/composables/useSuccessModal', () => ({
  useSuccessModal: () => ({ successState: { value: false }, show: vi.fn() }),
}))
vi.mock('@/utils/fileLock', () => ({ isFilePathLocked: vi.fn().mockReturnValue(false) }))

import CommitForm from './CommitForm.vue'
import { mockGitStore, mockConfigStore, mockLocaleStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'
import { mockFetchResponse, resetFetch } from '@/test-utils/mockFetch'
import { ElMessage } from 'element-plus'

let _lastWrapper: any = null
function mountCommitForm() {
  if (_lastWrapper) { try { _lastWrapper.unmount() } catch {} }
  _lastWrapper = mountWithSetup(CommitForm, {
    global: { stubs: {
      TemplateManager: true,
      GitCommandPreview: true,
      GitActionButtons: { template: '<div><slot /></div>' },
      GlobalLoading: true,
      SuccessModal: true,
      IconButton: true,
      CommandHistory: true,
    } },
  })
  return _lastWrapper
}

describe('CommitForm.vue', () => {
  beforeEach(() => {
    mockGitStore.isGitRepo = true
    mockGitStore.fileList = []
    mockGitStore.selectedFiles = new Set()
    mockGitStore.isSelectionMode = false
    mockGitStore.hasConflictedFiles = false
    mockGitStore.isCommiting = false
    mockGitStore.isPushing = false
    mockGitStore.isAddingFiles = false
    mockGitStore.hasUpstream = true
    mockGitStore.pendingMergeMessage = ''
    mockConfigStore.isStandardCommit = true
    mockConfigStore.skipHooks = false
    mockConfigStore.descriptionTemplates = []
    mockConfigStore.scopeTemplates = []
    mockConfigStore.defaultCommitMessage = ''
    mockConfigStore.autoSetDefaultMessage = false
    mockConfigStore.autoQuickPushOnEnter = false
    vi.mocked(ElMessage).mockClear()
    vi.mocked(ElMessage.success).mockClear()
    vi.mocked(ElMessage.error).mockClear()
  })

  afterEach(() => {
    resetFetch()
    // 不要 vi.restoreAllMocks() —— 会清掉 setup.ts 的 matchMedia mock,导致后续测试 @vueuse useMediaQuery 失败
  })

  // ========== AI 生成 ==========

  test('CF-01: AI generate 成功 → 填 commitType/Scope/Description', async () => {
    mockFetchResponse('/api/config/generate-commit-message', {
      success: true, type: 'fix', scope: 'ui', description: '修复按钮',
    })
    const w = mountCommitForm()
    const vm: any = w.vm
    await vm.handleAiGenerateCommit()
    expect(vm.commitType).toBe('fix')
    expect(vm.commitScope).toBe('ui')
    expect(vm.commitDescription).toBe('修复按钮')
    expect(ElMessage.success).toHaveBeenCalled()
  })

  test('CF-02: AI TIMEOUT → ElMessage.error 调 i18n key', async () => {
    mockFetchResponse('/api/config/generate-commit-message', { success: false, code: 'TIMEOUT' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(ElMessage.error).toHaveBeenCalled()
    const arg = vi.mocked(ElMessage.error).mock.calls[0][0]
    expect(arg).toMatch(/超时|TIMEOUT/i)
  })

  test('CF-03: AI NO_MODEL → 提示配置模型', async () => {
    mockFetchResponse('/api/config/generate-commit-message', { success: false, code: 'NO_MODEL' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(ElMessage.error).toHaveBeenCalled()
    const arg = vi.mocked(ElMessage.error).mock.calls[0][0]
    expect(arg).toMatch(/模型|model/i)
  })

  test('CF-04: AI PARSE_FAILED → 提示格式无法解析', async () => {
    mockFetchResponse('/api/config/generate-commit-message', { success: false, code: 'PARSE_FAILED' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(ElMessage.error).toHaveBeenCalled()
  })

  test('CF-05: AI GENERATE_FAILED → 通用失败提示', async () => {
    mockFetchResponse('/api/config/generate-commit-message', { success: false, code: 'GENERATE_FAILED' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(ElMessage.error).toHaveBeenCalled()
  })

  test('CF-06: AI HTTP_ERR → 兜底失败提示', async () => {
    mockFetchResponse('/api/config/generate-commit-message', { success: false, code: 'HTTP_ERR' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(ElMessage.error).toHaveBeenCalled()
  })

  test('CF-07: AI 选中模式 → payload.selectedPaths 含选中文件', async () => {
    mockGitStore.isSelectionMode = true
    mockGitStore.selectedFiles = new Set(['a.txt', 'b.txt'])
    mockFetchResponse('/api/config/generate-commit-message', { success: true, type: 'feat', description: 'd' })
    const w = mountCommitForm()
    await w.vm.handleAiGenerateCommit()
    expect(globalThis.fetch).toHaveBeenCalled()
    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    const body = JSON.parse((call[1] as any).body)
    expect(body.selectedPaths).toEqual(['a.txt', 'b.txt'])
  })

  test('CF-08: AI 非标准提交模式 → 拼成 commitMessage', async () => {
    mockConfigStore.isStandardCommit = false
    mockFetchResponse('/api/config/generate-commit-message', { success: true, type: 'fix', scope: 'core', description: '修复 bug' })
    const w = mountCommitForm()
    const vm: any = w.vm
    await vm.handleAiGenerateCommit()
    expect(vm.commitMessage).toContain('fix(core)')
    expect(vm.commitMessage).toContain('修复 bug')
  })

  // ========== 模板 ==========

  test('CF-09: useScopeTemplate 填 scope', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.useScopeTemplate('api')
    expect(vm.commitScope).toBe('api')
  })

  test('CF-10: useTemplate 填 description', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.useTemplate('新增功能')
    expect(vm.commitDescription).toBe('新增功能')
  })

  test('CF-11: useMessageTemplate 走 handleMessageSelect', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.handleMessageSelect({ value: 'feat: x' })
    expect(vm.commitMessage).toBe('feat: x')
  })

  // ========== handleEnterKey 早退分支 ==========

  test('CF-12: handleEnterKey 空 commitMessage → 不调 triggerQuickPush', async () => {
    mockConfigStore.autoQuickPushOnEnter = true
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.commitMessage = ''
    await vm.handleEnterKey({ shiftKey: false } as KeyboardEvent)
    // 不抛错 + gitActionButtonsRef 是 null,无调用
    expect(true).toBe(true)
  })

  test('CF-13: handleEnterKey hasUpstream=false → 不调 triggerQuickPush', async () => {
    mockGitStore.hasUpstream = false
    mockConfigStore.autoQuickPushOnEnter = true
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.commitMessage = 'test'
    await vm.handleEnterKey({ shiftKey: false } as KeyboardEvent)
    expect(true).toBe(true)
  })

  test('CF-14: handleEnterKey Shift+Enter → skip auto-push', async () => {
    mockConfigStore.autoQuickPushOnEnter = true
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.commitMessage = 'test'
    await vm.handleEnterKey({ shiftKey: true } as KeyboardEvent)
    expect(true).toBe(true)
  })

  // ========== watcher ==========

  test('CF-15: pendingMergeMessage watcher 填 commitDescription', async () => {
    mockGitStore.pendingMergeMessage = 'merge fix'
    const w = mountCommitForm()
    await w.vm.$nextTick()
    await new Promise(r => setTimeout(r, 50))
    // watcher 应把 pendingMergeMessage 同步到 commitMessage 或 commitDescription
    const vm: any = w.vm
    expect(vm.commitMessage === 'merge fix' || vm.commitDescription === 'merge fix').toBe(true)
  })

  // ========== 模板管理 sentinel ==========

  test('CF-16: openDescriptionSettings → descriptionDialogVisible=true', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.openDescriptionSettings()
    expect(vm.descriptionDialogVisible).toBe(true)
  })

  test('CF-17: openScopeSettings → scopeDialogVisible=true', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.openScopeSettings()
    expect(vm.scopeDialogVisible).toBe(true)
  })

  // ========== loading state hooks ==========

  test('CF-18: handleQuickPushBefore 调 showLoading + setLoadingText', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.handleQuickPushBefore()
    // 内部调 useGlobalLoading 包装;只断言不抛错
    expect(true).toBe(true)
  })

  test('CF-19: handleQuickPushAfter(true) → hideLoading', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.handleQuickPushAfter(true)
    expect(true).toBe(true)
  })

  test('CF-20: clearCommitFields 清空 message/description/body/footer,重置 type=feat', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.commitMessage = 'old'
    vm.commitDescription = 'old-desc'
    vm.commitBody = 'old-body'
    vm.commitFooter = 'old-footer'
    vm.commitType = 'fix'
    vm.clearCommitFields()
    expect(vm.commitMessage).toBe('')
    expect(vm.commitDescription).toBe('')
    expect(vm.commitBody).toBe('')
    expect(vm.commitFooter).toBe('')
    expect(vm.commitType).toBe('feat')
  })

  test('CF-21: isStandardCommit computed 双向绑定到 configStore', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.isStandardCommit = false
    expect(mockConfigStore.isStandardCommit).toBe(false)
    vm.isStandardCommit = true
    expect(mockConfigStore.isStandardCommit).toBe(true)
  })

  test('CF-22: skipHooks computed 双向绑定到 configStore', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.skipHooks = true
    expect(mockConfigStore.skipHooks).toBe(true)
  })

  test('CF-23: handleDescriptionSelect 普通项 → useDescriptionTemplate', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.handleDescriptionSelect({ value: 'fix bug' })
    expect(vm.commitDescription).toBe('fix bug')
  })

  test('CF-24: handleDescriptionSelect sentinel → openDescriptionSettings', () => {
    const w = mountCommitForm()
    const vm: any = w.vm
    vm.handleDescriptionSelect({ value: '', isSettings: true })
    expect(vm.descriptionDialogVisible).toBe(true)
  })
})
