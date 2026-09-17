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
// 相对时间格式化：把 ISO 时间戳渲染成「刚刚 / N 分钟前 / N 小时前 / N 天前」。
// 文案走 i18n（@WORKBENCH 命名空间），不要在这里写死中文。

import { $t } from '@/lang/static'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * ISO 时间戳 → 相对时间文案。空值 / 非法时间返回空串（调用方自行决定回退文案）。
 * @param iso ISO 8601 字符串
 * @param now 参照时刻，默认当前时间（传参便于单测与固定渲染）
 */
export function relativeTimeFromIso(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  // 时钟漂移可能让服务端时间戳落在"未来"几秒，按"刚刚"处理，不要出现负数
  const diff = Math.max(0, now - t)

  if (diff < MINUTE) return $t('@WORKBENCH:刚刚')
  if (diff < HOUR) return $t('@WORKBENCH:N 分钟前', { n: Math.floor(diff / MINUTE) })
  if (diff < DAY) return $t('@WORKBENCH:N 小时前', { n: Math.floor(diff / HOUR) })
  if (diff < 30 * DAY) return $t('@WORKBENCH:N 天前', { n: Math.floor(diff / DAY) })
  return new Date(t).toLocaleDateString()
}

/**
 * 起止时间（含尚未结束的）→ 已运行时长，形如 `1 小时 12 分` / `3 分 20 秒`。
 * @param endIso 结束时间；不传表示"还在跑"，用 now 当结束时刻
 * @param now    参照时刻，默认当前时间（传参便于单测与每秒刷新）
 */
export function formatElapsed(startIso?: string | null, endIso?: string | null, now: number = Date.now()): string {
  if (!startIso) return ''
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return ''
  const end = endIso ? new Date(endIso).getTime() : now
  if (Number.isNaN(end)) return ''
  const diff = Math.max(0, end - start)
  const totalSec = Math.floor(diff / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return $t('@WORKBENCH:N 小时 M 分', { n: h, m })
  if (m > 0) return $t('@WORKBENCH:N 分 M 秒', { n: m, m: s })
  return $t('@WORKBENCH:N 秒', { n: s })
}
