import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { $t } from '@/lang/static'
import type { Task } from '@/types/workbench'

const NO_PROJECT_KEY = '__no_project__'
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
    const list = tasks.value
    const groups = new Map<string, Task[]>()
    for (const t of list) {
      const raw = (t.projectPath || '').trim()
      const key = raw || NO_PROJECT_KEY
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }
    const cur = currentProject.value.path
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === cur) return -1
      if (b === cur) return 1
      if (a === NO_PROJECT_KEY) return 1
      if (b === NO_PROJECT_KEY) return -1
      return a.localeCompare(b)
    })
    return {
      groups: keys.map(path => ({
        path,
        label: path === NO_PROJECT_KEY ? $t('@WORKBENCH:未关联项目') : path,
        tasks: groups.get(path)!
      })),
      hasMultiple: keys.length > 1
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
      const cur = currentProject.value.path
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
