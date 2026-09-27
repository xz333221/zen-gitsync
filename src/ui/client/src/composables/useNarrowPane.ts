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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

/**
 * 会话列表与对话**左右并排**所需的最小宽度。
 *
 * 构成：左侧会话栏（默认 280，用户可拖到 200） + 右侧对话区（气泡 + 输入框的可用下限约 400）。
 * 取 280 + 400 = 680：低于它就别硬撑两栏了，折成两页（先列表、点进去看对话）。
 *
 * 注意：这个数字只对「真的左右并排」的形态成立（目前只有 AgentView）。
 * 面板那种"列表压在上面 + 对话在下面"的堆叠布局，无论多宽都在抢对话的高度，
 * 不该拿它当判据 —— 所以文件空间那块面板是**恒两页**，压根不参与这里的判断。
 */
export const PANE_SPLIT_MIN_WIDTH = 680

export interface UseNarrowPaneReturn {
  /** 容器当前宽度；0 = 还没量到（未挂载 / 环境不支持 ResizeObserver） */
  width: Readonly<Ref<number>>
  /** 是否需要折成两页 */
  narrow: Readonly<Ref<boolean>>
}

/**
 * 观察**容器自身**的宽度，判断对话面板该不该折成两页。
 *
 * 为什么不用视口宽度（`matchMedia` / `window.innerWidth`）：要折行的不是窗口，是容器本身。
 * 容器可能被侧栏 / 分屏 / 用户拖拽挤压，跟窗口宽度没有固定关系。所以宽度必须从容器上量。
 *
 * 宽度为 0 时一律按**宽屏**处理（`narrow === false`）：这是"还没量到"的信号，
 * 尤其 jsdom（vitest）里 ResizeObserver 是空实现，永远量不到宽度 —— 若把 0 当窄屏，
 * 所有单测都会看到一个与现实相反的默认布局。
 */
export function useNarrowPane(
  el: Ref<HTMLElement | null>,
  breakpoint: number = PANE_SPLIT_MIN_WIDTH
): UseNarrowPaneReturn {
  const width = ref(0)
  let ro: ResizeObserver | null = null

  /** 量一次并把 observer 挂上；根节点还没就位时返回 false */
  function attach(): boolean {
    const node = el.value
    if (!node) return false
    width.value = node.clientWidth
    if (typeof ResizeObserver === 'undefined') return true
    ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      // contentRect 在部分实现里可能缺字段，缺了就不动，避免把已有宽度抹成 undefined
      if (typeof w === 'number') width.value = w
    })
    ro.observe(node)
    return true
  }

  onMounted(() => {
    if (attach()) return
    // 根节点偶尔要等一帧才拿得到（父级 v-if / v-show 的时序）。
    // 这里**不能直接 return** —— 那样连 observer 都不会建，宽度会永久停在 0，
    // 表现为"怎么都不折行"，而且完全没有报错可查。
    nextTick(() => attach())
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
  })

  const narrow = computed(() => width.value > 0 && width.value < breakpoint)

  return { width, narrow }
}
