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
// 进度报告间隔口径的单测。
//
// 「前端白名单必须等于服务端白名单」那条断言不在这里 —— 客户端 tsconfig 不允许
// import 服务端的 .js（无 allowJs），硬串起来会连 TSC 都过不去。
// 它由服务端那份单测（routes/workbench/progressReport.test.js）读这里的源码比对，
// 与这份测试是同一个契约的两端。

import { describe, it, expect } from 'vitest'

import {
  REPORT_INTERVAL_OPTIONS_MS,
  DEFAULT_REPORT_INTERVAL_MS,
  REPORT_PERCENT_HINT_KEY,
  REPORT_PERCENT_LABEL_KEY,
  normalizeReportInterval,
  reportIntervalLabelKey,
  reportIntervalLabelParams,
  reportErrorKey,
  reportPercent,
  reportSilentMs,
} from './progressReport'

describe('进度报告间隔档位', () => {
  it('0 = 关闭，且默认档位（10 分钟）在白名单里', () => {
    expect(REPORT_INTERVAL_OPTIONS_MS[0]).toBe(0)
    expect(REPORT_INTERVAL_OPTIONS_MS).toContain(DEFAULT_REPORT_INTERVAL_MS)
  })

  it('normalizeReportInterval 只认白名单里的值，其余回落默认', () => {
    expect(normalizeReportInterval(0)).toBe(0)
    expect(normalizeReportInterval(5 * 60 * 1000)).toBe(5 * 60 * 1000)
    // 脏数据 / 手改配置 / 字符串数字都要能收住
    expect(normalizeReportInterval(7 * 60 * 1000)).toBe(DEFAULT_REPORT_INTERVAL_MS)
    expect(normalizeReportInterval('abc')).toBe(DEFAULT_REPORT_INTERVAL_MS)
    expect(normalizeReportInterval(undefined)).toBe(DEFAULT_REPORT_INTERVAL_MS)
    expect(normalizeReportInterval(-1)).toBe(DEFAULT_REPORT_INTERVAL_MS)
    expect(normalizeReportInterval('600000')).toBe(10 * 60 * 1000)
  })

  it('每个档位都有自己的文案 key 与插值参数（分钟 / 小时分开说）', () => {
    expect(reportIntervalLabelKey(0)).toBe('@WORKBENCH:关闭自动报告')
    expect(reportIntervalLabelKey(5 * 60 * 1000)).toBe('@WORKBENCH:每 {n} 分钟报告')
    expect(reportIntervalLabelParams(5 * 60 * 1000)).toEqual({ n: 5 })
    expect(reportIntervalLabelKey(60 * 60 * 1000)).toBe('@WORKBENCH:每 {n} 小时报告')
    expect(reportIntervalLabelParams(60 * 60 * 1000)).toEqual({ n: 1 })
    expect(reportIntervalLabelParams(0)).toEqual({})
  })
})

describe('报告失败原因码', () => {
  it('四个已知码各有各的说法', () => {
    expect(reportErrorKey('NO_MODEL')).toContain('AI 模型')
    expect(reportErrorKey('LLM_TIMEOUT')).toContain('超时')
    // 「模型答了但没写正文」要跟「生成失败」分开说：处理办法是调生成预算，不是查网络
    expect(reportErrorKey('LLM_EMPTY')).toContain('没有返回正文')
    expect(reportErrorKey('LLM_FAILED')).toContain('失败')
  })

  it('没见过的码退回通用文案，而不是把码印在界面上', () => {
    expect(reportErrorKey('SOMETHING_NEW')).toBe(reportErrorKey('LLM_FAILED'))
    expect(reportErrorKey('')).toBe(reportErrorKey('LLM_FAILED'))
  })
})

/**
 * 百分比归一是**界面要不要画那条进度条**的唯一判据（null = 不画）。
 * 所以两边都得钉住：该画的必须画出来，不该画的绝不能给个 0 糊过去。
 */
describe('报告里的进度百分比', () => {
  it('正常的整数原样放行', () => {
    expect(reportPercent(0)).toBe(0)
    expect(reportPercent(62)).toBe(62)
    expect(reportPercent(100)).toBe(100)
    expect(reportPercent('62')).toBe(62)
    expect(reportPercent(62.4)).toBe(62)
  })

  it('缺字段 / 脏值 / 越界一律 null（不画），绝不夹成 0 或 100', () => {
    expect(reportPercent(undefined)).toBeNull()
    expect(reportPercent(null)).toBeNull()
    expect(reportPercent('')).toBeNull()
    expect(reportPercent('abc')).toBeNull()
    expect(reportPercent(NaN)).toBeNull()
    // 越界不夹：把 130 画成 100% 等于替模型说"这个任务做完了"
    expect(reportPercent(130)).toBeNull()
    expect(reportPercent(-5)).toBeNull()
  })

  it('标签与说明是两条真实的 key（不是空串）', () => {
    // 光甩一个 62% 会被当成实测进度，所以那四个字和悬停说明必须在
    expect(REPORT_PERCENT_LABEL_KEY).toBe('@WORKBENCH:AI 估计')
    expect(REPORT_PERCENT_HINT_KEY.startsWith('@WORKBENCH:')).toBe(true)
  })
})

/**
 * 「静默 x 秒」是"它可能卡住了"的告警信号。
 *
 * 面板读的是**盘上的历史报告**，老版本服务端落盘时把"没有静默"（null）写成了 0
 * （`Number(null)` 是 0），所以渲染层必须自己挡一次 0 —— 不挡就会在事实卡上
 * 画出「静默 0 秒」，那是噪声而不是信号（用户 2026-10-04 反馈）。
 */
describe('报告事实里的静默时长', () => {
  it('真的静默过才给值（毫秒取整）', () => {
    expect(reportSilentMs(6 * 60 * 1000)).toBe(6 * 60 * 1000)
    expect(reportSilentMs(90_000.7)).toBe(90_000)
  })

  it('0 与缺字段都不显示（静默 0 秒 = 它刚说过话）', () => {
    expect(reportSilentMs(0)).toBeNull()
    expect(reportSilentMs(null)).toBeNull()
    expect(reportSilentMs(undefined)).toBeNull()
    expect(reportSilentMs('')).toBeNull()
    // 字符串也当没有：盘上的值一律由服务端 normalizeSilentMs 归一成 number / null，
    // 渲染层再"宽容"一点就等于把脏数据画成信号（方向要偏保守 —— 宁可不显示）
    expect(reportSilentMs('60000')).toBeNull()
    expect(reportSilentMs(-1)).toBeNull()
    expect(reportSilentMs(NaN)).toBeNull()
  })
})
