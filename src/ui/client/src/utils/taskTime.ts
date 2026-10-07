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
// 任务「时间 / 用时」的共用口径。
//
// 这套口径原先只长在看板卡片里（WorkbenchKanban 的 cardTime / cardDuration /
// cardTimeTitle）。「任务执行」弹窗的顶部细栏要显示同样这两个值，而两处**必须逐字一致** ——
// 各写一套的话，"2 分钟前"与"刚刚"、"用时 7 分 16 秒"与"用时 7 分 16 秒 "这类
// 肉眼几乎看不出的分叉会在同一屏上并排出现（卡片在上、弹窗盖着它），
// 用户只会以为其中一个坏了。所以口径收口在这里，两边都从这里取。
//
// 判据本身不在这里推导：`column` / `lastDurationMs` / `live` 全是服务端
// projectRegistry.decorateTaskForBoard 算好的事实，本模块只负责"拿哪一个 + 怎么念"。

import { $t } from '@/lang/static'
import type { TaskColumn } from '@/types/workbench'
import { clockFromIso, formatDurationMs } from './relativeTime'

/**
 * 一条任务的"时间 / 用时"事实。
 *
 * 看板卡片（BoardTask）天然满足这个形状；弹窗那边把**同一份 BoardTask** 传进来，
 * 算的是同一个对象 —— 所以两处显示出来的字必然一样，不靠"两边写法对齐"来保证。
 */
export interface TaskTimeFacts {
  column: TaskColumn
  manualDoneAt?: string | null
  lastJobEndedAt?: string | null
  updatedAt?: string | null
  createdAt?: string | null
  lastDurationMs?: number | null
  lastJobStartedAt?: string | null
  /** 正在跑时的活动摘要（只要有 elapsedMs 就够）；没在跑为 null */
  live?: { elapsedMs: number } | null
}

/**
 * 「已完成」任务的完成时刻，回退链：手动完成标记 → 最近一条 job 的结束时间 →
 * updatedAt → createdAt。
 *
 * 手动标记排在最前：手动收掉的任务往往**没有**"跑完的时刻"（最近一条 job 可能是
 * 三天前那次报错），拿它当完成时间，用户刚点完完成、卡片上写着「3 天前」。
 * 更后面两级是给"没有 job 记录却进了已完成列"的任务兜底的。
 */
export function taskDoneAt(t: TaskTimeFacts): string {
  return String(t.manualDoneAt || t.lastJobEndedAt || t.updatedAt || t.createdAt || '')
}

/**
 * 一条任务"最近发生了什么"的时间（ISO，调用方再过 relativeTimeFromIso 念出来）。
 *
 * 已完成的给完成时刻，其余给最后变动时刻。看板卡片右上角、列表视图时间列、
 * 弹窗细栏三处共用这一个 —— 单独再写一遍 `updatedAt || createdAt` 的话，
 * 同一条任务在不同地方会显示两个时间。
 */
export function taskTimeIso(t: TaskTimeFacts): string {
  return t.column === 'done' ? taskDoneAt(t) : (t.updatedAt || t.createdAt || '')
}

/**
 * 「用时」背后的**时长正文**（`7 分 16 秒`），不适用时是空串。
 *
 * 刻意**不带**「用时」两个字：卡片那行是 `v-if="cardDuration(t)"` 决定整行渲不渲染、
 * 文案在模板里用 `$t('@WORKBENCH:用时 {d}')` 拼的，这里给正文，那段 v-if 才有东西可判。
 * 要整句请用 taskSpentText（弹窗细栏只有一个槽位，用的就是它）。
 *
 * **只在没有 job 在跑时给值**：正在跑的那个时长每 5s 都在长，已经由 taskLiveText
 * 呈现。两处各给一份、一个会长一个不长的数字，用户会以为其中一个坏了 ——
 * 所以判据是「有没有 live」，不是「哪一列」。
 *
 * 服务端给不出（lastDurationMs 为 null：从没执行过 / 老记录缺 startedAt 或 endedAt）
 * 就空着。用时是给人判断"这条是不是特别磨"的参考，宁可没有也不要一个假的 0。
 */
export function taskDurationBody(t: TaskTimeFacts): string {
  if (t.live) return ''
  return formatDurationMs(t.lastDurationMs)
}

/** 跑完那一次的整句「用时 7 分 16 秒」；给不出 → 空串（调用方据此整段不渲染） */
export function taskSpentText(t: TaskTimeFacts): string {
  const body = taskDurationBody(t)
  return body ? $t('@WORKBENCH:用时 {d}', { d: body }) : ''
}

/** 正在跑时的「已运行 x」；没在跑 → 空串（不是 0） */
export function taskLiveText(t: TaskTimeFacts): string {
  if (!t.live) return ''
  return $t('@WORKBENCH:已运行 {elapsed}', { elapsed: formatDurationMs(t.live.elapsedMs) })
}

/**
 * "这个任务花了多久"的**单槽位**版本：在跑 → 「已运行 x」，跑过 → 「用时 x」，
 * 两者都不成立（从没跑过 / 缺时间戳）→ 空串。
 *
 * 看板把这两句分摆在两处（活动区的「已运行」与独占一行的「用时」），
 * 弹窗细栏横向只有一个槽位、也不该让同一个数出现两次，所以用这个取。
 * 两句各自与 taskLiveText / taskSpentText 同源，口径不会分叉。
 */
export function taskDurationText(t: TaskTimeFacts): string {
  return taskLiveText(t) || taskSpentText(t)
}

/**
 * 时长那一处的悬停提示：把「用时」背后的两个绝对时刻摊开（几点起、几点止）。
 *
 * 相对时间（"3 小时前"）+ 用时（"12 分"）已经能回答"跑了多久"，但答不了"是哪一段"——
 * 排查某段时间里到底跑过什么时，得能指着绝对时刻。两者都取不到就退回空提示，
 * 不拼一个"无"/"-"出来占位；正在跑时没有"整段用时"这回事，同样空着。
 */
export function taskTimeTitle(t: TaskTimeFacts): string {
  const dur = taskDurationBody(t)
  if (!dur) return ''
  const from = clockFromIso(t.lastJobStartedAt)
  const to = clockFromIso(t.lastJobEndedAt)
  // 只有起止都拿得到才给区间；缺一头的话那串时刻对不上号，反而误导
  if (!from || !to) return dur
  return `${dur} · ${from} → ${to}`
}
