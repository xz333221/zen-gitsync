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
 * 应用版本管理：查询最新版本、流式升级
 */

export interface AppVersionInfo {
  success: boolean
  current: string
  latest: string | null
  hasUpdate: boolean
  error?: string
}

export interface UpgradeLogEvent {
  type: 'stdout' | 'stderr' | 'error' | 'done'
  message?: string
  code?: number
}

export interface RestartEvent {
  type: 'ready' | 'error' | 'timeout' | 'stdout'
  port?: number
  message?: string
}

/**
 * 通用 NDJSON 流解析器：把 fetch ReadableStream 切成行，逐行调用 onEvent。
 * 解析失败/空行被静默丢弃，不中断流。
 * 复用：startAppUpgrade / restartApp
 */
async function _parseNdjsonStream(
  res: Response,
  onEvent: (line: string) => void
): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) onEvent(line)
    }
  }
  if (buffer.trim()) onEvent(buffer)
}

/** 查询当前版本与 npm 上的最新版本 */
export async function fetchAppVersion(): Promise<AppVersionInfo> {
  const res = await fetch('/api/app-version')
  if (!res.ok) {
    return { success: false, current: '', latest: null, hasUpdate: false, error: `HTTP ${res.status}` }
  }
  return res.json()
}

/**
 * 触发升级，onLog 在每条 NDJSON 事件到达时被调用。
 * 解析失败的事件会被吞掉，不中断流。
 */
export async function startAppUpgrade(onLog: (evt: UpgradeLogEvent) => void): Promise<void> {
  const res = await fetch('/api/app-upgrade', { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {}
    onLog({ type: 'error', message: msg })
    onLog({ type: 'done', code: res.status })
    return
  }
  if (!res.body) {
    onLog({ type: 'error', message: '响应无 body' })
    onLog({ type: 'done', code: -1 })
    return
  }

  await _parseNdjsonStream(res, (line) => {
    try {
      onLog(JSON.parse(line) as UpgradeLogEvent)
    } catch {
      // 忽略无法解析的行
    }
  })
}

/**
 * 触发后端自拉起重启；通过 NDJSON 流接收新进程端口。
 * resolve 时返回新端口；reject 时抛带原因的错误。
 * 流提前关闭（未收到 ready）也会 reject。
 */
export async function restartApp(): Promise<number> {
  const res = await fetch('/api/app-restart', { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {}
    throw new Error(msg)
  }
  if (!res.body) throw new Error('响应无 body')

  return new Promise<number>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    _parseNdjsonStream(res, (line) => {
      try {
        const evt = JSON.parse(line) as RestartEvent
        if (evt.type === 'ready' && typeof evt.port === 'number' && evt.port > 0) {
          settle(() => resolve(evt.port as number))
        } else if (evt.type === 'timeout') {
          settle(() => reject(new Error('restart.timeout')))
        } else if (evt.type === 'error') {
          settle(() => reject(new Error(evt.message || 'restart.failed')))
        }
        // 'stdout' 仅用于后端日志展示，前端忽略
      } catch {
        // 忽略无法解析的行
      }
    }).then(() => {
      settle(() => reject(new Error('restart.stream-closed')))
    }).catch(() => {})
  })
}
