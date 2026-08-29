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
// 这里只锁一件事：监听地址。
// GUI 服务没有认证层，listen() 不传 host 就会绑到 0.0.0.0，等于把
// /api/exec-stream（命令执行）、/api/add-npm-script（写 package.json）
// 等接口裸奔在局域网上。默认必须是回环地址，只有显式设置 ZEN_HOST
// 或显式传 host 参数才放开。这组测试就是防止有人图省事改回 0.0.0.0。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startServerOnAvailablePort } from './startServerOnAvailablePort.js'

// 极简 chalk：只需要 .green / .yellow / .cyan 能把原串返回
const chalk = new Proxy({}, { get: () => (s) => String(s) })

/** 最小 httpServer mock，只记录 listen 的入参 */
function createFakeHttpServer() {
  const calls = []
  const handlers = new Map()
  const server = {
    calls,
    once(event, fn) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(fn)
    },
    on(event, fn) { server.once(event, fn) },
    removeListener(event, fn) {
      const list = handlers.get(event) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    listen(...args) {
      // 同时兼容 listen(port, cb) 与 listen(port, host, cb) 两种形态
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
      if (cb) setImmediate(cb)
    }
  }
  return server
}

/**
 * 跑一次启动流程，返回 listen 的调用记录。
 * @param {object} opts
 * @param {string|null} [opts.zenHost] 本次运行时 ZEN_HOST 的取值；null 表示删除该变量
 * @param {object} [opts.rest] 直接透传给 startServerOnAvailablePort 的参数（如 host）
 */
async function listenOnce(opts = {}) {
  const httpServer = createFakeHttpServer()
  const envBak = process.env.ZEN_HOST
  const notifyBak = process.env.ZEN_RESTART_NOTIFY_PATH
  // 清掉重启通知路径，避免测试真的往 tmpdir 写文件
  delete process.env.ZEN_RESTART_NOTIFY_PATH

  if ('zenHost' in opts) {
    if (opts.zenHost === null) delete process.env.ZEN_HOST
    else process.env.ZEN_HOST = opts.zenHost
  }

  // 启动成功时会 console.log 一大段横幅，静音掉以保持测试输出干净
  const logBak = console.log
  console.log = () => {}

  try {
    await startServerOnAvailablePort({
      httpServer,
      startPort: 4000,
      chalk,
      open: async () => {},
      noOpen: true,
      isGitRepo: true,
      savePortToFile: () => {},
      maxTries: 1,
      callbackExecutedRef: { value: false },
      ...(opts.rest || {})
    })
    return httpServer.calls
  } finally {
    console.log = logBak
    if (envBak === undefined) delete process.env.ZEN_HOST
    else process.env.ZEN_HOST = envBak
    if (notifyBak === undefined) delete process.env.ZEN_RESTART_NOTIFY_PATH
    else process.env.ZEN_RESTART_NOTIFY_PATH = notifyBak
  }
}

test('默认监听 127.0.0.1，不会绑到 0.0.0.0', async () => {
  const calls = await listenOnce({ zenHost: null })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].port, 4000)
  assert.equal(calls[0].host, '127.0.0.1')
})

test('ZEN_HOST=0.0.0.0 时放开到所有网卡', async () => {
  const calls = await listenOnce({ zenHost: '0.0.0.0' })
  assert.equal(calls[0].host, '0.0.0.0')
})

test('显式传 host 参数优先于环境变量', async () => {
  const calls = await listenOnce({ zenHost: '0.0.0.0', rest: { host: '127.0.0.1' } })
  assert.equal(calls[0].host, '127.0.0.1')
})

test('ZEN_HOST 为空串或纯空白时回落默认回环地址', async () => {
  assert.equal((await listenOnce({ zenHost: '' }))[0].host, '127.0.0.1')
  assert.equal((await listenOnce({ zenHost: '   ' }))[0].host, '127.0.0.1')
})

test('端口占用时顺延到下一个端口，且每次都带上 host', async () => {
  const httpServer = createFakeHttpServer()
  // 第一次 listen 触发 EADDRINUSE，第二次成功
  let first = true
  httpServer.listen = (...args) => {
    httpServer.calls.push({ port: args[0], host: args[1] })
    const cb = typeof args[1] === 'function' ? args[1] : args[2]
    const handlers = httpServer._errorHandlers || []
    if (first) {
      first = false
      setImmediate(() => {
        const err = new Error('busy')
        err.code = 'EADDRINUSE'
        handlers.forEach((fn) => fn(err))
      })
    } else if (cb) {
      setImmediate(cb)
    }
  }
  const origOnce = httpServer.once.bind(httpServer)
  httpServer.once = (event, fn) => {
    if (event === 'error') {
      httpServer._errorHandlers = httpServer._errorHandlers || []
      httpServer._errorHandlers.push(fn)
    }
    return origOnce(event, fn)
  }

  const logBak = console.log
  console.log = () => {}
  try {
    await startServerOnAvailablePort({
      httpServer,
      startPort: 4000,
      chalk,
      open: async () => {},
      noOpen: true,
      isGitRepo: true,
      savePortToFile: () => {},
      maxTries: 5,
      callbackExecutedRef: { value: false }
    })
  } finally {
    console.log = logBak
  }

  assert.ok(httpServer.calls.length >= 2, '应该有端口重试')
  // 每一次尝试都必须带 host，否则重试那一次又会退化成 0.0.0.0
  for (const call of httpServer.calls) {
    assert.equal(call.host, '127.0.0.1')
  }
})
