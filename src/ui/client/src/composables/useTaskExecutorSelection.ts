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
// 「这一条任务交给谁跑」的**全局共享**选择（claude / opencode / codex）。
//
// 为什么必须是 composable 而不是各自一个 ref：工作台执行按钮、看板卡片「执行」、
// 主 Agent 控制台的派发栏与对话派发 —— 四处都要读同一份选择，且切了互相跟手。
// 这份共享过去靠 utils/taskExecutor 的 localStorage，四个调用点各读一次；
// 但 GUI 每次启动都换一个随机端口（src/ui/server/utils/startServerOnAvailablePort.js ——
// 端口被占就往后找一个），浏览器按 origin（协议+主机+**端口**）隔离 localStorage，
// 于是每开一次应用就是一个新桶，"记住上次"从来没生效过。
// 现在落 ~/.zen-gitsync/config.json 的 ui.lastTaskExecutor（见 configStore.setLastTaskExecutor），
// 顺带拿到两样 localStorage 给不了的东西：
//   1. **响应式**——config 是异步加载的，computed 会在配置到货后自己跟上，
//      不用各调用点自己补 watch 去同步初值；
//   2. **真正共享**——localStorage 的写入别的组件看不见（要刷新才跟手），
//      走同一个 store ref 则是同一份内存。
//
// 三个值的区别，别混用：
//   selected —— 「上次用过/选过的那个」，**可写**，赋值即落盘。设置项本身。
//   active   —— 界面上真正显示 / 派发用的那个 = selected 叠加"没装就换一个"。
//   choose() —— 用户在下拉里显式选（没装的不给选，否则后端 spawn ENOENT）。
import { computed } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import { useToolsStore } from '@/stores/toolsStore'
import { TASK_EXECUTOR_OPTIONS, isTaskExecutorId, type TaskExecutorId } from '@/utils/taskExecutor'

export function useTaskExecutorSelection() {
  const configStore = useConfigStore()
  const toolsStore = useToolsStore()

  /**
   * 「上次用过/选过的那个」。取值链：ui.lastTaskExecutor → 设置里的 taskExecutor
   * → 'claude'（最后一跳由 configStore 加载期的白名单校验兜底）。
   *
   * 刻意**不**在这里做"没装就换一个"：那是环境状态，不是用户的选择。
   */
  const selected = computed<TaskExecutorId>({
    get: () => configStore.resolvedTaskExecutor,
    set: (id) => { if (isTaskExecutorId(id)) void configStore.setLastTaskExecutor(id) },
  })

  /** 本机装了哪些执行器。toolsStore 启动即检测，检出之前全是 false */
  const availability = computed<Record<TaskExecutorId, boolean>>(() => ({
    claude: toolsStore.claudeAvailable,
    opencode: toolsStore.opencodeAvailable,
    codex: toolsStore.codexAvailable,
  }))

  /** 有没有一个能跑的 —— 决定「执行任务」按钮显不显示 */
  const hasAnyExecutor = computed(() =>
    TASK_EXECUTOR_OPTIONS.some(o => availability.value[o.id])
  )

  /**
   * 界面上显示 / 派发真正用的那个：上次用过 →（它没装的话）任一可用的。
   *
   * 回落是**纯计算**，不写回 selected：卸载了 claude 是一次性的环境状态，
   * 把它记成"上次用过"就会盖掉用户真正的上次，等 claude 装回来时也回不去。
   * 纯计算还顺带替掉了各调用点原先的 `watch(availability)` 纠偏 —— 工具检测
   * 结果什么时候到、什么时候变，这里都会自己重算。
   *
   * 一个都没装时不换：让后端报 spawn 失败，比界面悄悄显示成一个跑不了的执行器好。
   */
  const active = computed<TaskExecutorId>(() => {
    if (availability.value[selected.value]) return selected.value
    const fallback = (Object.keys(availability.value) as TaskExecutorId[])
      .find(id => availability.value[id])
    return fallback ?? selected.value
  })

  /** 用户在下拉里显式选了哪个。没装的不接（点了也跑不起来） */
  function choose(id: TaskExecutorId) {
    if (!availability.value[id]) return
    selected.value = id
  }

  /**
   * 下拉项右侧的模型名。空串 = 还没探测到 / 该 CLI 没配模型 —— 渲染时整块跳过，
   * 别显示成"未在配置中指定"（那是撒谎，事实只是还没问到，见 ExecutorModelState）。
   */
  function executorModelText(id: TaskExecutorId): string {
    return toolsStore.executorModelText(id)
  }

  /** 模型 + 次要信息（claude 的 CLI 别名 / 服务商），title 用 */
  function executorModelTitle(id: TaskExecutorId): string {
    return [executorModelText(id), toolsStore.executorModelDetail(id)].filter(Boolean).join(' · ')
  }

  return { selected, active, availability, hasAnyExecutor, choose, executorModelText, executorModelTitle }
}
