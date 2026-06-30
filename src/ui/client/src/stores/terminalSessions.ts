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

// 跨组件共享的终端会话计数:
// CommandConsole 写入(每次拉取 /api/terminal-sessions 后同步),
// ActivityBar 读取以在"控制台"图标上显示脉动徽标(类比 Workbench runningCount)。
// 只存计数,不复制完整会话列表 —— 列表仍由 CommandConsole 本地 composable 管理避免双源。
export const useTerminalSessionsStore = defineStore('terminalSessions', () => {
  const count = ref(0)

  function setCount(n: number) {
    count.value = Math.max(0, n | 0)
  }

  const hasActive = computed(() => count.value > 0)

  return { count, hasActive, setCount }
})
