// QuickPushButton 单元测试。
// 核心断言:「纯推送」(本地已提交、只差推送) 时这颗按钮必须**可点** ——
// handleQuickPush 里纯推送分支根本不走暂存/提交,所以不能被「请输入提交信息」拦下,
// 副标题与 tooltip 也要从「暂存 + 提交 + 推送」切换成纯推送的说法。
import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@stores/gitStore', () => ({ useGitStore: () => mockGitStore }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => mockConfigStore }))
vi.mock('@/utils/fileLock', () => ({ isFilePathLocked: vi.fn().mockReturnValue(false) }))

import QuickPushButton from './QuickPushButton.vue'
import { mockGitStore, mockConfigStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'

// tooltip 内容通过 data-content 暴露,避免去真实 popper 里捞文案
const tooltipStub = {
  props: ['content'],
  template: '<div class="tt" :data-content="content"><slot /></div>',
}

// 进度弹窗只 stub 掉渲染,父组件会调它的 reset/setPulling/handleProgress,
// 少了这几个方法 handleQuickPush 会中途抛错,推送阶段根本走不到
const progressStub = {
  template: '<div class="progress-stub" />',
  methods: { reset() {}, setPulling() {}, handleProgress() {} },
}

function mountBtn(props: Record<string, any> = {}) {
  return mountWithSetup(QuickPushButton, {
    props,
    global: { stubs: { ElTooltip: tooltipStub, PushProgressModal: progressStub } },
  })
}

function tooltipOf(w: ReturnType<typeof mountBtn>) {
  return w.find('.tt').attributes('data-content')
}

describe('QuickPushButton.vue', () => {
  beforeEach(() => {
    mockGitStore.fileList = []
    mockGitStore.selectedFiles = new Set()
    mockGitStore.selectedUnstagedPaths = []
    mockGitStore.isSelectionMode = false
    mockGitStore.hasConflictedFiles = false
    mockGitStore.hasUpstream = true
    mockGitStore.branchAhead = 0
    mockGitStore.isAddingFiles = false
    mockGitStore.isCommiting = false
    mockGitStore.isPushing = false
    mockGitStore.addAndCommit = vi.fn().mockResolvedValue(true)
    mockGitStore.stageSelectedAndCommit = vi.fn().mockResolvedValue(true)
    mockGitStore.pushToRemoteWithProgress = vi.fn().mockResolvedValue(true)
    mockGitStore.gitPull = vi.fn().mockResolvedValue({ success: true })
    mockGitStore.fetchStatus = vi.fn().mockResolvedValue(undefined)
    mockGitStore.getBranchStatus = vi.fn().mockResolvedValue(undefined)
    mockConfigStore.lockedFiles = []
    mockConfigStore.pullBeforePush = false
  })

  test('QP-01: 纯推送(无本地变更 + 领先远程) → 可点击,且不进提交阶段', async () => {
    mockGitStore.branchAhead = 2
    const w = mountBtn()
    expect(w.find('button').attributes('disabled')).toBeUndefined()
    await w.find('button').trigger('click')
    expect(w.emitted('beforePush')).toBeTruthy()
    // 纯推送不该暂存/提交,否则会凭空造一条空提交
    expect(mockGitStore.addAndCommit).not.toHaveBeenCalled()
    expect(mockGitStore.pushToRemoteWithProgress).toHaveBeenCalled()
  })

  test('QP-02: 无变更且无领先提交 → 禁用', async () => {
    const w = mountBtn()
    expect(w.find('button').attributes('disabled')).toBeDefined()
    await w.find('button').trigger('click')
    expect(w.emitted('beforePush')).toBeFalsy()
  })

  test('QP-03: 有变更但用户没写提交信息 → 禁用', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn()
    expect(w.find('button').attributes('disabled')).toBeDefined()
  })

  test('QP-04: 有变更 + 有提交信息 → 可点(回归)', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn({ hasUserCommitMessage: true, finalCommitMessage: 'feat: x' })
    expect(w.find('button').attributes('disabled')).toBeUndefined()
    await w.find('button').trigger('click')
    expect(w.emitted('beforePush')).toBeTruthy()
    expect(mockGitStore.addAndCommit).toHaveBeenCalled()
  })

  test('QP-05: 无上游分支 → 即使是纯推送也禁用', async () => {
    mockGitStore.branchAhead = 2
    mockGitStore.hasUpstream = false
    const w = mountBtn()
    expect(w.find('button').attributes('disabled')).toBeDefined()
  })

  test('QP-06: 有冲突文件 → 禁用', async () => {
    mockGitStore.branchAhead = 2
    mockGitStore.hasConflictedFiles = true
    const w = mountBtn()
    expect(w.find('button').attributes('disabled')).toBeDefined()
  })

  test('QP-07: 选择模式未勾选可暂存文件 → 禁用', async () => {
    mockGitStore.branchAhead = 2
    mockGitStore.isSelectionMode = true
    const w = mountBtn({ hasUserCommitMessage: true })
    expect(w.find('button').attributes('disabled')).toBeDefined()
  })

  test('QP-08: 纯推送的 tooltip 不再要提交信息', async () => {
    mockGitStore.branchAhead = 2
    const w = mountBtn()
    expect(tooltipOf(w)).toBe('@2E184:本地已提交，一键推送到远程仓库')
  })

  test('QP-09: 纯推送的副标题说的是推送,不是「暂存 + 提交 + 推送」', async () => {
    mockGitStore.branchAhead = 2
    const pushOnly = mountBtn()
    expect(pushOnly.find('.one-push-desc').text()).toBe('@2E184:推送到远程仓库')

    mockGitStore.branchAhead = 0
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const withChanges = mountBtn({ hasUserCommitMessage: true })
    expect(withChanges.find('.one-push-desc').text()).toBe('@2E184:暂存 + 提交 + 推送')
  })
})
