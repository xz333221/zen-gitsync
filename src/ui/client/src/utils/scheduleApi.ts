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
// 定时任务的前端 API 封装 + 展示格式化。
//
// 格式化一律**结构化返回**（kind + 参数），文案由组件用 $t 拼 —— 这样中英切换
// 时描述跟着走，而不是在这里写死一份中文。

export interface ScheduleRunRecord {
  at: string
  status: string
  durationMs?: number
  sessionId?: string
  error?: string
  summary?: string
  toolCalls?: number
  trigger?: string
  fire?: string
}

export interface ScheduleRunningInfo {
  taskId: string
  sessionId: string
  startedAt: string
  fire?: string
}

export interface ScheduleTask {
  id: string
  name: string
  enabled: boolean
  schedule: string
  cwd: string
  prompt: string
  model: string
  locale: string
  sessionMode: string
  onMissed: 'run' | 'skip' | string
  sessionId: string
  lastFire: string
  lastRun: ScheduleRunRecord | null
  createdAt: string
  updatedAt: string
  /** 服务端算好的下次执行时刻（ISO）；停用时为空串 */
  nextRunAt: string
  /** 正在执行中的那轮（没有则为 null） */
  running: ScheduleRunningInfo | null
}

export interface ScheduleDraft {
  name: string
  schedule: string
  cwd: string
  prompt: string
  enabled: boolean
  onMissed: 'run' | 'skip'
}

export interface ScheduleEvent {
  type: string
  taskId?: string
  sessionId?: string
  status?: string
  ts?: string
  [key: string]: unknown
}

// ── API ────────────────────────────────────────────────────

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  let payload: { success?: boolean; error?: string } & Record<string, unknown> = {}
  try {
    payload = await res.json()
  } catch {
    /* 空 body / 非 JSON：按状态码兜底 */
  }
  if (!res.ok || payload.success === false) {
    throw new Error(payload.error || `请求失败 (${res.status})`)
  }
  return payload as T
}

export async function fetchSchedules(): Promise<ScheduleTask[]> {
  const payload = await request<{ tasks: ScheduleTask[] }>('/api/schedules')
  return Array.isArray(payload.tasks) ? payload.tasks : []
}

export async function createSchedule(draft: ScheduleDraft): Promise<ScheduleTask> {
  const payload = await request<{ task: ScheduleTask }>('/api/schedules', {
    method: 'POST',
    body: JSON.stringify(draft),
  })
  return payload.task
}

export async function updateSchedule(id: string, patch: Partial<ScheduleDraft>): Promise<ScheduleTask> {
  const payload = await request<{ task: ScheduleTask }>(`/api/schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  return payload.task
}

export async function deleteSchedule(id: string): Promise<void> {
  await request(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function runSchedule(id: string): Promise<void> {
  await request(`/api/schedules/${encodeURIComponent(id)}/run`, { method: 'POST' })
}

export async function stopSchedule(id: string): Promise<void> {
  await request(`/api/schedules/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}

/**
 * 订阅任务库与执行状态事件。返回取消订阅函数。
 * jsdom / 老浏览器没有 EventSource 时退化为轮询替代（这里直接空实现，
 * 面板本身在每次操作后会重新拉列表）。
 */
export function subscribeScheduleEvents(onEvent: (evt: ScheduleEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  const es = new EventSource('/api/schedules/events')
  es.onmessage = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(ev.data))
    } catch {
      /* 坏帧忽略 */
    }
  }
  // onerror 不需要处理：EventSource 自带重连，重连后还会收到 hello
  return () => es.close()
}

// ── 展示格式化（结构化，文案在组件里拼）───────────────────────

export type ScheduleDescription =
  | { kind: 'every-minute'; raw: string }
  | { kind: 'every-n-minutes'; n: number; raw: string }
  | { kind: 'hourly'; minute: number; raw: string }
  | { kind: 'daily'; hour: number; minute: number; raw: string }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number; raw: string }
  | { kind: 'monthly'; day: number; hour: number; minute: number; raw: string }
  | { kind: 'custom'; raw: string }

const asNum = (s: string): number | null => (/^\d+$/.test(s) ? Number(s) : null)

/**
 * 把 cron 表达式识别成常见形状（识别不了就 custom，由组件直接显示原文）。
 * **刻意不做完整解析** —— 完整语义只有服务端一份（utils/scheduleCron.js），
 * 这里只认我们表单自己能生成的形状 + 最常用的一批。
 */
export function describeSchedule(cron: string): ScheduleDescription {
  const raw = String(cron || '').trim()
  const parts = raw.split(/\s+/)
  if (parts.length !== 5) return { kind: 'custom', raw }
  const [mi, ho, dom, mon, dow] = parts
  const m = asNum(mi)
  const h = asNum(ho)

  if (raw === '* * * * *') return { kind: 'every-minute', raw }

  const stepM = mi.match(/^\*\/(\d+)$/)
  if (stepM && ho === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { kind: 'every-n-minutes', n: Number(stepM[1]), raw }
  }
  if (m !== null && ho === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { kind: 'hourly', minute: m, raw }
  }
  if (m !== null && h !== null && dom === '*' && mon === '*' && dow === '*') {
    return { kind: 'daily', hour: h, minute: m, raw }
  }
  const w = asNum(dow)
  if (m !== null && h !== null && dom === '*' && mon === '*' && w !== null) {
    return { kind: 'weekly', weekday: w % 7, hour: h, minute: m, raw }
  }
  const d = asNum(dom)
  if (m !== null && h !== null && d !== null && mon === '*' && dow === '*') {
    return { kind: 'monthly', day: d, hour: h, minute: m, raw }
  }
  return { kind: 'custom', raw }
}

export type NextRunInfo =
  | { kind: 'none' }
  | { kind: 'today'; time: string }
  | { kind: 'tomorrow'; time: string }
  | { kind: 'weekday'; weekday: number; time: string }
  | { kind: 'date'; date: string; time: string }

const pad2 = (n: number) => String(n).padStart(2, '0')
const startOfDayMs = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** 下次执行时刻 → 结构化描述（今天 09:00 / 明天 09:00 / 周一 10:00 / 10-15 09:00） */
export function formatNextRun(iso: string, now: Date = new Date()): NextRunInfo {
  if (!iso) return { kind: 'none' }
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { kind: 'none' }
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const dayDiff = Math.round((startOfDayMs(d) - startOfDayMs(now)) / 86400000)
  // 过去的时间（理论上不该出现，比如时钟回拨）：退化成日期显示，不硬套"今天"
  if (dayDiff < 0) return { kind: 'date', date: `${d.getMonth() + 1}-${pad2(d.getDate())}`, time }
  if (dayDiff === 0) return { kind: 'today', time }
  if (dayDiff === 1) return { kind: 'tomorrow', time }
  if (dayDiff < 7) return { kind: 'weekday', weekday: d.getDay(), time }
  return { kind: 'date', date: `${d.getMonth() + 1}-${pad2(d.getDate())}`, time }
}

/** 执行状态归类：组件据此选颜色与文案 */
export function classifyRunStatus(status: string): 'ok' | 'error' | 'skipped' | 'pending' {
  switch (status) {
    case 'ok': return 'ok'
    case 'error':
    case 'timed-out': return 'error'
    case 'skipped-busy':
    case 'missed':
    case 'cancelled': return 'skipped'
    default: return 'pending'
  }
}

/** 耗时 → "12s" / "1m20s" / "1h02m" */
export function formatDuration(ms: number | undefined): string {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1000) return '<1s'
  const s = Math.round(n / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${pad2(s % 60)}s`
  const h = Math.floor(m / 60)
  return `${h}h${pad2(m % 60)}m`
}

/**
 * 表单的"频率"预设 → cron。
 * 只做字符串拼接（不是解析），与 describeSchedule 的识别形状一一对应。
 */
export function buildCron(input: {
  freq: 'minutes' | 'hourly' | 'daily' | 'weekly' | 'custom'
  everyMinutes?: number
  minute: number
  hour: number
  weekday: number
  custom: string
}): string {
  const m = Math.min(59, Math.max(0, Math.floor(input.minute)))
  const h = Math.min(23, Math.max(0, Math.floor(input.hour)))
  const w = ((Math.floor(input.weekday) % 7) + 7) % 7
  switch (input.freq) {
    case 'minutes': {
      const n = Math.min(59, Math.max(1, Math.floor(input.everyMinutes ?? 30)))
      return `*/${n} * * * *`
    }
    case 'hourly': return `${m} * * * *`
    case 'daily': return `${m} ${h} * * *`
    case 'weekly': return `${m} ${h} * * ${w}`
    case 'custom': return String(input.custom || '').trim()
  }
}
