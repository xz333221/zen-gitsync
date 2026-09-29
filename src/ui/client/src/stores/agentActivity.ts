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

// 跨组件共享的「有多少条 g ai 对话正在生成」：
// useAgentChat 的每个消费方（智能体视图「对话」Tab / 文件空间面板 / 工作台主 Agent
// 控制台 / 常用目录追问区）各持一份独立实例，isStreaming 只活在自己那份 runs 里。
// ActivityBar 是它们共同的祖先，拿不到任何一份 —— 想在左侧机器人图标上显示
// "正在生成"的数字，就得有一处跨实例的登记处（口径与 workbenchStatus / terminalSessions 一致）。
//
// 口径 = 在登记的令牌数，一轮流一条。
// 用「令牌 + Set」而不是计数器 +1/-1：重复登记、重复销号都幂等，一轮流无论正常结束、
// 被中止、出错、还是被同一会话的下一轮顶掉，都不会把数字算错或漏减。
export const useAgentActivityStore = defineStore('agentActivity', () => {
  const activeTokens = ref<string[]>([])

  /** 一轮流开始时登记。返回是否真的新增（同一令牌重复登记返回 false） */
  function begin(token: string) {
    if (!token || activeTokens.value.includes(token)) return false
    activeTokens.value = [...activeTokens.value, token]
    return true
  }

  /** 一轮流结束时销号。返回是否真的移除（重复销号返回 false，不会把别人的轮次减掉） */
  function end(token: string) {
    if (!activeTokens.value.includes(token)) return false
    activeTokens.value = activeTokens.value.filter(t => t !== token)
    return true
  }

  const runningCount = computed(() => activeTokens.value.length)
  const hasRunning = computed(() => runningCount.value > 0)

  return { activeTokens, runningCount, hasRunning, begin, end }
})
