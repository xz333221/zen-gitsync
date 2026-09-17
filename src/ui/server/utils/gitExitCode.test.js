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
// gitExitCode.js 单元测试。
//
// 重点不是「文案写得好不好」，而是三条判定边界不能串：
//   1. 有 git 输出 → 必须原样透传（errorCode 留空），不能被通用文案覆盖
//   2. 零输出 + 已知退出码 → 必须给出可读文案，且带上 errorCode 供前端本地化
//   3. 零输出 + 未知退出码 → 兜底文案里必须出现十六进制码，不能只说 "failed"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatExitCode,
  describeGitExitCode,
  describeGitProcessFailure,
  GIT_NOT_FOUND
} from './gitExitCode.js'

test('formatExitCode: NTSTATUS 转十六进制，正常退出码保持十进制', () => {
  // 用户报障里的原始数字
  assert.equal(formatExitCode(3221225794), '0xC0000142')
  assert.equal(formatExitCode(0xC0000005), '0xC0000005')
  assert.equal(formatExitCode(128), '128')
  assert.equal(formatExitCode(0), '0')
  // 非数字不该抛
  assert.equal(formatExitCode(null), 'null')
  assert.equal(formatExitCode(undefined), 'undefined')
})

test('formatExitCode: 负数退出码按无符号解释', () => {
  // POSIX 下被信号杀时 Node 给的是 null，但保险起见负数也要能格式化
  assert.equal(formatExitCode(-1073741819), '0xC0000005')
})

test('describeGitExitCode: 已知码返回文案 + errorCode', () => {
  const initFailed = describeGitExitCode(3221225794)
  assert.equal(initFailed.errorCode, 'PROCESS_INIT_FAILED')
  // 文案里必须出现真正的十六进制码（用户要靠它去搜 / 报障）
  assert.match(initFailed.error, /0xC0000142/)
  // 必须明确告诉用户"可以重试"，这是这类瞬时故障唯一有效的处置方式
  assert.match(initFailed.error, /重试/)

  assert.equal(describeGitExitCode(0xC0000135).errorCode, 'PROCESS_DLL_NOT_FOUND')
  assert.equal(describeGitExitCode(0xC0000005).errorCode, 'PROCESS_CRASHED')
  assert.equal(describeGitExitCode(0xC0000017).errorCode, 'PROCESS_NO_MEMORY')
  assert.equal(describeGitExitCode(0xC000013A).errorCode, 'PROCESS_INTERRUPTED')
})

test('describeGitExitCode: 未知码 / 正常退出码返回 null', () => {
  assert.equal(describeGitExitCode(1), null)
  assert.equal(describeGitExitCode(128), null)
  assert.equal(describeGitExitCode(0), null)
  assert.equal(describeGitExitCode(null), null)
  assert.equal(describeGitExitCode(undefined), null)
})

test('describeGitProcessFailure: git 有输出时原样透传，不覆盖成通用文案', () => {
  const gitFatal = 'fatal: failed to push some refs to https://example.com/x.git'
  const res = describeGitProcessFailure({ code: 128, stderr: gitFatal })
  assert.equal(res.error, gitFatal)
  assert.equal(res.errorCode, null)
  assert.equal(res.exitCode, 128)

  // stderr 只有空白时，应当退到 stdout，而不是判定成"零输出"
  const res2 = describeGitProcessFailure({ code: 1, stdout: 'remote: Permission denied\n', stderr: '\n' })
  assert.equal(res2.error, 'remote: Permission denied')
  assert.equal(res2.errorCode, null)
})

test('describeGitProcessFailure: 零输出 + 0xC0000142 → 可读文案（用户报障场景）', () => {
  const res = describeGitProcessFailure({ code: 3221225794, stdout: '', stderr: '' })
  assert.equal(res.errorCode, 'PROCESS_INIT_FAILED')
  assert.equal(res.exitCode, 3221225794)
  assert.match(res.error, /0xC0000142/)
  // 绝不能退化成当初那句对用户毫无信息量的兜底
  assert.doesNotMatch(res.error, /Push failed with code/)
})

test('describeGitProcessFailure: 零输出 + 未知码 → 兜底文案带十六进制码', () => {
  const res = describeGitProcessFailure({ code: 3221225725 }) // 0xC00000FD 栈溢出，不在码表里
  assert.equal(res.errorCode, 'PROCESS_EXITED')
  assert.equal(res.exitCode, 3221225725)
  assert.match(res.error, /0xC00000FD/)
  assert.match(res.error, /重试/)
})

test('describeGitProcessFailure: 无参调用不抛异常', () => {
  const res = describeGitProcessFailure()
  assert.equal(res.errorCode, 'PROCESS_EXITED')
  assert.equal(res.exitCode, null)
  assert.equal(res.error, 'git 进程异常退出（退出码 null），且没有产生任何输出——通常是进程未能成功启动，请重试。')
})

test('GIT_NOT_FOUND: 常量形状与前端约定一致', () => {
  assert.equal(GIT_NOT_FOUND.errorCode, 'GIT_NOT_FOUND')
  assert.match(GIT_NOT_FOUND.error, /PATH/)
})
