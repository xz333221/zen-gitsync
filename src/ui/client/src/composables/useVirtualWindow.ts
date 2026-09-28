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
/**
 * 窗口计算的 Vue 封装（列表视图 / 树状视图共用）。
 *
 * - 只渲染视口 ± overscan 内的行；
 * - **滚动容器是外层**（GitStatus 的 .file-list-container），本 composable 只往上找
 *   最近的滚动祖先并监听它，自身不滚动；
 * - 行高由调用方的 `heightOf` 决定，必须是常量（见各自的 *_ROW_H 常量）。
 *
 * 用法：模板里 `<div ref="root">` 包一层 spacer（`:style="{height: totalHeight+'px'}"`），
 * 再把 visibleRows 里的每行绝对定位 `translateY(top)`。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { buildOffsets, findRowAtOffset } from '@/utils/virtualRows'

export interface VirtualRow<T> {
  row: T
  index: number
  top: number
}

export interface UseVirtualWindow<T> {
  /** 挂到模板里作为定位参考的根元素 */
  root: Ref<HTMLElement | null>
  /** 实际滚动容器（挂载后解析） */
  scroller: Ref<HTMLElement | null>
  visibleRows: Ref<VirtualRow<T>[]>
  totalHeight: Ref<number>
  /** 行集合高度变化后手动重算（一般不用调，watch 已处理） */
  syncMetrics: () => void
}

/**
 * @param rows    行数组（用 getter，props 变化也能拿到最新值）
 * @param heightOf 行高，必须是常量函数
 * @param overscanPx 视口外上下各多渲染的像素数
 */
export function useVirtualWindow<T>(
  rows: () => readonly T[],
  heightOf: (row: T) => number,
  overscanPx = 400,
): UseVirtualWindow<T> {
  const root = ref<HTMLElement | null>(null)
  const scroller = ref<HTMLElement | null>(null)
  const scrollTop = ref(0)
  const viewportHeight = ref(0)

  const offsets = computed(() => buildOffsets(rows(), heightOf))
  const totalHeight = computed(() => offsets.value[offsets.value.length - 1] || 0)

  const visibleRows = computed<VirtualRow<T>[]>(() => {
    const list = rows()
    if (!list.length) return []

    const offs = offsets.value
    const start = findRowAtOffset(offs, Math.max(0, scrollTop.value - overscanPx))
    const end = Math.min(list.length - 1, findRowAtOffset(offs, scrollTop.value + viewportHeight.value + overscanPx))

    const out: VirtualRow<T>[] = []
    for (let i = start; i <= end; i++) out.push({ row: list[i], index: i, top: offs[i] })
    return out
  })

  /** 往上找最近的滚动祖先（GitStatus 里就是 .file-list-container） */
  function resolveScrollParent(el: HTMLElement | null): HTMLElement | null {
    let node = el?.parentElement ?? null
    while (node) {
      const overflowY = getComputedStyle(node).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight) {
        return node
      }
      node = node.parentElement
    }
    return (document.scrollingElement as HTMLElement | null) ?? null
  }

  function syncMetrics() {
    const el = scroller.value
    if (!el) return
    viewportHeight.value = el.clientHeight
    scrollTop.value = el.scrollTop
  }

  function handleScroll() {
    const el = scroller.value
    if (el) scrollTop.value = el.scrollTop
  }

  let ro: ResizeObserver | null = null
  let rafId = 0

  function scheduleSync() {
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = 0
      syncMetrics()
    })
  }

  onMounted(() => {
    scroller.value = resolveScrollParent(root.value)
    scroller.value?.addEventListener('scroll', handleScroll, { passive: true })
    // 同步量一次视口高度：此刻还没绘制，能把首帧就填满视口的行渲染出来；
    // 用 rAF 会晚一帧 → 首帧只渲染 overscan 那几行、下方闪一下空白。
    syncMetrics()
    if (typeof ResizeObserver !== 'undefined' && scroller.value) {
      ro = new ResizeObserver(scheduleSync)
      ro.observe(scroller.value)
    }
  })

  onBeforeUnmount(() => {
    scroller.value?.removeEventListener('scroll', handleScroll)
    ro?.disconnect()
    ro = null
    if (rafId) cancelAnimationFrame(rafId)
  })

  // 行集合变化后总高会变，浏览器把 scrollTop 夹回有效范围时不一定触发 scroll 事件，
  // 这里主动同步一次，避免窗口停在旧位置。
  watch(rows, () => {
    nextTick(syncMetrics)
  })

  return { root, scroller, visibleRows, totalHeight, syncMetrics }
}
