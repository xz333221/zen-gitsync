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
// originGuard.js 单元测试。
//
// 锁两条契约：
//   1. 本机来源（localhost / 127.0.0.1 / [::1] 任意端口）必须放行 —— 否则开发期
//      Vite dev server（端口与后端不同）会全站 403，是典型的自伤式加固。
//   2. 外部来源必须拒绝 —— 服务无认证层，漏一个就是全权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOriginChecker, createOriginCheckerFromEnv } from './originGuard.js'

/** 跑一次中间件，返回 { allowed, status } */
function runGuard(origin, envPatch = {}) {
  const saved = {}
  for (const [k, v] of Object.entries(envPatch)) {
    saved[k] = process.env[k]
    if (v === null) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const isAllowed = createOriginCheckerFromEnv()(origin)
    return { allowed: isAllowed }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('无 Origin 头放行(curl / CLI / 同源 GET 不该被拦)', () => {
  assert.equal(runGuard(undefined).allowed, true)
  assert.equal(runGuard('').allowed, true)
})

test('本机 hostname 的任意端口都放行(开发期前后端不同端口)', () => {
  for (const ok of [
    'http://localhost:5545',
    'http://localhost:5544',
    'http://127.0.0.1:5545',
    'https://127.0.0.1:3000',
    'http://[::1]:8080'
  ]) {
    assert.equal(runGuard(ok).allowed, true, `应放行 ${ok}`)
  }
})

test('外部来源一律拒绝(挡跨站 fetch 与 DNS rebinding)', () => {
  for (const bad of [
    'http://evil.com',
    'https://evil.com:5545',
    'http://attacker.example',
    'http://192.168.1.66:5545',   // 局域网其他主机
    'http://localhost.evil.com'   // 看着像 localhost 实则是外部域名
  ]) {
    assert.equal(runGuard(bad).allowed, false, `应拒绝 ${bad}`)
  }
})

test('file:// 场景的 null origin 放行', () => {
  assert.equal(runGuard('null').allowed, true)
})

test('ZEN_ALLOWED_ORIGINS 可追加放行来源', () => {
  assert.equal(
    runGuard('https://zen.example.com', { ZEN_ALLOWED_ORIGINS: 'https://zen.example.com' }).allowed,
    true
  )
  // 追加不影响默认拒绝行为
  assert.equal(
    runGuard('http://evil.com', { ZEN_ALLOWED_ORIGINS: 'https://zen.example.com' }).allowed,
    false
  )
})

test('ZEN_HOST 放开监听时,该 host 的来源要一并放行(否则用户被自己的守卫拦在门外)', () => {
  assert.equal(runGuard('http://192.168.1.10:5545', { ZEN_HOST: '192.168.1.10' }).allowed, true)
  // 未放开时,同一个来源仍然拒绝
  assert.equal(runGuard('http://192.168.1.10:5545', { ZEN_HOST: null }).allowed, false)
})

test('ZEN_HOST=0.0.0.0 时本机各网卡 IP 的来源放行(跨设备访问 GUI 的场景)', async () => {
  const os = await import('node:os')
  // 取一个真实存在的本机非回环 IPv4 地址来构造 origin;没有则跳过
  const lanIp = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
  if (!lanIp) return
  assert.equal(runGuard(`http://${lanIp}:5545`, { ZEN_HOST: '0.0.0.0' }).allowed, true)
  // 通配绑定也不等于任意来源放行:外部域名与别的 LAN IP 仍拒绝
  assert.equal(runGuard('http://evil.com', { ZEN_HOST: '0.0.0.0' }).allowed, false)
  assert.equal(runGuard('http://203.0.113.9:5545', { ZEN_HOST: '0.0.0.0' }).allowed, false)
  // 未设 ZEN_HOST 时,同一个本机 IP 来源仍然拒绝
  assert.equal(runGuard(`http://${lanIp}:5545`, { ZEN_HOST: null }).allowed, false)
})

test('createOriginChecker: extraOrigins / extraHosts 生效', () => {
  const check = createOriginChecker({
    extraOrigins: ['https://a.example.com'],
    extraHosts: ['10.0.0.5']
  })
  assert.equal(check('https://a.example.com'), true)
  assert.equal(check('http://10.0.0.5:1234'), true) // extraHosts 允许任意端口
  assert.equal(check('http://b.example.com'), false)
  assert.equal(check(undefined), true)
})

test('createOriginChecker: 无法解析的 origin 一律拒绝', () => {
  const check = createOriginChecker()
  assert.equal(check('not-a-url'), false)
  assert.equal(check('::::'), false)
})
