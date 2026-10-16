// QuickActionsDropdown 单元测试（2026-10-16 走查 P2-1：两颗「一键」并入「提交并推送 ▾」）。
//
// 守的契约：
//   QA-01 菜单项禁用/文案与引擎（原按钮）**同一口径** —— 由引擎 expose 驱动，不在下拉里复制判断
//   QA-02 点菜单项 = 走引擎动作（与直接点原按钮等价）
//   QA-03 纯推送的 desc 经引擎流出「推送到远程仓库」口径；点击只推不提交
//   QA-04 expose 的 triggerQuickPush 直通引擎（Enter 键 / AI 提交流程都靠这条链）
//
// ⚠️ EP 的 el-dropdown 在 jsdom 里不落 popper（实测 menu 恒不渲染；且给内层
// ElTooltip 套简易桩会把 popper-options 这类对象 props 漏成 DOM 属性直接抛错）。
// 所以这里按「契约桩」替换 EP 下拉家族：渲染两个 slot、把 item 点击转成 command
// 事件（与 EP 同口径：禁用项不派发）。开合动画/定位属 EP 自己的事，
// 由实机走查截图与探针兜底。
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

vi.mock('@stores/gitStore', () => ({ useGitStore: () => mockGitStore }))
vi.mock('@stores/configStore', () => ({ useConfigStore: () => mockConfigStore }))
vi.mock('@/utils/fileLock', () => ({ isFilePathLocked: vi.fn().mockReturnValue(false) }))

import QuickActionsDropdown from './QuickActionsDropdown.vue'
import { mockGitStore, mockConfigStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'

// 引擎里的 tooltip 只 stub 渲染；进度弹窗 stub 掉渲染、保留方法（见 QuickPushButton.test 的口径）
const tooltipStub = {
  props: ['content'],
  template: '<div class="tt" :data-content="content"><slot /></div>',
}
const progressStub = {
  template: '<div class="progress-stub" />',
  methods: { reset() {}, setPulling() {}, handleProgress() {} },
}

// el-dropdown 契约桩：默认 slot + dropdown slot 一起内联渲染（免 popper），
// 通过 provide/inject 把 item 的点击转成 dropdown 的 command 事件
const dropdownStub: any = {
  emits: ['command'],
  provide() {
    return { __ddEmit: (cmd: unknown) => this.$emit('command', cmd) }
  },
  template: '<div class="dd-stub"><slot /><div class="dd-menu-stub"><slot name="dropdown" /></div></div>',
}
const dropdownMenuStub = { template: '<div class="ddm-stub"><slot /></div>' }
const dropdownItemStub: any = {
  props: { disabled: Boolean, command: [String, Number, Object] },
  inject: ['__ddEmit'],
  emits: ['click'],
  methods: {
    onClick(this: any) {
      if (this.disabled) return // 与 EP 同口径：禁用项不派发
      this.$emit('click')
      this.__ddEmit(this.command)
    },
  },
  template: '<div class="ddi-stub" :data-disabled="disabled" @click="onClick"><slot /></div>',
}

// ⚠️ mount 后必须等一个 tick：引擎 ref 在 mount 阶段绑定，绑定触发的父级重渲染
// 落在下一个 tick —— 立刻断言会读到 ref 未就绪时的 `?? true` 兜底值。
const mountDd = async (props: Record<string, any> = {}) => {
  const w = mountWithSetup(QuickActionsDropdown, {
    props: { hasUserCommitMessage: true, finalCommitMessage: 'feat: x', ...props },
    global: {
      stubs: {
        ElTooltip: tooltipStub,
        PushProgressModal: progressStub,
        ElDropdown: dropdownStub,
        ElDropdownMenu: dropdownMenuStub,
        ElDropdownItem: dropdownItemStub,
      },
    },
  })
  await nextTick()
  return w
}

describe('QuickActionsDropdown.vue', () => {
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

  test('QA-01: 无变更无领先 → 两项都禁用；commit 项文案直接给出原因（引擎 tooltip 口径）；触发器 is-quiet', async () => {
    const w = await mountDd()
    const items = w.findAll('.ddi-stub')
    expect(items.length).toBe(2)
    expect(items[0].attributes('data-disabled')).toBe('true')
    expect(items[1].attributes('data-disabled')).toBe('true')
    // 禁用的原因来自引擎的 tooltipText（与按钮 hover 时看到的一致）
    expect(items[0].text()).toContain('@2E184:没有需要提交的更改')
    expect(w.find('.qa-trigger').classes()).toContain('is-quiet')
  })

  test('QA-02: 有变更+有提交信息 → commit 项可点，点击走「暂存 + 提交」引擎并透出 afterCommit', async () => {
    mockGitStore.fileList = [{ path: 'a.ts' }]
    const w = await mountDd()
    const items = w.findAll('.ddi-stub')
    expect(items[0].attributes('data-disabled')).toBe('false')
    await items[0].trigger('click')
    expect(mockGitStore.stageSelectedAndCommit).toHaveBeenCalledWith('feat: x', false)
    expect(w.emitted('afterCommit')).toBeTruthy()
  })

  test('QA-03: 纯推送 → push 项可点且文案走「推送到远程仓库」口径；点击只推不提交', async () => {
    mockGitStore.branchAhead = 2
    const w = await mountDd()
    const items = w.findAll('.ddi-stub')
    expect(items[1].attributes('data-disabled')).toBe('false')
    expect(items[1].text()).toContain('@2E184:推送到远程仓库')
    await items[1].trigger('click')
    expect(mockGitStore.addAndCommit).not.toHaveBeenCalled()
    expect(mockGitStore.pushToRemoteWithProgress).toHaveBeenCalled()
  })

  test('QA-04: expose 的 triggerQuickPush 直通引擎（Enter 键 / AI 提交链的独占入口）', async () => {
    mockGitStore.branchAhead = 2
    const w = await mountDd()
    await (w.vm as any).triggerQuickPush()
    expect(mockGitStore.pushToRemoteWithProgress).toHaveBeenCalled()
  })
})
