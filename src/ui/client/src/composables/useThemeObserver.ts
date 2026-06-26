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
import { ref, readonly, onBeforeUnmount, getCurrentInstance, type Ref } from 'vue'

export type Theme = 'light' | 'dark'

const THEME_ATTR = 'data-theme'

/** 从 <html data-theme="..."> 读当前主题,缺失 / 其它值都视作 light。 */
function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute(THEME_ATTR) === 'dark' ? 'dark' : 'light'
}

export interface UseThemeObserverReturn {
  /** 当前主题,只读响应式;初次值是同步从 DOM 读的,无需等待 mount。 */
  theme: Readonly<Ref<Theme>>
  /** 手动停掉 observer;在 setup() 里调用时 onBeforeUnmount 会自动调用,无需显式。 */
  stop: () => void
}

/**
 * 监听 <html data-theme="..."> 变化。
 *
 * 为什么抽 composable?
 * - App.vue / SourceMapView.vue / MonacoEditor.vue 之前各有自己的
 *   MutationObserver + sync 函数 + onBeforeUnmount disconnect 模板,
 *   三份 boilerplate 完全一致。
 * - 统一后,新增 "跟随主题响应" 的视图只需一行 `useThemeObserver((t) => ...)`。
 *
 * 两种用法:
 *
 * ```ts
 * // 响应式 — computed / watch 用 theme.value
 * const { theme } = useThemeObserver()
 * const dotColor = computed(() => theme.value === 'dark' ? '#334155' : '#cbd5e1')
 * ```
 *
 * ```ts
 * // 命令式 — 主题切换时直接执行副作用
 * useThemeObserver(() => applyTheme())
 * ```
 *
 * 注意:setup() 里调用即开始观察,onBeforeUnmount 自动 disconnect;若在 setup 之外
 * (如纯模块上下文)调用,需要手动 stop()。
 */
export function useThemeObserver(onChange?: (theme: Theme) => void): UseThemeObserverReturn {
  const theme = ref<Theme>(readTheme())

  let observer: MutationObserver | null = null
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      const next = readTheme()
      // 同值不触发回调,避免下游 watch / computed 无意义重算
      if (next !== theme.value) {
        theme.value = next
        onChange?.(next)
      }
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [THEME_ATTR],
    })
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => observer?.disconnect())
  }

  function stop() {
    observer?.disconnect()
    observer = null
  }

  return { theme: readonly(theme), stop }
}