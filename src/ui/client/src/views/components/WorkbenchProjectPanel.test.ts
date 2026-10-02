// WorkbenchProjectPanel.vue · 左栏项目列表「从清单移除」这一组契约。
//
// 覆盖的是**这一行的操作区**随 exists 三态怎么变 —— 它曾经整块 v-if 掉，
// 于是"目录不存在"那一行一颗按钮都没有：用户看得见这行是死的，却没有任何办法清掉它。
//   R1 exists === false -> 只给「从清单移除」，一个打开动作都不给（点了只会报"无法打开目录"）
//   R2 exists !== false -> 照旧「打开文件夹」+「打开方式」，**不出现**移除按钮
//   R3 点移除 -> 弹确认框；确认后才 emit('remove')，载荷就是那一行的 project
//   R4 点取消 -> 什么都不 emit（没有退路的动作不能一按就生效）
//   R5 .stop 仍然生效：按钮上的点击不许冒泡成"选中这一行"
//   R6 确认文案里必须出现任务条数（用户按下这颗按钮时最怕顺手清了历史）
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { ElMessageBox } from 'element-plus'

import WorkbenchProjectPanel from './WorkbenchProjectPanel.vue'
import { mountWithSetup } from '@/test-utils/mount'
import type { ProjectSummary } from '@/types/workbench'

const stats = (over: any = {}) => ({
  total: 0, todo: 0, doing: 0, done: 0, progress: 0, runningJobs: 0, lastActiveAt: null, ...over,
})

const git = (over: any = {}) => ({
  isGitRepo: true, branch: 'main', upstream: null, hasUpstream: false, detached: false,
  ahead: 0, behind: 0, changed: 0, staged: 0, unstaged: 0, untracked: 0, ...over,
})

const proj = (over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  path: 'C:\\ws\\demo',
  key: 'c:\\ws\\demo',
  name: 'demo',
  source: 'recent',
  isCurrent: false,
  exists: true,
  git: git(),
  stats: stats(),
  ...over,
})

function mountPanel(projects: ProjectSummary[]) {
  return mountWithSetup(WorkbenchProjectPanel, {
    props: { projects, selectedKey: '', loading: false },
    global: { stubs: { SvgIcon: true, ToolInstallDialog: true } },
  })
}

/** 按项目名找到那一行的 DOM（.proj-item 里排除「全部项目」那一行） */
function rowOf(wrapper: any, name: string): HTMLElement | null {
  const rows = Array.from(wrapper.element.querySelectorAll('.proj-item')) as HTMLElement[]
  return rows.find(
    n => !n.classList.contains('proj-item--all')
      && n.querySelector('.proj-item__name')?.textContent?.trim() === name,
  ) ?? null
}

describe('WorkbenchProjectPanel · 从清单移除', () => {
  beforeEach(() => {
    vi.mocked(ElMessageBox.confirm).mockReset()
    vi.mocked(ElMessageBox.confirm).mockResolvedValue('confirm' as any)
  })

  test('R1 目录不存在：只给移除按钮，没有任何打开动作', () => {
    const w = mountPanel([
      proj({ name: 'gone', path: 'C:\\ws\\gone', key: 'c:\\ws\\gone', exists: false, git: git({ branch: 'main' }) }),
    ])
    const row = rowOf(w, 'gone')!
    const btns = row.querySelectorAll('.proj-item__action')
    expect(btns).toHaveLength(1)
    expect(btns[0].classList.contains('proj-item__action--danger')).toBe(true)
    // 打开方式菜单（el-popover 的 reference 按钮）也不该在
    expect(row.querySelector('.el-tooltip__trigger')).toBeNull()
    // 「目录不存在」那一行仍然是唯一的事实陈述，不能被操作区挤掉
    expect(row.querySelector('.proj-chip--missing')).toBeTruthy()
  })

  test('R2 目录还在：照旧是打开文件夹 + 打开方式，没有移除按钮', () => {
    const w = mountPanel([proj({ name: 'alive' })])
    const row = rowOf(w, 'alive')!
    expect(row.querySelector('.proj-item__action--danger')).toBeNull()
    // 「打开方式」的按钮是 el-popover 的 reference，Element Plus 会把原 button 上的
    // aria-* 换成它自己那份（实测 aria-haspopup 不会被透传），所以按数量与
    // el-tooltip__trigger 这个 class 认它，不去赌属性透传。
    expect(row.querySelectorAll('.proj-item__action')).toHaveLength(2)
    expect(row.querySelector('.el-tooltip__trigger')).toBeTruthy()
  })

  test('R3 点移除：弹确认框，确认后 emit remove 且载荷就是这一行', async () => {
    const target = proj({ name: 'gone', path: 'C:\\ws\\gone', key: 'c:\\ws\\gone', exists: false })
    const w = mountPanel([target])
    const btn = rowOf(w, 'gone')!.querySelector('.proj-item__action--danger') as HTMLElement
    btn.click()
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1))
    await w.vm.$nextTick()
    const emitted = w.emitted('remove') || []
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0]).toMatchObject({ path: 'C:\\ws\\gone', name: 'gone' })
  })

  test('R4 取消：什么都不 emit', async () => {
    vi.mocked(ElMessageBox.confirm).mockRejectedValue('cancel' as any)
    const w = mountPanel([proj({ name: 'gone', exists: false })])
    ;(rowOf(w, 'gone')!.querySelector('.proj-item__action--danger') as HTMLElement).click()
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1))
    await w.vm.$nextTick()
    expect(w.emitted('remove')).toBeFalsy()
  })

  test('R5 按钮上的点击不冒泡成"选中这一行"', async () => {
    const w = mountPanel([proj({ name: 'gone', exists: false })])
    ;(rowOf(w, 'gone')!.querySelector('.proj-item__action--danger') as HTMLElement).click()
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1))
    expect(w.emitted('select')).toBeFalsy()
  })

  test('R6 确认文案把"任务不会被删"和条数说出来', async () => {
    const w = mountPanel([
      proj({ name: 'gone', exists: false, stats: stats({ total: 9, done: 8, todo: 1, progress: 89 }) }),
    ])
    ;(rowOf(w, 'gone')!.querySelector('.proj-item__action--danger') as HTMLElement).click()
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1))
    const msg = String(vi.mocked(ElMessageBox.confirm).mock.calls[0][0])
    expect(msg).toContain('@WORKBENCH:移除项目')
    expect(msg).toContain('{name}')
    expect(msg).toContain('{n}')
  })

  test('R7 一个任务都没有时不谎报影响面（不出现 {n} 那句）', async () => {
    const w = mountPanel([proj({ name: 'gone', exists: false, stats: stats() })])
    ;(rowOf(w, 'gone')!.querySelector('.proj-item__action--danger') as HTMLElement).click()
    await vi.waitFor(() => expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1))
    const msg = String(vi.mocked(ElMessageBox.confirm).mock.calls[0][0])
    expect(msg).not.toContain('{n}')
  })
})