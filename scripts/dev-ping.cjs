#!/usr/bin/env node
// 一次性探测 dev server 状态。
// 用法: npm run dev:ping
// 后端默认 5545,vite 默认 5544。后端 port 会写进 .port 文件,本脚本读 .port 取真实端口。

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

function readBackendPort() {
  try {
    const portFile = path.resolve(__dirname, '..', '.port')
    if (fs.existsSync(portFile)) {
      const p = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10)
      if (!Number.isNaN(p)) return p
    }
  } catch { /* 忽略,落回默认 */ }
  return 5545
}

function probe(host, port, urlPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout: timeoutMs }, (res) => {
      res.resume() // 消费掉响应体,避免 socket hang
      resolve({ ok: true, status: res.statusCode })
    })
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'TIMEOUT' })
    })
  })
}

function statusIcon(ok, status) {
  if (!ok) return '[ DOWN ]'
  if (status >= 200 && status < 400) return '[  OK  ]'
  return `[  ${status}  ]`
}

;(async () => {
  const backendPort = readBackendPort()
  console.log('dev server status:')

  const backend = await probe('127.0.0.1', backendPort, '/api/app-version')
  console.log(`  ${statusIcon(backend.ok, backend.status)}  backend  127.0.0.1:${backendPort}/api/app-version`)

  const vite = await probe('127.0.0.1', 5544, '/@vite/client')
  console.log(`  ${statusIcon(vite.ok, vite.status)}  vite     127.0.0.1:5544/@vite/client`)

  console.log('')
  if (!backend.ok) {
    console.log(`! backend 没起: cd 项目根 → npm run dev:server`)
  }
  if (!vite.ok) {
    console.log(`! vite 没起: cd 项目根 → npm run start:vue  (或整体 npm run dev)`)
  }
  if (backend.ok && vite.ok) {
    console.log('一切正常,可以开始改前端代码。')
  }
})()
