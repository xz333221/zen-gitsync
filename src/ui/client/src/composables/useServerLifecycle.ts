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
 * 宿主服务端生命周期检测：服务端退出后关掉当前标签页，关不掉则显示全屏遮罩。
 *
 * 为什么需要「确认窗口」而不是收到信号就关：
 *   dev 下后端热重启同样会发 SIGINT/SIGTERM(即同样触发 server_shutdown 广播)，
 *   若直接关页面，每次改后端代码都会顺手关掉用户的标签页。所以无论从广播还是从
 *   socket 断连进入，都要先在一个时间窗内反复探测探针接口，探到新进程
 *   (pid 变化)或 socket 重新连上就取消，连续失败到阈值才判定服务端真的走了。
 *
 * 为什么探针用相对路径而不是 backendUrl(PROBE_PATH)：
 *   dev 下页面在 5544、后端在 5545，而 Express 路由不返回 CORS 头(只有 Socket.IO
 *   配了 cors)。直连后端属于跨源，浏览器会拦截响应读取，探针会恒失败。相对路径在
 *   生产同源、在 dev 走 vite 代理，后端死掉时代理会快速失败。
 *
 * 模块级单例(对齐 useNetworkStatus.ts)，不用 Pinia：避免给
 * InstanceSwitcher.test.ts 的 fakeStore 增加必需字段而打断既有用例。
 * 本模块刻意不 import instancesStore(避免循环引用)——停止轮询/socket 的收尾
 * 由 App.vue 监听 isServerGone 完成。
 */
import { ref, readonly } from 'vue'

// 探针路径。注意不能叫 /api/health：依赖中间件已占用该路径且注册更早会遮蔽它，
// 那样探针读不到 pid，热重启就识别不出来。见 server/routes/health.js。
const PROBE_PATH = '/api/instance-health'
const PROBE_INTERVAL_MS = 1000
const PROBE_TIMEOUT_MS = 2000
// 连续失败阈值：约 4s。给 nodemon 1-2s 的常见重启时长留出足够裕量。
const FAIL_THRESHOLD = 4
// 窗口绝对上限：即便探针一直返回「成功但不是我们」这种病态情况，也不无限等。
const WINDOW_MAX_MS = 8000
// window.close() 可用的判定窗口：与 InstanceSwitcher 的兜底保持一致。
const CLOSE_FALLBACK_MS = 250

const isServerGone = ref(false)
const serverGoneName = ref('')

let armed = false
let graceful = false
let boundPid: number | null = null
let failCount = 0
let confirmed = false
let probeTimer: number | null = null
let deadlineTimer: number | null = null
let closeTimer: number | null = null
let guardHandler: (() => void) | null = null

function clearProbeTimer() {
  if (probeTimer != null) {
    window.clearTimeout(probeTimer)
    probeTimer = null
  }
}

function clearDeadlineTimer() {
  if (deadlineTimer != null) {
    window.clearTimeout(deadlineTimer)
    deadlineTimer = null
  }
}

function detachGuard() {
  if (guardHandler && typeof window !== 'undefined') {
    window.removeEventListener('online', guardHandler)
    window.removeEventListener('visibilitychange', guardHandler)
  }
  guardHandler = null
}

// 合盖/断网/重新可见时把失败计数清零，避免睡醒后一次断网就把页面关掉。
function attachGuard() {
  if (guardHandler || typeof window === 'undefined') return
  guardHandler = () => {
    if (armed) failCount = 0
  }
  window.addEventListener('online', guardHandler)
  window.addEventListener('visibilitychange', guardHandler)
}

function scheduleProbe(delay: number) {
  clearProbeTimer()
  probeTimer = window.setTimeout(() => { void probeOnce() }, delay)
}

// 窗口上限到点。offline(合盖/拔网线)时不能据此关页面，顺延再等；
// 只有真正「能联网但探不到服务端」才允许超时兜底。
function onDeadline() {
  deadlineTimer = null
  if (!armed || confirmed) return
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    deadlineTimer = window.setTimeout(onDeadline, WINDOW_MAX_MS)
    return
  }
  confirmGone()
}

function stopProbing() {
  clearProbeTimer()
  clearDeadlineTimer()
  detachGuard()
  armed = false
}

/** 判定服务端确实已退出：先尝试关标签页，关不掉则在兜底延时后亮遮罩。 */
function confirmGone() {
  if (confirmed) return
  confirmed = true
  stopProbing()
  try { window.close() } catch (_) { /* 浏览器拦截手动打开的标签页,忽略 */ }
  if (closeTimer != null) window.clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    // 走到这里说明 window.close() 被拦截、页面仍存活 → 亮全屏遮罩，
    // 并由 App.vue 监听 isServerGone 停掉所有轮询/socket 重连。
    isServerGone.value = true
  }, CLOSE_FALLBACK_MS)
}

async function probeOnce(): Promise<void> {
  if (!armed || confirmed) return
  probeTimer = null

  // 浏览器报告离线(合盖/拔网线)：不计入失败，等 online/可见性变化后重置再继续。
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    scheduleProbe(PROBE_INTERVAL_MS)
    return
  }

  let ok = false
  let probedPid: number | null = null
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(PROBE_PATH, { cache: 'no-store', signal: controller.signal })
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { success?: boolean; pid?: number } | null
      if (data?.success) {
        ok = true
        probedPid = typeof data.pid === 'number' ? data.pid : null
      }
    }
  } catch (_) {
    ok = false
  } finally {
    window.clearTimeout(timeoutId)
  }

  if (!armed || confirmed) return

  if (ok) {
    const knownDifferent = probedPid != null && boundPid != null && probedPid !== boundPid
    if (knownDifferent) { cancel(); return }          // 新进程 → 后端热重启
    if (!graceful) { cancel(); return }               // 断连来源 + 服务端还活着 → 抖动/误报
    if (boundPid == null) { cancel(); return }        // 无法证明是我们的垂死进程 → 宁可不关
    // graceful + 同一 pid 仍存活：服务端正在 drain 子进程，继续探到它真正退出。
    scheduleProbe(PROBE_INTERVAL_MS)
    return
  }

  failCount++
  if (failCount >= FAIL_THRESHOLD) {
    confirmGone()
    return
  }
  scheduleProbe(PROBE_INTERVAL_MS)
}

/**
 * 进入确认窗口。已在窗口中则只补齐标志/绑定，不重复起定时器(幂等)——
 * disconnect 与 transport error 可能接连触发两次。
 */
function arm({ pid, name, graceful: fromBroadcast }: { pid: number | null; name?: string; graceful: boolean }) {
  if (confirmed) return
  if (armed) {
    if (fromBroadcast) graceful = true
    if (boundPid == null && pid != null) boundPid = pid
    if (!serverGoneName.value && name) serverGoneName.value = name
    return
  }
  armed = true
  graceful = fromBroadcast
  boundPid = pid ?? null
  if (name) serverGoneName.value = name
  failCount = 0
  attachGuard()
  scheduleProbe(0)
  deadlineTimer = window.setTimeout(onDeadline, WINDOW_MAX_MS)
}

/** 来自 server_shutdown 广播：服务端主动告知要退出(优雅关闭)。 */
function armGraceful(payload: { pid: number | null; name?: string }) {
  arm({ pid: payload.pid, name: payload.name, graceful: true })
}

/** 来自 socket disconnect：可能是强杀/崩溃，也可能是网络抖动。 */
function armDisconnect(payload: { pid: number | null; name?: string }) {
  arm({ pid: payload.pid, name: payload.name, graceful: false })
}

/** socket 重新连上 → 服务端还活着(或已重启)，取消判定。 */
function noteConnected() {
  cancel()
}

/** 取消当前确认窗口，但不清除已亮起的遮罩(可见即已是终态)。 */
function cancel() {
  if (confirmed) return
  stopProbing()
  graceful = false
  boundPid = null
  failCount = 0
}

/** 清空一切状态：HMR / 卸载 / 测试用。 */
function resetAll() {
  if (closeTimer != null) {
    window.clearTimeout(closeTimer)
    closeTimer = null
  }
  stopProbing()
  graceful = false
  boundPid = null
  failCount = 0
  confirmed = false
  isServerGone.value = false
  serverGoneName.value = ''
}

export function useServerLifecycle() {
  return {
    isServerGone: readonly(isServerGone),
    serverGoneName: readonly(serverGoneName),
    armGraceful,
    armDisconnect,
    noteConnected,
    cancel,
    resetAll,
  }
}
