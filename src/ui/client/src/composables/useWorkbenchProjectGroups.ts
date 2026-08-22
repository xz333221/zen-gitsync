import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { $t } from '@/lang/static'
import { canonicalProjectPath } from '@/utils/path'
import type { Task } from '@/types/workbench'

const NO_PROJECT_KEY = '__no_project__'
// 非当前项目的所有任务统一收纳进这个虚拟分组(默认收起,用户展开后记住选择)
export const OTHER_PROJECTS_KEY = '__other_projects__'
const COLLAPSED_STORAGE_KEY = 'wb.collapsedGroupPaths.v1'
const SEEN_STORAGE_KEY = 'wb.seenGroupPaths.v1'

function readStringSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr.filter((x: unknown) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function writeStringSet(key: string, s: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(s)))
  } catch {
    /* quota / privacy mode 都不阻塞 UI */
  }
}

export function useWorkbenchProjectGroups(tasks: Ref<Task[]>, currentProject: Ref<{ path: string; name: string }>) {
  const collapsedGroupPaths = ref<Set<string>>(readStringSet(COLLAPSED_STORAGE_KEY))
  const seenGroupPaths = ref<Set<string>>(readStringSet(SEEN_STORAGE_KEY))

  watch(collapsedGroupPaths, (s) => writeStringSet(COLLAPSED_STORAGE_KEY, s), { deep: false })
  watch(seenGroupPaths, (s) => writeStringSet(SEEN_STORAGE_KEY, s), { deep: false })

  function isGroupCollapsed(path: string): boolean {
    return collapsedGroupPaths.value.has(path)
  }
  function toggleGroupCollapsed(path: string) {
    if (collapsedGroupPaths.value.has(path)) collapsedGroupPaths.value.delete(path)
    else collapsedGroupPaths.value.add(path)
    collapsedGroupPaths.value = new Set(collapsedGroupPaths.value)
    const seen = new Set(seenGroupPaths.value)
    seen.add(path)
    seenGroupPaths.value = seen
  }

  const groupedTasksList = computed(() => {
    const cur = canonicalProjectPath(currentProject.value.path)
    const currentTasks: Task[] = []
    const otherTasks: Task[] = []
    for (const t of tasks.value) {
      // 盘符大小写归一:历史数据里同一目录可能同时存在 e:\ 与 E:\ 两种写法,
      // 不归一会被拆成两个分组(详见 canonicalProjectPath 注释)
      const key = canonicalProjectPath(t.projectPath)
      // 当前项目独立成组;其余(别的项目 + 未关联项目)全部收纳进「其他项目」
      if (cur && key === cur) currentTasks.push(t)
      else otherTasks.push(t)
    }
    const groups: { path: string; label: string; tasks: Task[] }[] = []
    if (cur && currentTasks.length) groups.push({ path: cur, label: cur, tasks: currentTasks })
    if (otherTasks.length) groups.push({ path: OTHER_PROJECTS_KEY, label: $t('@WORKBENCH:其他项目'), tasks: otherTasks })
    return {
      groups,
      // 只剩「其他项目」一组时也要渲染组头,否则任务会平铺出来、默认收起失效
      hasMultiple: groups.length > 1 || (groups.length === 1 && groups[0].path === OTHER_PROJECTS_KEY)
    }
  })

  function shortProjectLabel(fullPath: string): string {
    if (!fullPath || fullPath === NO_PROJECT_KEY) return fullPath
    const parts = fullPath.split(/[\\/]/).filter(Boolean)
    if (parts.length <= 1) return fullPath
    return parts.slice(-2).join('/')
  }

  watch(
    () => groupedTasksList.value.groups.map(g => g.path),
    (paths) => {
      const cur = canonicalProjectPath(currentProject.value.path)
      const next = new Set(collapsedGroupPaths.value)
      const seen = new Set(seenGroupPaths.value)
      let changed = false
      for (const p of paths) {
        if (seen.has(p)) continue
        seen.add(p)
        if (p !== cur) {
          next.add(p)
          changed = true
        }
      }
      if (changed) collapsedGroupPaths.value = next
      seenGroupPaths.value = seen
    },
    { immediate: true }
  )

  return {
    groupedTasksList,
    isGroupCollapsed,
    toggleGroupCollapsed,
    shortProjectLabel
  }
}
