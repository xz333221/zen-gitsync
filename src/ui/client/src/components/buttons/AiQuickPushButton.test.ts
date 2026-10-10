// AiQuickPushButton 单元测试。
// 核心断言:这颗按钮**不要求用户先手写提交信息**(这正是它存在的理由),
// 以及冲突 / 无上游 / 无事可做 / 生成中 的禁用分支。
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@stores/gitStore', () => ({ useGitStore: () => mockGitStore }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => mockConfigStore }))
vi.mock('@/utils/fileLock', () => ({ isFilePathLocked: vi.fn().mockReturnValue(false) }))

import AiQuickPushButton from './AiQuickPushButton.vue'
import { mockGitStore, mockConfigStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'

function mountBtn(props: Record<string, any> = {}) {
  return mountWithSetup(AiQuickPushButton, { props })
}

describe('AiQuickPushButton.vue', () => {
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
    mockConfigStore.lockedFiles = []
  })

  afterEach(() => {
    // 不要 vi.restoreAllMocks():会清掉 setup.ts 的 matchMedia mock
  })

  test('AIQ-01: 有变更但用户没写提交信息 → 仍可点击(与一键推送的关键差异)', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeTruthy()
  })

  test('AIQ-02: 无上游分支 → 不 emit', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    mockGitStore.hasUpstream = false
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-03: 无变更且无领先提交 → 不 emit', async () => {
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-04: 无变更但有领先提交 → 可点击(纯推送,跳过 AI)', async () => {
    mockGitStore.branchAhead = 2
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeTruthy()
  })

  test('AIQ-05: 有冲突文件 → 不 emit', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    mockGitStore.hasConflictedFiles = true
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-06: 选择模式未勾选可暂存文件 → 不 emit', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    mockGitStore.isSelectionMode = true
    mockGitStore.selectedFiles = new Set()
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-07: 选择模式勾选了可暂存文件 → 可点击', async () => {
    mockGitStore.isSelectionMode = true
    mockGitStore.selectedFiles = new Set(['a.ts'])
    mockGitStore.selectedUnstagedPaths = ['a.ts']
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeTruthy()
  })

  test('AIQ-08: generating=true(AI 生成中) → 不重复触发', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn({ generating: true })
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-09: 推送中 → 不重复触发', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    mockGitStore.isPushing = true
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
  })

  test('AIQ-10: 锁定文件不算"有变更"', async () => {
    const { isFilePathLocked } = await import('@/utils/fileLock')
    vi.mocked(isFilePathLocked).mockReturnValue(true)
    mockGitStore.fileList = [{ path: 'locked.ts' }]
    const w = mountBtn()
    await w.find('button').trigger('click')
    expect(w.emitted('trigger')).toBeFalsy()
    vi.mocked(isFilePathLocked).mockReturnValue(false)
  })

  test('AIQ-11: 纯推送时副标题不再声称会「AI 生成信息」', async () => {
    mockGitStore.branchAhead = 2
    const pushOnly = mountBtn()
    expect(pushOnly.find('.one-ai-push-desc').text()).toBe('@2E184:本地已提交，直接推送')

    mockGitStore.branchAhead = 0
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const withChanges = mountBtn()
    expect(withChanges.find('.one-ai-push-desc').text()).toBe('@2E184:AI 生成信息 + 推送')
  })

  // ========== 生成阶段的按钮文案（2026-10-10）==========
  //
  // 用户要求「不要搞成全屏的，就在按钮上 loading 就行」—— 全屏 GlobalLoading 撤了之后，
  // 这一阶段的反馈只剩按钮自己：转圈 + 文案说明在做什么。这条文案是唯一的进度说明，
  // 掉了就退化成"一颗不知在干嘛的转圈按钮"。

  test('AIQ-12: generating=true → 标题改说「AI 正在生成提交信息…」且收掉副标题', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn({ generating: true })
    expect(w.find('.one-ai-push-title').text()).toBe('@2E184:AI 正在生成提交信息…')
    // 主标题已经说明白了,再挂一行「AI 生成信息 + 推送」是同一句话两遍
    expect(w.find('.one-ai-push-desc').text()).toBe('')
    expect(w.find('button').classes()).toContain('is-loading')
  })

  test('AIQ-13: 非 generating → 标题回到「AI 提交并推送」(反向对照)', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = mountBtn()
    expect(w.find('.one-ai-push-title').text()).toBe('@2E184:AI 提交并推送')
    expect(w.find('.one-ai-push-desc').text()).toBe('@2E184:AI 生成信息 + 推送')
    expect(w.find('button').classes()).not.toContain('is-loading')
  })
})
