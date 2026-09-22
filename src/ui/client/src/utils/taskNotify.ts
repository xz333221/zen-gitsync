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
// 浏览器（系统级）通知封装 —— 任务执行结束提示用。
//
// 为什么要单独一层，而不是在调用点直接 new Notification()：
//   1. 环境可能不支持（非安全上下文 / 老浏览器），`Notification` 引用本身就是 undefined；
//   2. 权限未授予时构造会抛 TypeError（有些浏览器是静默丢弃），调用点不该各自 try/catch；
//   3. 「页面在前台就别再弹系统窗口」这条策略要跟调用点分开 —— 那是展示决策，不是通知能力。
// 所以这里全部收敛成「返回布尔值、绝不抛」，业务侧只关心"这条提示有没有发出去"。

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/** 当前环境的通知能力（顺带把权限状态取回来，省得调用点自己判 typeof） */
export function notificationPermission(): NotifyPermission {
  if (typeof window === 'undefined') return 'unsupported'
  const N = (window as unknown as { Notification?: typeof Notification }).Notification
  if (!N) return 'unsupported'
  const p = N.permission
  return p === 'granted' || p === 'denied' || p === 'default' ? p : 'default'
}

/**
 * 申请通知权限。
 * ⚠️ 浏览器只在**用户手势**里响应 requestPermission（点开关、点按钮都算）；
 * 在定时器/SSE 回调里调用会直接返回 'default'（Chrome 不再弹窗），所以设置页必须在
 * 用户点击那一刻调它，而不是等任务跑完再补申请。
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  const current = notificationPermission()
  if (current === 'unsupported' || current === 'granted' || current === 'denied') return current
  try {
    const N = (window as unknown as { Notification: typeof Notification }).Notification
    const result = await N.requestPermission()
    return result === 'granted' || result === 'denied' ? result : 'default'
  } catch {
    return 'default'
  }
}

/**
 * 现在该用**系统通知**还是**应用内提示**？
 *
 * 页面在前台可见且持有焦点时，用户看得见应用内提示，再弹一个系统窗口纯属打扰；
 * 一旦切到别的标签页 / 别的窗口（任务跑完时人通常就在别处），应用内提示等于没提示，
 * 必须走系统通知 —— 这正是这个功能存在的理由。
 */
export function shouldUseSystemNotification(): boolean {
  if (typeof document === 'undefined') return false
  if (document.visibilityState !== 'visible') return true
  // jsdom 里 hasFocus 恒为 true；真浏览器里"窗口在但被别的窗口盖住"这里才会是 false
  return typeof document.hasFocus === 'function' ? !document.hasFocus() : false
}

/**
 * 发一条系统通知。返回是否真的发出去了（权限不足 / 不支持 / 构造失败 → false，
 * 调用点据此退回应用内提示，别让用户什么都收不到）。
 *
 * tag 传 job.id：同一个任务的多次提示互相替换，不会在通知中心堆一列（终态只会推一次，
 * 这里主要是兜 reconnect 之类的重复帧）。
 */
export function notifySystem(opts: { title: string; body?: string; tag?: string }): boolean {
  if (notificationPermission() !== 'granted') return false
  try {
    const N = (window as unknown as { Notification: typeof Notification }).Notification
    const n = new N(opts.title, {
      body: opts.body || '',
      tag: opts.tag || undefined,
      // 不要 requireInteraction：任务提示是"知道了"级别的信息，不该赖在屏幕上等点击
      requireInteraction: false,
      silent: false
    })
    n.onclick = () => {
      try { window.focus() } catch { /* 部分浏览器禁用 focus，忽略 */ }
      try { n.close() } catch { /* ignore */ }
    }
    return true
  } catch {
    return false
  }
}
