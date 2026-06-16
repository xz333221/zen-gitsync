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

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 按换行切分
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        onLog(JSON.parse(line) as UpgradeLogEvent)
      } catch {
        // 忽略无法解析的行
      }
    }
  }
  // 流结束时若有残余 buffer 也尝试解析一次
  if (buffer.trim()) {
    try {
      onLog(JSON.parse(buffer) as UpgradeLogEvent)
    } catch {}
  }
}

/**
 * 通知服务端优雅退出，外层 launcher 会自动拉起新版本。
 * 失败抛错，由调用方决定是否回退到手动刷新。
 */
export async function restartApp(): Promise<void> {
  const res = await fetch('/api/app-restart', { method: 'POST' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {}
    throw new Error(msg)
  }
}
