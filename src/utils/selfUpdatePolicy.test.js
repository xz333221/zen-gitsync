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
  nextPollIntervalMs,
  classifyInstallError,
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

// ========== 轮询间隔退避(窗口从 600s 提到 30 分钟后必须有) ==========

const INTERVAL_CFG = { fastWindowMs: 600_000, fastIntervalMs: 15_000, slowIntervalMs: 60_000 }

test('nextPollIntervalMs: 前段(600s 内)保持密集 15s', () => {
  for (const elapsedMs of [0, 1_000, 599_999]) {
    assert.equal(nextPollIntervalMs({ ...INTERVAL_CFG, elapsedMs }), 15_000, `elapsed=${elapsedMs}`)
  }
})

test('nextPollIntervalMs: 到点即切到慢炖 60s(边界取后段)', () => {
  assert.equal(nextPollIntervalMs({ ...INTERVAL_CFG, elapsedMs: 600_000 }), 60_000)
  assert.equal(nextPollIntervalMs({ ...INTERVAL_CFG, elapsedMs: 1_500_000 }), 60_000)
})

test('nextPollIntervalMs: 30 分钟窗口的总轮数可控(不是"15s 跳 120 轮")', () => {
  // 前 600s / 15s = 40 轮;剩下 1200s / 60s = 20 轮 → 60 轮封顶
  const total = 600_000 / 15_000 + (1_800_000 - 600_000) / 60_000
  assert.equal(total, 60)
  assert.ok(total <= 60, '长窗口不许把日志刷成上百轮')
})

// ========== 失败归类(放弃时汇总"卡在哪") ==========

test('classifyInstallError: E404 / ETARGET → registry 还没就绪', () => {
  assert.equal(classifyInstallError('npm error code E404\nnpm error 404 Not Found - GET https://...'), 'E404')
  assert.equal(classifyInstallError('npm error code ETARGET\nnpm error No matching version found'), 'ETARGET')
})

test('classifyInstallError: EPERM / EBUSY → 文件被占(和"还没就绪"完全不同的处置)', () => {
  assert.equal(classifyInstallError('npm warn cleanup Failed to remove some directories: EPERM'), 'EPERM')
  assert.equal(classifyInstallError('npm error EBUSY: resource busy or locked'), 'EPERM')
})

test('classifyInstallError: npm 的 code 行是最终裁决(v2.17.25 实测回归)', () => {
  // v2.17.25 真实形态:registry 还没就绪(E404)的每一轮都附带 npm warn cleanup EPERM
  // (删旧全局目录的噪声)。旧判法按"EPERM 子串优先"误判成文件占用,
  // 导致每轮反复停实例 + 强删全局目录。有 code 行时必须以它为准。
  const notReady = [
    'npm warn cleanup Failed to remove some directories: EPERM',
    'npm error code E404',
    'npm error 404 Not Found - GET https://registry.npmjs.org/zen-gitsync/-/zen-gitsync-2.17.25.tgz - Not found',
  ].join('\n')
  assert.equal(classifyInstallError(notReady), 'E404')
  // npm 自己裁决成文件占用 → 才允许走"杀实例 + 清目录"
  assert.equal(classifyInstallError('npm error code EPERM\nnpm error rename EPERM: operation not permitted'), 'EPERM')
  // EBUSY 与 EPERM 同属"文件被占",归进同一个桶
  assert.equal(classifyInstallError('npm error code EBUSY\nnpm error resource busy or locked'), 'EPERM')
  // 没见过的码原样返回,不硬塞进既有短码
  assert.equal(classifyInstallError('npm error code EAI_AGAIN\nnpm error getaddrinfo EAI_AGAIN'), 'EAI_AGAIN')
})

test('classifyInstallError: 网络类与空输入不炸,各有短码', () => {
  assert.equal(classifyInstallError('npm error code ENOTFOUND registry.npmjs.org'), 'ENOTFOUND')
  assert.equal(classifyInstallError('npm error code ETIMEDOUT'), 'ETIMEDOUT')
  assert.equal(classifyInstallError('npm error ECONNRESET'), 'ENETUNREACH')
  assert.equal(classifyInstallError(''), '其他')
  assert.equal(classifyInstallError(undefined), '其他')
  assert.equal(classifyInstallError('some unknown failure'), '其他')
})

test('classifyInstallError: 无 code 行时,error 行里的文件占用类仍优先于 registry 类', () => {
  // 两条都是 error 行、又没有裁决 code 行 → 文件占用是唯一要"动手"的那类,优先报
  const mixed = 'npm error E404 Not Found - GET https://...\nnpm error EPERM: operation not permitted'
  assert.equal(classifyInstallError(mixed), 'EPERM')
})
