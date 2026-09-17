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
// describePushFailure 的单测。
//
// 背景：git 进程在 Windows 上被加载器拒绝初始化时（0xC0000142），stdout/stderr 全空，
// 界面以前只显示 `Push failed with code 3221225794`。这里锁住三条边界：
//   1. 已知 errorCode → 必须是可读句子，且句子里带上十六进制码（用户要靠它搜索/报障）
//   2. errorCode 未知但零输出 → 兜底文案要把退出码内插进去，不能丢掉码
//   3. git 自己有输出（errorCode 为 null）→ 原样透传，不能被通用文案覆盖

import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lang/static', () => ({
  // 与 relativeTime.test.ts 同款最简 i18n：剥掉命名空间前缀 + 具名插值。
  // zh 表里这些 key 的值就是"去掉前缀的 key 本身"，所以断言里能直接读到渲染后的句子。
  $t: (key: string, params?: Record<string, string | number>) => {
    const text = key.replace(/^@[A-Z0-9]+:/, '')
    return params
      ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text)
      : text
  },
}))

import { describePushFailure, formatExitCode } from './pushFailure'

describe('formatExitCode', () => {
  test('NTSTATUS 转十六进制，正常退出码保持十进制', () => {
    expect(formatExitCode(3221225794)).toBe('0xC0000142')
    expect(formatExitCode(128)).toBe('128')
    expect(formatExitCode(null)).toBe('null')
  })
})

describe('describePushFailure', () => {
  test('PROCESS_INIT_FAILED：给出可读句子 + 十六进制码 + 重试指引', () => {
    const text = describePushFailure({ errorCode: 'PROCESS_INIT_FAILED', exitCode: 3221225794 })
    // 不能把 key 原样露出来
    expect(text).not.toContain('@PUSH:')
    expect(text).toContain('0xC0000142')
    expect(text).toContain('重试')
    // 后端那句毫无信息量的兜底不该再出现
    expect(text).not.toContain('Push failed with code')
  })

  test('PROCESS_EXITED：未知退出码也要把码内插进兜底文案', () => {
    const text = describePushFailure({ errorCode: 'PROCESS_EXITED', exitCode: 3221225725 })
    expect(text).toContain('0xC00000FD')
    expect(text).not.toContain('{code}')
    expect(text).toContain('重试')
  })

  test('GIT_NOT_FOUND：PATH 里没有 git 时给安装指引', () => {
    const text = describePushFailure({ errorCode: 'GIT_NOT_FOUND' })
    expect(text).toContain('PATH')
  })

  test('errorCode 为 null（git 自己有输出）→ 原样透传 git 的 fatal 信息', () => {
    const fatal = 'fatal: failed to push some refs to https://example.com/x.git'
    expect(describePushFailure({ error: fatal, errorCode: null, exitCode: 128 })).toBe(fatal)
  })

  test('未知 errorCode → 退回后端文案；连文案都没有才用通用兜底', () => {
    expect(describePushFailure({ error: 'some backend text', errorCode: 'WHATEVER' })).toBe('some backend text')
    expect(describePushFailure({ error: 'some backend text' })).toBe('some backend text')
    expect(describePushFailure(null)).toBe('未知错误')
    expect(describePushFailure({})).toBe('未知错误')
  })

  test('EMPTY_REPO 不在映射表里，仍走后端文案（不覆盖已有的空仓库提示）', () => {
    const backendText = '当前仓库没有任何提交，请先在左侧暂存并提交至少一个文件后再推送。'
    expect(describePushFailure({ error: backendText, errorCode: 'EMPTY_REPO' })).toBe(backendText)
  })
})
