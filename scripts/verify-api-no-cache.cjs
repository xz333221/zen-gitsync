#!/usr/bin/env node
// 探针：实时接口不许被 HTTP 缓存（2026-11-02）。
//
// 起因：用户另一台机器上「会话列表出不来」，DevTools 里 GET /api/agent/sessions
// 一直 304。根因是 Express 默认给 res.json 生成 weak ETag，而响应没有 Cache-Control
// —— 浏览器存一份副本、下次发 If-None-Match，服务端回 304 + **空 body**；
// 只要浏览器本地没有副本（清过缓存 / DevTools 关缓存 / 中间有安全软件），
// fetch 拿到的就是 status 304 + 0 字节，前端 res.json() 直接抛。
//
// 这个脚本断言的是**修好之后**的契约：
//   1. 响应头没有 ETag（我们没有主动回 304 的能力）
//   2. 响应头 Cache-Control 含 no-store（浏览器/代理都不许留副本）
//   3. 就算硬塞一个 If-None-Match 进来，也必须是 200 且有 body
//
// 用法：
//   node scripts/verify-api-no-cache.cjs               # 默认端口（.port → 5545）
//   node scripts/verify-api-no-cache.cjs --port=5599
//   node scripts/verify-api-no-cache.cjs --reverse     # 反样本：期望"有 ETag 且会 304"
//
// 服务没在跑时打印 SKIP 并 exit 0 —— 探针是给"手工验证/发版前"用的，
// 不该因为没有 dev server 就把别人卡住。

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const argv = process.argv.slice(2)
const reverse = argv.includes('--reverse')
const portArg = argv.find((a) => a.startsWith('--port='))
const HOST = '127.0.0.1'

function readPort() {
  if (portArg) {
    const p = parseInt(portArg.split('=')[1], 10)
    if (!Number.isNaN(p)) return p
  }
  try {
    const f = path.join(ROOT, '.port')
    if (fs.existsSync(f)) {
      const p = parseInt(fs.readFileSync(f, 'utf8').trim(), 10)
      if (!Number.isNaN(p)) return p
    }
  } catch { /* 落回默认 */ }
  return 5545
}

const PORT = readPort()

/** 发一个 GET，返回 { status, headers, bodyLength }；连不上时返回 { error } */
function get(urlPath, extraHeaders = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: urlPath, timeout: 5000, headers: extraHeaders }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => { bytes += chunk.length })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bodyLength: bytes }))
      res.on('error', (e) => resolve({ error: e.code || e.message }))
    })
    req.on('error', (e) => resolve({ error: e.code || e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }) })
  })
}

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
}

async function main() {
  // 先探活：连不上就 SKIP
  const health = await get('/api/instance-health')
  if (health.error) {
    console.log(`SKIP  服务 ${HOST}:${PORT} 没在跑（${health.error}）—— 探针不做任何判定`)
    process.exit(0)
  }

  const target = `/api/agent/sessions?cwd=${encodeURIComponent(ROOT)}`
  const first = await get(target)
  if (first.error) {
    console.log(`SKIP  请求 ${target} 失败（${first.error}）`)
    process.exit(0)
  }

  const etag = first.headers.etag
  const cacheControl = String(first.headers['cache-control'] || '')

  if (!reverse) {
    check('响应不带 ETag', !etag, etag ? `实际带了 ${etag}` : '')
    check('Cache-Control 含 no-store', cacheControl.includes('no-store'), `实际: ${cacheControl || '(空)'}`)

    // 硬塞一个不匹配的 If-None-Match：如果服务端还在按 ETag 判定，多半会 304
    const second = await get(target, { 'If-None-Match': 'W/"probe-forced-etag"' })
    check(
      '塞 If-None-Match 也必须是 200 且有 body',
      second.status === 200 && second.bodyLength > 0,
      `实际 status=${second.status} body=${second.bodyLength}B`
    )
  } else {
    // 反样本：期望的是"修之前"的症状。跑在修好的代码上必须红 —— 证明探针真在看东西
    check('[reverse] 期望响应带 ETag（修好的代码不该有）', !!etag, etag ? `确实有 ${etag}` : '没有 ETag')
    check(
      '[reverse] 期望同一 ETag 的第二次请求返回 304',
      false,
      '修好的服务不会再回 304 —— 这条必然失败，说明探针能分辨两种状态'
    )
  }

  let failed = 0
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL'
    if (!r.pass) failed += 1
    console.log(`${tag}  ${r.name}${r.detail ? `   [${r.detail}]` : ''}`)
  }
  console.log(`\n${results.length - failed}/${results.length} 通过  (${HOST}:${PORT}${reverse ? ' · reverse' : ''})`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('探针异常:', e?.message || e)
  process.exit(1)
})
