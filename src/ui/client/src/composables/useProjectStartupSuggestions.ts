// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 「AI 启动建议」的状态机与请求逻辑 —— 从 ProjectStartupAiPanel.vue 抽出来的一份实现。
//
// 为什么要抽：这个能力现在有两个消费方 ——
//   · Git 视图左栏的「AI 启动建议」面板（分析**当前项目**，缺省路径）；
//   · 「项目管理」视图里逐个项目展开的那块（分析**指定项目**，要带 projectPath）。
// 两份实现意味着两处 analyze/launch/缓存键，改一处漏一处不会报错，只会让两个入口
// 给出的建议/行为悄悄分叉（与 useDirectoryOpenActions 抽出来的理由同源）。
//
// 缓存与去重全走 utils/projectStartupCache（key 已含项目路径，天然支持"分析任意项目"）：
// 同一个项目在多处展开只会问一次模型，切走再切回来直接命中缓存。
//
// 调用方负责"什么时候同步"：组件在 onMounted 调一次 sync() 即可 ——
// 挂在 `v-if="expanded"` 后面的面板因此天然是**展开才分析**（不展开就不花 token）。

import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import {
  dropStartupSuggestions,
  pendingStartupSuggestions,
  readStartupSuggestions,
  startupSuggestionsKey,
  trackPendingStartupSuggestions,
  writeStartupSuggestions,
  type StartupSuggestion,
} from '@/utils/projectStartupCache'

export type StartupStatus = 'idle' | 'loading' | 'done' | 'empty' | 'no-facts' | 'error' | 'no-model'

/**
 * 两个消费方要的"路径"其实是两件事，所以一次性都给出来：
 *   · cachePath  —— 进缓存键。**必须是真实目录**：SPA 切目录不刷新页面，
 *     key 里不带路径会把 A 项目的启动方式显示在 B 项目上（见 projectStartupCache）。
 *   · requestPath —— 进请求体。**只有"分析非当前项目"时才给**：
 *     不传时服务端分析当前项目（Git 视图那个面板的原行为，逐字不变）；
 *     传了会走"必须命中项目清单白名单"的校验 —— 当前项目万一路径不在清单里
 *     （被移除过），带上它反而会把原来能用的面板变成报错。
 */
export interface StartupPaths {
  cachePath: string
  requestPath?: string
}

/**
 * @param getPaths 取"分析哪个项目"。缺省场景传 () => ({ cachePath: configStore.currentDirectory })；
 *   「项目管理」视图传 () => ({ cachePath: props.projectPath, requestPath: props.projectPath })。
 *   用 getter 而不是字符串：路径会随视图状态变化（切目录 / 换行），传值会拿到 setup 那一刻的快照。
 */
export function useProjectStartupSuggestions(getPaths: () => StartupPaths) {
  const configStore = useConfigStore()

  type Status = StartupStatus

  const status = ref<Status>('idle')
  const suggestions = ref<StartupSuggestion[]>([])
  const errorText = ref('')
  const runningId = ref('')
  /** 本次会话里已经点过启动的条目 —— 只是视觉反馈,不进缓存 */
  const launchedIds = ref<Set<string>>(new Set())

  const hasModel = computed(() => Array.isArray(configStore.models) && configStore.models.length > 0)

  const locale = computed(() => (String(configStore.locale || '').startsWith('en') ? 'en' : 'zh'))
  const modelKey = computed(() => {
    const models = Array.isArray(configStore.models) ? configStore.models : []
    const model = models.find((m: any) => m?.isDefault) || models[0]
    return String(model?.model || model?.id || '')
  })
  /** 换目录 / 换语言 / 换模型都不能读到上一份 —— SPA 切目录不刷新页面,路径必须进 key */
  const cacheKey = computed(() => startupSuggestionsKey(getPaths().cachePath, locale.value, modelKey.value))

  let controller: AbortController | null = null
  let requestToken = 0

  function applyResult(list: StartupSuggestion[]) {
    suggestions.value = list
    launchedIds.value = new Set()
    status.value = list.length ? 'done' : 'empty'
  }

  /** 挂载 / 换目录时走这里:能命中缓存就直接换上,否则发起一次分析 */
  function sync() {
    if (!hasModel.value) {
      status.value = 'no-model'
      return
    }
    const key = cacheKey.value
    const cached = readStartupSuggestions(key)
    if (cached) {
      // 换 key 时先把在跑的那次作废(它的响应回来会覆盖掉这份命中缓存的旧结果)
      requestToken++
      applyResult(cached)
      return
    }
    const pending = pendingStartupSuggestions(key)
    if (pending) {
      // 另一个实例已经在问了(切目录后又切回来),挂上去等结果,不重复花一次模型调用
      status.value = 'loading'
      const token = ++requestToken
      void pending.then(() => {
        if (token !== requestToken) return
        applyResult(readStartupSuggestions(key) || [])
      })
      return
    }
    void analyze()
  }

  async function analyze() {
    if (!hasModel.value) {
      status.value = 'no-model'
      return
    }

    controller?.abort()
    const myController = new AbortController()
    controller = myController
    const token = ++requestToken
    const key = cacheKey.value
    const requestPath = getPaths().requestPath || ''
    status.value = 'loading'
    errorText.value = ''
    dropStartupSuggestions(key)

    const task = (async () => {
      try {
        const response = await fetch('/api/project-startup/suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // projectPath 只在"分析非当前项目"时才带 —— 不传时服务端走当前项目，
          // 与这个面板以前的请求体逐字一致（别顺手把空字符串也发出去）
          body: JSON.stringify(requestPath ? { locale: locale.value, projectPath: requestPath } : { locale: locale.value }),
          signal: myController.signal,
        })
        const result = await response.json().catch(() => null)
        if (token !== requestToken) return

        if (!result) {
          status.value = 'error'
          errorText.value = $t('@NPM02:分析失败，请稍后重试')
          return
        }

        if (result.success === false) {
          // NO_MODEL / NO_FACTS 是本地语义,用本地语义表达;其余(网关报错)原样带出 —— 那句话本身就是排查线索
          if (result.code === 'NO_MODEL') {
            status.value = 'no-model'
            return
          }
          if (result.code === 'NO_FACTS') {
            // 不是错误,是"这个目录压根没有能起的东西"
            status.value = 'no-facts'
            return
          }
          if (result.code === 'PROJECT_NOT_LISTED') {
            // 「项目管理」视图才对得上的语义：这个目录已经不在清单里了（在别处被移除），
            // 服务端拒绝分析。用本地文案说清楚，别把服务端那句直接抛给用户当报错。
            status.value = 'error'
            errorText.value = $t('@NPM02:这个目录已不在项目列表里')
            return
          }
          errorText.value = result.error || $t('@NPM02:分析失败，请稍后重试')
          status.value = 'error'
          return
        }

        const list = Array.isArray(result.suggestions) ? result.suggestions as StartupSuggestion[] : []
        writeStartupSuggestions(key, list)
        applyResult(list)
      } catch (error: any) {
        if (error?.name === 'AbortError') return
        if (token !== requestToken) return
        status.value = 'error'
        errorText.value = error?.message || $t('@NPM02:分析失败，请稍后重试')
      } finally {
        if (controller === myController) controller = null
      }
    })()

    trackPendingStartupSuggestions(key, task)
    await task
  }

  function markLaunched(id: string) {
    const next = new Set(launchedIds.value)
    next.add(id)
    launchedIds.value = next
  }

  async function launch(item: StartupSuggestion) {
    runningId.value = item.id
    try {
      if (item.kind === 'npm' && item.packagePath && item.scriptName) {
        const response = await fetch('/api/run-npm-script', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packagePath: item.packagePath, scriptName: item.scriptName }),
        })
        const result = await response.json().catch(() => null)
        if (result?.success) {
          markLaunched(item.id)
          ElMessage.success(`${$t('@NPM02:已在新终端中启动')}: ${item.command}`)
        } else {
          ElMessage.error(result?.error || $t('@NPM02:启动失败'))
        }
        return
      }

      // shell 类:命令是模型给的原话,执行前必须让用户过目
      try {
        await ElMessageBox.confirm(
          item.command,
          $t('@NPM02:确认在 {dir} 里执行这条命令？', { dir: item.cwdLabel || item.cwd || '.' }),
          {
            confirmButtonText: $t('@NPM02:执行'),
            cancelButtonText: $t('@NPM02:取消'),
            type: 'warning',
          }
        )
      } catch {
        return // 用户取消
      }

      const response = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: item.command, workingDirectory: item.cwd }),
      })
      const result = await response.json().catch(() => null)
      if (result?.success) {
        markLaunched(item.id)
        ElMessage.success(`${$t('@NPM02:已在新终端中启动')}: ${item.command}`)
      } else {
        ElMessage.error(result?.error || $t('@NPM02:启动失败'))
      }
    } catch (error: any) {
      ElMessage.error(`${$t('@NPM02:启动失败')}: ${error?.message || error}`)
    } finally {
      runningId.value = ''
    }
  }

  // 切工作目录 / 刚在设置里加完模型回来 —— hasModel 变了也要跟着换（与面板原来的口径一致）
  watch([cacheKey, hasModel], () => sync())

  return { status, suggestions, errorText, runningId, launchedIds, hasModel, cacheKey, sync, analyze, launch }
}
