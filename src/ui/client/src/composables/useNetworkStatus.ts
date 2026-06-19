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
 * OPT-5 全局网络状态 composable
 *
 * 设计目标:
 * - 拦截全局 fetch,失败时记录错误,UI 上展示横幅
 * - 不重复实现 fetch 替换(避免劫持过深),仅 patch 一次并保留原引用
 * - 监听浏览器 online/offline 事件,作为兜底
 * - 恢复后自动清除错误状态,横幅消失
 *
 * 为什么在 composable 里挂载而不是在 main.ts?
 * - App.vue 已在 onMounted 调 useNetworkStatus(),可以保证只 patch 一次
 * - 卸载时调用 stop() 还原,便于热更新不残留
 */
import { ref, readonly } from 'vue'
import { $t } from '@/lang/static'

const isOnline = ref(true)
const lastError = ref<string | null>(null)
const lastErrorAt = ref<number>(0)
const isDismissed = ref(false)

let patched = false
let originalFetch: typeof fetch | null = null
let boundOnlineHandler: (() => void) | null = null
let boundOfflineHandler: (() => void) | null = null

// 解析错误信息的 helper:从 fetch reject 的 error / Response 提取一句话
function describeError(error: unknown, response?: Response | null): string {
  if (response && !response.ok) {
    return `HTTP ${response.status} ${response.statusText || ''}`.trim()
  }
  if (error instanceof Error) {
    // TypeError: Failed to fetch / NetworkError when fetch fails entirely
    if (error.name === 'TypeError' && /fetch/i.test(error.message)) {
      return $t('@NET:网络连接失败')
    }
    return error.message
  }
  return String(error)
}

// 用户点击"重试"时调用:重发最近一次失败请求(若有)
const lastFailedRequest = ref<{ url: string; init?: RequestInit } | null>(null)

async function retryLast(): Promise<boolean> {
  const last = lastFailedRequest.value
  if (!last || !originalFetch) return false
  try {
    const resp = await originalFetch(last.url, last.init)
    if (resp.ok) {
      // 成功:清除错误
      isOnline.value = true
      lastError.value = null
      isDismissed.value = false
      return true
    }
    lastError.value = describeError(null, resp)
    return false
  } catch (e) {
    lastError.value = describeError(e)
    return false
  }
}

function dismiss() {
  // 手动关闭:只清 dismiss flag,新错误还会再次出现
  isDismissed.value = true
}

function start() {
  if (patched || typeof window === 'undefined') return

  originalFetch = window.fetch.bind(window)

  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : (input as URL).toString()
    try {
      const response = await originalFetch!(input, init)
      // 5xx 视为网络/后端故障(同样提示)
      if (!response.ok && response.status >= 500) {
        isOnline.value = false
        lastError.value = describeError(null, response)
        lastErrorAt.value = Date.now()
        lastFailedRequest.value = { url, init }
      } else if (response.ok) {
        // 成功请求:清空错误,允许 shouldShow 重新求值
        // 注意:不在这里重置 isDismissed —— 用户主动关闭的语义是"这次别再烦我",
        // 必须等用户下次再遇到故障再显示。重置会让后台成功的请求把已关掉的横幅重新拉出来。
        if (!isOnline.value) {
          isOnline.value = true
        }
        lastError.value = null
        lastErrorAt.value = 0
      }
      return response
    } catch (error) {
      isOnline.value = false
      lastError.value = describeError(error)
      lastErrorAt.value = Date.now()
      lastFailedRequest.value = { url, init }
      throw error
    }
  }

  boundOnlineHandler = () => {
    isOnline.value = true
    // 不立即清 lastError,等下一次成功请求再清
  }
  boundOfflineHandler = () => {
    isOnline.value = false
    lastError.value = $t('@NET:浏览器报告离线')
    lastErrorAt.value = Date.now()
  }
  window.addEventListener('online', boundOnlineHandler)
  window.addEventListener('offline', boundOfflineHandler)

  patched = true
}

function stop() {
  if (!patched) return
  if (originalFetch) {
    window.fetch = originalFetch
  }
  if (boundOnlineHandler) window.removeEventListener('online', boundOnlineHandler)
  if (boundOfflineHandler) window.removeEventListener('offline', boundOfflineHandler)
  patched = false
  originalFetch = null
  boundOnlineHandler = null
  boundOfflineHandler = null
}

export function useNetworkStatus() {
  return {
    isOnline: readonly(isOnline),
    lastError: readonly(lastError),
    lastErrorAt: readonly(lastErrorAt),
    isDismissed: readonly(isDismissed),
    lastFailedRequest: readonly(lastFailedRequest),
    start,
    stop,
    retryLast,
    dismiss,
  }
}
