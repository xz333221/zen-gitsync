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
// HTTP 请求的 Origin 守卫。
//
// 监听地址收敛到 127.0.0.1 之后，剩下的主要攻击面是「本机浏览器里的恶意页面」：
//   - 跨站 fetch('http://127.0.0.1:<port>/api/exec-stream', ...) → 带 Origin: evil.com
//   - DNS rebinding：恶意域名解析到 127.0.0.1，绕过同源检查
// 服务没有认证层，只要请求能进来就是全权限，所以必须在最外层按 Origin 挡一道。
//
// 与 Socket.IO 的 cors.origin 判定共用同一套规则（见 createOriginChecker），
// 避免「WebSocket 连得上但 REST 被拒」这种半残状态。

import os from 'node:os'
import logger from '../utils/logger.js'

// 本机主机名：允许其上任意端口（开发期前端跑在 Vite dev server，端口与后端不同）
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

// ZEN_HOST 的通配取值：绑这些地址等于"放开到所有网卡"
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]'])

function parseExtraOrigins(envValue) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 构造 origin 判定函数。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.extraOrigins] 额外放行的完整 origin（含协议与端口）
 * @param {string[]} [opts.extraHosts] 额外放行的 hostname（允许其上任意端口）。
 *   放开监听地址（ZEN_HOST=0.0.0.0）时用它放行局域网来源，否则用户会被自己的守卫拦在门外。
 * @returns {(origin: string|undefined) => boolean}
 */
export function createOriginChecker({ extraOrigins = [], extraHosts = [] } = {}) {
  const exact = new Set(extraOrigins)
  const hosts = new Set(extraHosts)

  return function isOriginAllowed(origin) {
    // 没有 Origin 头：curl / CLI / 非浏览器客户端 / 部分同源 GET。
    // 这类请求不可能是跨站攻击（浏览器跨站一定带 Origin），放行。
    if (!origin) return true
    if (exact.has(origin)) return true
    // file:// 页面发起的请求，Origin 字面量就是 'null'
    if (origin === 'null') return true

    try {
      const u = new URL(origin)
      if (LOCAL_HOSTNAMES.has(u.hostname)) return true
      if (hosts.has(u.hostname)) return true
    } catch {
      // 解析不了的一律拒绝
      return false
    }
    return false
  }
}

/**
 * 收集本机所有网卡的地址（作为可放行 origin 的 hostname）。
 *
 * 为什么需要：ZEN_HOST=0.0.0.0 放开监听后，用户是从另一台设备通过本机
 * 局域网 IP（如 http://192.168.1.10:5545）访问 GUI 的，浏览器对同源 POST
 * 会带 Origin: http://192.168.1.10:5545 —— hostname 是本机网卡地址而不是
 * 0.0.0.0，不放行的话用户会被自己的守卫 403 掉所有写操作。
 * 安全性不因此受损：Origin 由浏览器生成、页面无法伪造，能带上本机 IP 的
 * 只有从本机加载出去的页面（即 GUI 自己）；恶意域名 / DNS rebinding 的
 * origin hostname 都不是本机地址，照样被拒。
 */
function collectLocalInterfaceHosts() {
  const hosts = []
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      // IPv6 的 URL hostname 带方括号,且要去掉 zone id(%eth0 之类)
      const addr = String(info.address || '').split('%')[0]
      if (!addr) continue
      hosts.push(info.family === 'IPv6' ? `[${addr}]` : addr)
    }
  }
  return hosts
}

/** 从环境变量读取配置，构造判定函数（Socket.IO 与 HTTP 守卫共用） */
export function createOriginCheckerFromEnv() {
  const zenHosts = parseExtraOrigins(process.env.ZEN_HOST)
  // 绑通配地址（0.0.0.0 / ::）等于放开所有网卡,本机各网卡地址要一并放行
  const extraHosts = zenHosts.some((h) => WILDCARD_HOSTS.has(h))
    ? [...zenHosts, ...collectLocalInterfaceHosts()]
    : zenHosts

  return createOriginChecker({
    // 默认放行的完整 origin（后来的 hostname 匹配已覆盖大部分场景，保留只为兼容）
    extraOrigins: [
      'http://localhost',
      'https://localhost',
      'http://127.0.0.1',
      'https://127.0.0.1',
      'http://[::1]',
      // ZEN_ALLOWED_ORIGINS: 逗号分隔的完整 origin,CI / 远程调试用
      ...parseExtraOrigins(process.env.ZEN_ALLOWED_ORIGINS)
    ],
    // ZEN_HOST 放开监听时,对应来源要一并放行,否则局域网访问会被自己的守卫拦掉
    extraHosts
  })
}

/**
 * Express 中间件：拒绝非本机来源的跨站请求。
 */
export function createOriginGuard() {
  const isOriginAllowed = createOriginCheckerFromEnv()

  return function originGuard(req, res, next) {
    const origin = req.get('origin')
    if (isOriginAllowed(origin)) return next()

    logger.warn(`[origin-guard] 拒绝跨站请求: ${req.method} ${req.path} origin=${origin}`)
    res.status(403).json({
      success: false,
      error: '跨站请求被拒绝（Origin 不在允许列表中）'
    })
  }
}
