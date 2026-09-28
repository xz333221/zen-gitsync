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
  normalizeReportInterval,
  reportIntervalLabelKey,
  reportIntervalLabelParams,
  reportErrorKey,
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
  it('三个已知码各有各的说法', () => {
    expect(reportErrorKey('NO_MODEL')).toContain('AI 模型')
    expect(reportErrorKey('LLM_TIMEOUT')).toContain('超时')
    expect(reportErrorKey('LLM_FAILED')).toContain('失败')
  })

  it('没见过的码退回通用文案，而不是把码印在界面上', () => {
    expect(reportErrorKey('SOMETHING_NEW')).toBe(reportErrorKey('LLM_FAILED'))
    expect(reportErrorKey('')).toBe(reportErrorKey('LLM_FAILED'))
  })
})
