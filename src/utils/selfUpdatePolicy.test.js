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
// src/utils/selfUpdatePolicy.js 纯函数单元测试(node:test 内置)。
//
// 回归的核心一条:v2.17.21 那次 release 里 35 轮探针全报 404,结果是
// "npm install 一次都没真跑过"。这里用同样的输入序列断言"必须拿到真装机会"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldAttemptInstall,
  shouldFinalAttempt,
  FORCE_INSTALL_EVERY,
} from './selfUpdatePolicy.js'

const MISSING = { ok: false, status: 404 }
const NET_ERROR = { ok: false, status: 0, error: 'fetch failed' }
const OK = { ok: true, status: 206 }

// ========== 两个就绪信号 ==========

test('shouldAttemptInstall: packument 已有该版本 → 真装(即使探针说 404)', () => {
  const plan = shouldAttemptInstall({ attempt: 1, probe: MISSING, packumentHasVersion: true })
  assert.deepEqual(plan, { attempt: true, reason: 'packument-ready' })
})

test('shouldAttemptInstall: tarball 已可取 → 真装', () => {
  const plan = shouldAttemptInstall({ attempt: 1, probe: OK, packumentHasVersion: false })
  assert.deepEqual(plan, { attempt: true, reason: 'tarball-ready' })
})

test('shouldAttemptInstall: packument 优先于 tarball(两条路都在时按前者排 spec)', () => {
  const plan = shouldAttemptInstall({ attempt: 1, probe: OK, packumentHasVersion: true })
  assert.equal(plan.reason, 'packument-ready')
})

// ========== 探针"没结论"不许当结果 ==========

test('shouldAttemptInstall: 探针网络失败(status=0)→ 真装,不跳过', () => {
  const plan = shouldAttemptInstall({ attempt: 1, probe: NET_ERROR, packumentHasVersion: false })
  assert.deepEqual(plan, { attempt: true, reason: 'probe-failed' })
})

test('shouldAttemptInstall: 探针带 error 字段 → 真装,不跳过', () => {
  const plan = shouldAttemptInstall({
    attempt: 2,
    probe: { ok: false, status: 0, error: 'ECONNRESET' },
    packumentHasVersion: false,
  })
  assert.equal(plan.attempt, true)
  assert.equal(plan.reason, 'probe-failed')
})

test('shouldAttemptInstall: 拿不到探针结果(undefined/null)→ 真装,不跳过', () => {
  for (const probe of [undefined, null]) {
    const plan = shouldAttemptInstall({ attempt: 1, probe, packumentHasVersion: false })
    assert.equal(plan.attempt, true, `probe=${probe} 时必须真装`)
    assert.equal(plan.reason, 'probe-failed')
  }
})

test('shouldAttemptInstall: 老 Node 拿不到 fetch 时的 unknown 形态 → 真装', () => {
  const plan = shouldAttemptInstall({
    attempt: 1,
    probe: { ok: true, unknown: true },
    packumentHasVersion: false,
  })
  assert.deepEqual(plan, { attempt: true, reason: 'tarball-ready' })
})

// ========== 明确 404:可以跳过,但必须按期强制真试 ==========

test('shouldAttemptInstall: 探针 404 且未到强制轮 → 跳过', () => {
  for (const attempt of [1, 2, 3]) {
    const plan = shouldAttemptInstall({ attempt, probe: MISSING, packumentHasVersion: false })
    assert.equal(plan.attempt, false, `第 ${attempt} 轮不该跳过以外的行为`)
    assert.equal(plan.reason, 'probe-says-missing')
  }
})

test('shouldAttemptInstall: 探针 404,第 4/8 轮强制真试', () => {
  for (const attempt of [4, 8, 12]) {
    const plan = shouldAttemptInstall({ attempt, probe: MISSING, packumentHasVersion: false })
    assert.deepEqual(plan, { attempt: true, reason: 'forced' }, `第 ${attempt} 轮应强制`)
  }
})

test('shouldAttemptInstall: 探针回 403/500 等非 404 状态 → 同样按强制节奏,不当成"可取"', () => {
  const early = shouldAttemptInstall({ attempt: 1, probe: { ok: false, status: 500 }, packumentHasVersion: false })
  assert.equal(early.attempt, false)
  const forced = shouldAttemptInstall({ attempt: 4, probe: { ok: false, status: 500 }, packumentHasVersion: false })
  assert.equal(forced.reason, 'forced')
})

test('shouldAttemptInstall: forceEvery=0 关闭强制 → 404 一直跳过(只有探针/超时兜底)', () => {
  for (const attempt of [1, 4, 8, 40]) {
    const plan = shouldAttemptInstall({
      attempt,
      probe: MISSING,
      packumentHasVersion: false,
      forceEvery: 0,
    })
    assert.equal(plan.attempt, false)
  }
})

test('shouldAttemptInstall: forceEvery 可覆盖(测试/调参用)', () => {
  const plan = shouldAttemptInstall({
    attempt: 2,
    probe: MISSING,
    packumentHasVersion: false,
    forceEvery: 2,
  })
  assert.equal(plan.reason, 'forced')
})

// ========== 事故回归:35 轮全 404,不许零真试 ==========

test('回归 v2.17.21:探针连续 35 轮 404 时,真试次数必须 ≥ 8 且第 4 轮就开始', () => {
  const attempts = []
  for (let attempt = 1; attempt <= 35; attempt += 1) {
    const plan = shouldAttemptInstall({ attempt, probe: MISSING, packumentHasVersion: false })
    if (plan.attempt) attempts.push(attempt)
  }
  // 旧实现:attempts 为空(probe.ok 恒 false → 一次 npm 都没调)
  assert.ok(attempts.length > 0, '不允许出现"整轮零真试"')
  assert.equal(attempts[0], FORCE_INSTALL_EVERY, '第 4 轮就必须开始真试,而不是等满 600s')
  assert.ok(attempts.length >= 8, `600s(35 轮)里至少 8 次真装机会,实际 ${attempts.length}`)
})

// ========== 超时前的最后一次真试 ==========

test('shouldFinalAttempt: 整轮没真装过 → 补最后一次', () => {
  assert.equal(shouldFinalAttempt({ installAttempts: 0, lastRoundAttempted: false }), true)
})

test('shouldFinalAttempt: 最后一轮刚试过 → 不补(几秒前才失败,再试无意义)', () => {
  assert.equal(shouldFinalAttempt({ installAttempts: 9, lastRoundAttempted: true }), false)
})

test('shouldFinalAttempt: 试过但最后一轮在跳过 → 仍补一次', () => {
  assert.equal(shouldFinalAttempt({ installAttempts: 8, lastRoundAttempted: false }), true)
})
