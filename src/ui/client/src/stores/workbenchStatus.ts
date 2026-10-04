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
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// 跨组件共享的 Workbench「活跃执行」数：ActivityBar 读它显示工作台图标角标。
//
// **写者只有一个**：useOrchestrator 每次拉到 /api/workbench/orchestrator 后写 running.length。
// 这一个数就是看板表头那个「活跃执行」——服务端 buildRunningAgents 的口径（running | pending，
// 含别的 g ui 实例正在跑的 job），所以左栏角标与表头永远同源同值。
//
// 以前这里是"客户端本地 jobs 数组里 status === 'running' 的条数"，与表头差三处：
// 漏 pending、漏别的实例起的 job（SSE 的 bus 是进程内的）、且只在打开工作台那一刻取过一次快照。
// 2026-10-04 用户截图里左栏 2 / 表头 3 就是这么来的 —— 别再往回改成本地数。
export const useWorkbenchStatusStore = defineStore('workbenchStatus', () => {
  const runningCount = ref(0)

  function setRunning(n: number) {
    runningCount.value = Math.max(0, n | 0)
  }

  const hasRunning = computed(() => runningCount.value > 0)

  return { runningCount, hasRunning, setRunning }
})
