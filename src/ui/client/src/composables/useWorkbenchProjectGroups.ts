import { ref, computed, watch } from 'vue'
import type { Ref } from 'vue'
import { $t } from '@/lang/static'
import { canonicalProjectPath } from '@/utils/path'
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
      // 盘符大小写归一:历史数据里同一目录可能同时存在 e:\ 与 E:\ 两种写法,
      // 不归一会被拆成两个分组(详见 canonicalProjectPath 注释)
      const key = canonicalProjectPath(t.projectPath) || NO_PROJECT_KEY
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(t)
    }
    // 每个项目独立成组:当前项目排最前,未关联项目排最后,其余按路径字母序
    const cur = canonicalProjectPath(currentProject.value.path)
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
      // 只有一组时默认不渲染组头(任务平铺,当前项目下没有多余的组名噪音)。
      // 例外:这唯一一组正处于收起状态时必须把组头露出来 —— 组头是唯一的展开入口,
      // 不渲染就会出现"侧边栏一条任务都没有、也没东西可点开"的假空列表
      // (例如切换工作目录到新项目后,列表里只剩上一个项目的任务,而它被自动收起)。
      hasMultiple: keys.length > 1 || (keys.length === 1 && collapsedGroupPaths.value.has(keys[0]))
    }
  })

  function shortProjectLabel(fullPath: string): string {
    if (!fullPath || fullPath === NO_PROJECT_KEY) return fullPath
    const parts = fullPath.split(/[\\/]/).filter(Boolean)
    if (parts.length <= 1) return fullPath
    return parts.slice(-2).join('/')
  }

  // 新出现的项目分组:非当前项目默认收起(用户手动展开/收起过就记进 seen,不再自动改)。
  // 依赖里必须带上当前项目路径——loadTasks 与 loadCurrentProject 是并发请求,任务可能先到,
  // 这时 cur 还是空串;若此刻就给分组做判定,会把"当前项目"当成别人家的项目收起来,
  // 而且 seen 已经落盘,之后永远不会重新判定 → 表现为首屏侧边栏整组收起 / 看着一条任务都没有。
  const groupPathsKey = computed(() =>
    `${canonicalProjectPath(currentProject.value.path)}|${groupedTasksList.value.groups.map(g => g.path).join('\n')}`
  )
  watch(
    groupPathsKey,
    () => {
      const cur = canonicalProjectPath(currentProject.value.path)
      // 当前项目还没加载出来:先不判定,等它到了 key 变化会再跑一次
      if (!cur) return
      const next = new Set(collapsedGroupPaths.value)
      const seen = new Set(seenGroupPaths.value)
      let changed = false
      for (const g of groupedTasksList.value.groups) {
        if (seen.has(g.path)) continue
        seen.add(g.path)
        if (g.path !== cur) {
          next.add(g.path)
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
