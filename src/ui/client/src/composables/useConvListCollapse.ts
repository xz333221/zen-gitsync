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
import { ref } from 'vue'

/**
 * 会话列表「收起 / 展开」的唯一那份状态。
 *
 * 为什么不是三个组件各写一份：会话列表在**三个入口**里是同一个东西（智能体视图的侧栏、
 * 主 Agent 控制台的左列、文件空间 g ai 面板的左列），"我把会话列表收起来了"是用户的
 * 一条偏好，不是三个页面各自的版面参数。各写一份的后果不是"默认值不一样"，而是
 * **在 A 处收了、切到 B 处又弹回来** —— 用户会以为没生效。
 *
 * 模块级 ref：三个入口共用同一个响应式源，任何一处翻转让其余两处当场跟着变
 * （它们不会同屏出现，所以看不到"联动"，只是不会各说各话）。
 *
 * 折叠本身由组件库的 ConversationList 负责（工具条右端的收起按钮 + 收起后的收纳条），
 * 宿主只做两件事：把状态存下来、把列宽收掉。列宽数值见各宿主的 CSS（`.is-collapsed` 一族）。
 */
const STORAGE_KEY = 'agent.convListCollapsed.v1'

/** 默认展开：收起是"我要腾地方"的临时决定，不该是所有人第一次进来看到的形态 */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    /* localStorage 不可用（隐私模式等）→ 当作没收起 */
    return false
  }
}

const convListCollapsed = ref(readCollapsed())

/**
 * 会话列表折叠态。`convListCollapsed` 直接绑给 `ConversationList` 的
 * `:collapsed` / `@update:collapsed`（或 `v-model:collapsed`）。
 */
export function useConvListCollapse() {
  function setConvListCollapsed(next: boolean) {
    convListCollapsed.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      /* 写不进去也不影响本次使用，只是下次启动回到默认 */
    }
  }

  return { convListCollapsed, setConvListCollapsed }
}
