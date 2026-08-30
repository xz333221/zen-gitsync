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
// startServerOnAvailablePort 单元测试。
//
// 这里锁两件事：
//
// 1. 监听地址。GUI 服务没有认证层，listen() 不传 host 就会绑到 0.0.0.0，等于把
//    /api/exec-stream（命令执行）、/api/add-npm-script（写 package.json）等接口
//    裸奔在局域网上。默认必须是回环地址，只有显式设置 ZEN_HOST 或显式传 host
//    参数才放开。这组测试防止有人图省事改回 0.0.0.0。
//
// 2. 端口重试不能把自己挂死。server.listen(port, host, cb) 的 cb 实际被注册成
//    once('listening', cb)，而 listen 失败时只 emit 'error'，这个 cb 摘不掉。
//    等后面某次 listen 成功 emit 'listening'，历史残留的 cb 会和新 cb 一起被
//    依次触发。残留 cb 抢先跑完会把防重入标志置位，本次真正成功的回调就直接
//    return，await 永久挂起 —— 服务表现为"卡住起不来"。
//    Windows 上 EACCES（系统保留端口）顺延时必现。下面第 2 组测试专门盯这个。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  startServerOnAvailablePort,
  parseExcludedPortRanges
} from './startServerOnAvailablePort.js'

// 极简 chalk：只需要 .green / .yellow / .cyan 能把原串返回
const chalk = new Proxy({}, { get: () => (s) => String(s) })

/**
 * 模拟真实 http.Server 的 listen 语义。
 *
 * 重点复刻上面提到的那个坑：listen 失败时只 emit 'error'，已注册的 listening
 * 回调一个都不摘；等某次 listen 成功，所有历史残留回调会和新回调一起被触发。
 *
 * @param {object} [opts]
 * @param {number[]} [opts.failPorts] 这些端口上让 listen 失败
 * @param {string} [opts.errorCode] 失败时注入的 errno
 */
function createFakeHttpServer({ failPorts = [], errorCode = 'EACCES' } = {}) {
  const calls = []
  const listening = []
  const errors = []
  const server = {
    calls,
    once(event, fn) {
      if (event === 'listening') listening.push(fn)
      else if (event === 'error') errors.push(fn)
    },
    removeListener(event, fn) {
      const list = event === 'listening' ? listening : errors
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    address() {
      return server._addr || null
    },
    listen(...args) {
      const port = args[0]
      let host
      let cb
      if (typeof args[1] === 'function') {
        cb = args[1]
      } else {
        host = args[1]
        cb = args[2]
      }
      calls.push({ port, host })
      // Node 的真实语义：回调被注册成 once('listening', cb)
      if (cb) listening.push(cb)

      setImmediate(() => {
        if (failPorts.includes(port)) {
          // 失败：只 emit 'error'，listening 回调一个都不摘（关键）
          const err = new Error(`${errorCode} ${port}`)
          err.code = errorCode
          errors.splice(0).forEach((fn) => fn(err))
          return
        }
        server._addr = { address: host || '127.0.0.1', port }
        // 成功：触发全部 listening 回调，包含历史失败残留的那些
        listening.splice(0).forEach((fn) => fn())
      })
    }
  }
  return server
}

/**
 * 跑一次启动流程。
 *
 * 端口默认取 47000 且 maxTries 给足：万一真撞进系统保留段触发"整段跳跃"，
 * 也有足够回旋空间试到成功，不至于让测试因为耗尽尝试次数而退出。
 *
 * @param {object} [opts]
 * @param {number[]} [opts.failPorts] 让哪些端口的 listen 失败
 * @param {string} [opts.errorCode] 注入的 errno
 * @param {string|null} [opts.zenHost] ZEN_HOST 取值；null 表示删除该变量
 * @param {object} [opts.rest] 直接透传给 startServerOnAvailablePort 的参数
 */
async function startOnce({
  failPorts = [],
  errorCode = 'EACCES',
  zenHost = null,
  startPort = 47000,
  maxTries = 20,
  rest = {}
} = {}) {
  const httpServer = createFakeHttpServer({ failPorts, errorCode })
  const envBak = process.env.ZEN_HOST
  const notifyBak = process.env.ZEN_RESTART_NOTIFY_PATH
  // 清掉重启通知路径，避免测试真的往环境里写文件
  delete process.env.ZEN_RESTART_NOTIFY_PATH
  if (zenHost === null) delete process.env.ZEN_HOST
  else process.env.ZEN_HOST = zenHost

  // 启动成功时会 console.log 一大段横幅，静音掉以保持测试输出干净
  const logBak = console.log
  console.log = () => {}

  try {
    const port = await startServerOnAvailablePort({
      httpServer,
      startPort,
      chalk,
      open: async () => {},
      noOpen: true,
      isGitRepo: true,
      savePortToFile: () => {},
      maxTries,
      callbackExecutedRef: { value: false },
      ...rest
    })
    return { port, calls: httpServer.calls }
  } finally {
    console.log = logBak
    if (envBak === undefined) delete process.env.ZEN_HOST
    else process.env.ZEN_HOST = envBak
    if (notifyBak === undefined) delete process.env.ZEN_RESTART_NOTIFY_PATH
    else process.env.ZEN_RESTART_NOTIFY_PATH = notifyBak
  }
}

// ---------------------------------------------------------------------------
// 1. 监听地址：默认是回环，不能退化成 0.0.0.0
// ---------------------------------------------------------------------------

test('默认监听 127.0.0.1，不会绑到 0.0.0.0', async () => {
  const { calls } = await startOnce()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].port, 47000)
  assert.equal(calls[0].host, '127.0.0.1')
})

test('ZEN_HOST=0.0.0.0 时放开到所有网卡', async () => {
  const { calls } = await startOnce({ zenHost: '0.0.0.0' })
  assert.equal(calls[0].host, '0.0.0.0')
})

test('显式传 host 参数优先于环境变量', async () => {
  const { calls } = await startOnce({ zenHost: '0.0.0.0', rest: { host: '127.0.0.1' } })
  assert.equal(calls[0].host, '127.0.0.1')
})

test('ZEN_HOST 为空串或纯空白时回落默认回环地址', async () => {
  assert.equal((await startOnce({ zenHost: '' })).calls[0].host, '127.0.0.1')
  assert.equal((await startOnce({ zenHost: '   ' })).calls[0].host, '127.0.0.1')
})

// ---------------------------------------------------------------------------
// 2. 端口重试：不能挂死，且每次尝试都必须带 host
// ---------------------------------------------------------------------------

test('端口被占用(EADDRINUSE)时顺延到下一个端口，且每次都带上 host', async () => {
  const { port, calls } = await startOnce({
    failPorts: [47000],
    errorCode: 'EADDRINUSE'
  })

  assert.equal(port, 47001)
  assert.ok(calls.length >= 2, '应该有端口重试')
  // 每一次尝试都必须带 host，否则重试那一次又会退化成 0.0.0.0
  for (const call of calls) {
    assert.equal(call.host, '127.0.0.1')
  }
})

test('端口无监听权限(EACCES)时顺延重试，不会直接退出进程', async () => {
  // 系统保留端口（Windows 排除段）上报的就是 EACCES：端口没人占，就是不让绑。
  // 修复前这条路径走 else 分支 process.exit(1)，服务直接起不来。
  const { port, calls } = await startOnce({
    failPorts: [47000, 47001],
    errorCode: 'EACCES'
  })

  assert.equal(port, 47002)
  assert.ok(calls.length >= 3, `应重试直到成功，实际只尝试了 ${calls.length} 次`)

  for (const call of calls) {
    assert.equal(call.host, '127.0.0.1')
  }

  // 端口必须严格递增。"整段跳过保留区"若写错（比如跳回段首）会死循环，这里兜住
  const ports = calls.map((c) => c.port)
  for (let i = 1; i < ports.length; i++) {
    assert.ok(ports[i] > ports[i - 1], `端口应严格递增，实际: ${ports.join(' -> ')}`)
  }
})

test('前一次失败留下的 listening 残留回调，不会让本次成功卡死', async (t) => {
  // 这是最容易复现、也最致命的一个坑：
  // listen 失败只 emit 'error'，之前注册的 listening 回调摘不掉。等下一个端口
  // listen 成功 emit 'listening'，历史残留回调会先跑一遍 —— 它若抢先把防重入
  // 标志置位，本次真正成功的回调就会直接 return，await 永久挂起。
  //
  // fake server 已复刻该语义（失败时不清 listening 队列）。若防护被改坏，
  // 这个用例会挂起，靠 timeout 判失败而不是默默卡死整个测试进程。
  t.diagnostic('防护失效时此用例会挂起，timeout 会让它失败')
  const { port } = await startOnce({ failPorts: [47000], errorCode: 'EACCES' })
  assert.equal(port, 47001)
}, { timeout: 5000 })

// ---------------------------------------------------------------------------
// 3. Windows 保留端口段解析
// ---------------------------------------------------------------------------

test('解析 netsh 排除端口输出：中英文表头都要认', () => {
  const zh = [
    '',
    '协议 tcp 端口排除范围',
    '',
    '开始端口    结束端口      ',
    '----------    --------      ',
    '      2869        2869      ',
    '      4311        4410      ',
    '     5544        5545     *',
    '',
    '* - 管理的端口排除。',
    ''
  ].join('\n')

  assert.deepEqual(parseExcludedPortRanges(zh), [
    [2869, 2869],
    [4311, 4410],
    [5544, 5545]
  ])

  const en = [
    'Protocol tcp Port Exclusion Ranges',
    '',
    'Start Port    End Port      ',
    '----------    --------      ',
    '      2869        2869      ',
    '      4311        4410      ',
    ''
  ].join('\n')

  assert.deepEqual(parseExcludedPortRanges(en), [
    [2869, 2869],
    [4311, 4410]
  ])
})

test('解析 netsh 输出：异常输入返回空数组而不是抛错', () => {
  // 表头、分隔线、说明文字都不含数字对，不该被误当成端口段
  assert.deepEqual(parseExcludedPortRanges(''), [])
  assert.deepEqual(parseExcludedPortRanges(null), [])
  assert.deepEqual(parseExcludedPortRanges(undefined), [])
  assert.deepEqual(parseExcludedPortRanges('garbage output\nno ranges here'), [])
  assert.deepEqual(parseExcludedPortRanges('开始端口    结束端口'), [])
})
