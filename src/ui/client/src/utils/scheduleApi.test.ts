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
// 定时任务展示格式化的单测。纯函数，全部用本地时间构造（与实现同口径）。

import { describe, it, expect } from 'vitest'
import {
  describeSchedule, formatNextRun, formatDuration, classifyRunStatus, buildCron,
} from './scheduleApi'

describe('describeSchedule', () => {
  it('识别常见形状', () => {
    expect(describeSchedule('* * * * *')).toMatchObject({ kind: 'every-minute' })
    expect(describeSchedule('*/30 * * * *')).toMatchObject({ kind: 'every-n-minutes', n: 30 })
    expect(describeSchedule('15 * * * *')).toMatchObject({ kind: 'hourly', minute: 15 })
    expect(describeSchedule('30 9 * * *')).toMatchObject({ kind: 'daily', hour: 9, minute: 30 })
    expect(describeSchedule('0 10 * * 1')).toMatchObject({ kind: 'weekly', weekday: 1, hour: 10, minute: 0 })
    expect(describeSchedule('0 8 15 * *')).toMatchObject({ kind: 'monthly', day: 15, hour: 8, minute: 0 })
  })

  it('识别不了的一律 custom，并带上原文', () => {
    expect(describeSchedule('0 9 * * 1-5')).toMatchObject({ kind: 'custom', raw: '0 9 * * 1-5' })
    expect(describeSchedule('0 9 * *')).toMatchObject({ kind: 'custom' })
    expect(describeSchedule('')).toMatchObject({ kind: 'custom' })
    // 步长只在"其余全是 *"时才算"每 N 分钟"；带小时限定的不是
    expect(describeSchedule('*/5 9-18 * * *')).toMatchObject({ kind: 'custom' })
  })

  it('周日的两种写法（0 / 7）都归一到 0', () => {
    expect(describeSchedule('0 9 * * 0')).toMatchObject({ kind: 'weekly', weekday: 0 })
    expect(describeSchedule('0 9 * * 7')).toMatchObject({ kind: 'weekly', weekday: 0 })
  })
})

describe('buildCron：表单形状与识别形状互为逆运算', () => {
  const base = { minute: 0, hour: 9, weekday: 1, custom: '' }

  it('各频率生成的 cron 都能被 describeSchedule 认回原形状', () => {
    const every = buildCron({ ...base, freq: 'minutes', everyMinutes: 15 })
    expect(every).toBe('*/15 * * * *')
    expect(describeSchedule(every)).toMatchObject({ kind: 'every-n-minutes', n: 15 })

    const hourly = buildCron({ ...base, freq: 'hourly', minute: 30 })
    expect(hourly).toBe('30 * * * *')
    expect(describeSchedule(hourly)).toMatchObject({ kind: 'hourly', minute: 30 })

    const daily = buildCron({ ...base, freq: 'daily', hour: 9, minute: 5 })
    expect(daily).toBe('5 9 * * *')
    expect(describeSchedule(daily)).toMatchObject({ kind: 'daily', hour: 9, minute: 5 })

    const weekly = buildCron({ ...base, freq: 'weekly', hour: 10, minute: 0, weekday: 1 })
    expect(weekly).toBe('0 10 * * 1')
    expect(describeSchedule(weekly)).toMatchObject({ kind: 'weekly', weekday: 1, hour: 10 })

    const custom = buildCron({ ...base, freq: 'custom', custom: ' 0 9 * * 1-5 ' })
    expect(custom).toBe('0 9 * * 1-5')
  })

  it('越界输入被夹取，不会生成非法 cron', () => {
    expect(buildCron({ ...base, freq: 'minutes', everyMinutes: 0 })).toBe('*/1 * * * *')
    expect(buildCron({ ...base, freq: 'daily', hour: 99, minute: 99 })).toBe('59 23 * * *')
    // weekday 归一：8 → 1（周一）
    expect(buildCron({ ...base, freq: 'weekly', weekday: 8 })).toBe('0 9 * * 1')
  })
})

describe('formatNextRun', () => {
  // 2026-10-09 是周五
  const now = new Date(2026, 9, 9, 20, 0)

  it('今天 / 明天 / 周内 / 更远', () => {
    expect(formatNextRun(new Date(2026, 9, 9, 21, 30).toISOString(), now))
      .toEqual({ kind: 'today', time: '21:30' })
    expect(formatNextRun(new Date(2026, 9, 10, 9, 0).toISOString(), now))
      .toEqual({ kind: 'tomorrow', time: '09:00' })
    // 10-12 是周一
    expect(formatNextRun(new Date(2026, 9, 12, 10, 0).toISOString(), now))
      .toEqual({ kind: 'weekday', weekday: 1, time: '10:00' })
    // 超过 6 天退回日期
    expect(formatNextRun(new Date(2026, 9, 20, 10, 0).toISOString(), now))
      .toEqual({ kind: 'date', date: '10-20', time: '10:00' })
  })

  it('空值与坏值给 none；过去的时间不硬套今天', () => {
    expect(formatNextRun('', now)).toEqual({ kind: 'none' })
    expect(formatNextRun('not-a-date', now)).toEqual({ kind: 'none' })
    expect(formatNextRun(new Date(2026, 9, 8, 9, 0).toISOString(), now))
      .toEqual({ kind: 'date', date: '10-08', time: '09:00' })
  })
})

describe('formatDuration', () => {
  it('秒 / 分 / 小时三档', () => {
    expect(formatDuration(500)).toBe('<1s')
    expect(formatDuration(12000)).toBe('12s')
    expect(formatDuration(80_000)).toBe('1m20s')
    expect(formatDuration(5_400_000)).toBe('1h30m')
    expect(formatDuration(undefined)).toBe('')
    expect(formatDuration(-1)).toBe('')
  })
})

describe('classifyRunStatus', () => {
  it('状态归四类', () => {
    expect(classifyRunStatus('ok')).toBe('ok')
    expect(classifyRunStatus('error')).toBe('error')
    expect(classifyRunStatus('timed-out')).toBe('error')
    expect(classifyRunStatus('skipped-busy')).toBe('skipped')
    expect(classifyRunStatus('missed')).toBe('skipped')
    expect(classifyRunStatus('cancelled')).toBe('skipped')
    expect(classifyRunStatus('whatever')).toBe('pending')
  })
})
