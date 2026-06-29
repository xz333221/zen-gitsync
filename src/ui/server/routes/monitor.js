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
// 系统监控后端：CPU / 内存 / 端口占用查询，以及 kill 端口占用进程。
// 跨平台：Windows 用 netstat + tasklist；Unix 优先 lsof，回退 ss。
//
// 注意：
// - CPU 占用是两次 os.cpus() 采样的差值，所以这个 endpoint 会有 ~100ms 延迟。
// - 端口列表默认只返回监听端口（TCP LISTENING + 全部 UDP），避免被大量
//   ESTABLISHED 的外网连接刷屏。传 ?all=1 返回全部。
// - kill 接口对自身进程做了保护，避免用户误杀监控服务自己。

import { asyncRoute, HttpError } from '../utils/asyncRoute.js'
import logger from '../utils/logger.js'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileP = promisify(execFile)

// ── CPU 采样 ────────────────────────────────────────────────────────────
// 两次读取 os.cpus().times，比较 idle/total 差值得到占用率。
// 单次读取只能拿到累计时间，必须差值才有意义。
function sampleCpu() {
  const cpus = os.cpus()
  let total = 0
  let idle = 0
  for (const cpu of cpus) {
    const t = cpu.times
    const sum = t.user + t.nice + t.sys + t.irq + t.idle
    total += sum
    idle += t.idle
  }
  return { total, idle }
}

async function getCpuUsage(sampleDelayMs = 100) {
  const a = sampleCpu()
  await new Promise((r) => setTimeout(r, sampleDelayMs))
  const b = sampleCpu()
  const dt = b.total - a.total
  const di = b.idle - a.idle
  const usage = dt > 0 ? (1 - di / dt) * 100 : 0
  const cpus = os.cpus()
  return {
    usage: Math.max(0, Math.min(100, usage)),
    cores: cpus.length,
    model: cpus[0]?.model || 'unknown',
    // Windows 上 loadavg 恒为 [0,0,0]，仅 Unix 有意义
    loadAvg: os.loadavg()
  }
}

// ── 端口列表 ────────────────────────────────────────────────────────────
async function listPorts({ all = false } = {}) {
  if (process.platform === 'win32') {
    return listPortsWindows({ all })
  }
  return listPortsUnix({ all })
}

async function listPortsWindows({ all = false } = {}) {
  // 三个子进程并行执行（原实现串行 await，netstat TCP + netstat UDP + tasklist
  // 串行耗时 = 三者之和；并行后 = max(三者)），Windows 上 netstat 对大量
  // ESTABLISHED 连接很慢，并行能把 8-19s 压到 3-8s。
  const [tcpRes, udpRes, tasklistRes] = await Promise.all([
    execFileP('netstat', ['-ano', '-p', 'TCP']).catch((e) => {
      logger.warn(`[monitor] netstat TCP 失败: ${e?.message || e}`)
      return { stdout: '' }
    }),
    execFileP('netstat', ['-ano', '-p', 'UDP']).catch((e) => {
      logger.warn(`[monitor] netstat UDP 失败: ${e?.message || e}`)
      return { stdout: '' }
    }),
    execFileP('tasklist', ['/FO', 'CSV', '/NH']).catch((e) => {
      logger.warn(`[monitor] tasklist 失败: ${e?.message || e}`)
      return { stdout: '' }
    })
  ])

  const tcpLines = tcpRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const udpLines = udpRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  const pids = new Set()
  const ports = []

  const parseLine = (line, proto) => {
    // 跳过表头："Proto  Local Address  Foreign Address  State  PID"
    if (/^\s*Proto/i.test(line)) return
    const parts = line.split(/\s+/)
    if (parts.length < 4) return

    let localFull
    let state = ''
    let pidStr

    if (proto === 'TCP') {
      // TCP: Proto  Local  Foreign  State  PID
      if (parts.length < 5) return
      localFull = parts[1]
      state = parts[3]
      pidStr = parts[4]
    } else {
      // UDP: Proto  Local  Foreign  PID (无 state)
      localFull = parts[1]
      pidStr = parts[3]
    }

    const idx = localFull.lastIndexOf(':')
    if (idx < 0) return
    const localAddress = localFull.slice(0, idx)
    const localPort = parseInt(localFull.slice(idx + 1), 10)
    if (!Number.isFinite(localPort)) return
    const pidNum = parseInt(pidStr, 10)
    if (Number.isFinite(pidNum)) pids.add(String(pidNum))

    ports.push({
      protocol: proto,
      localAddress,
      localPort,
      state,
      pid: Number.isFinite(pidNum) ? pidNum : pidStr,
      processName: ''
    })
  }

  for (const l of tcpLines) parseLine(l, 'TCP')
  for (const l of udpLines) parseLine(l, 'UDP')

  // tasklist 已在上面并行拿到，这里直接解析 PID -> 进程名映射
  const pidToName = new Map()
  if (pids.size > 0) {
    // 输出形如: "node.exe","1234","Console","1","123,456 K"
    for (const line of tasklistRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const m = line.match(/^"([^"]+)","(\d+)"/)
      if (m) pidToName.set(m[2], m[1])
    }
  }

  for (const p of ports) {
    p.processName = pidToName.get(String(p.pid)) || ''
  }

  // 默认只保留监听端口 + UDP（UDP 没有 LISTENING 状态）
  if (!all) {
    return ports.filter((p) => p.protocol === 'UDP' || p.state === 'LISTENING')
  }
  return ports
}

async function listPortsUnix({ all = false } = {}) {
  let ports = []
  // 优先 lsof，更通用且能拿到进程名
  try {
    const { stdout } = await execFileP('lsof', ['-i', '-P', '-n'])
    // COMMAND   PID   USER   FD   TYPE  DEVICE SIZE/OFF NODE NAME
    // node     1234   user   20u  IPv4  ...     0t0    TCP *:3000 (LISTEN)
    const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean)
    ports = lines
      .map((line) => {
        const parts = line.split(/\s+/)
        if (parts.length < 9) return null
        // parts[7] 是 IPv4/IPv6，parts[8] 是 NAME(*:3000 / 1.2.3.4:3000->...)
        const nameField = parts[8]
        const stateField = parts[9] || ''
        const arrowIdx = nameField.indexOf('->')
        const localPart = arrowIdx >= 0 ? nameField.slice(0, arrowIdx) : nameField
        const colonIdx = localPart.lastIndexOf(':')
        if (colonIdx < 0) return null
        const port = parseInt(localPart.slice(colonIdx + 1), 10)
        if (!Number.isFinite(port)) return null
        return {
          protocol: parts[7] === 'IPv6' ? 'TCP6' : parts[7] === 'IPv4' ? 'TCP' : parts[7],
          localAddress: localPart.slice(0, colonIdx),
          localPort: port,
          state: stateField.replace(/[()]/g, ''),
          pid: parseInt(parts[1], 10) || 0,
          processName: parts[0]
        }
      })
      .filter(Boolean)
  } catch (e) {
    // lsof 不可用（权限/未安装），回退 ss
    try {
      const { stdout } = await execFileP('ss', ['-tunlp'])
      // Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port  Process
      const lines = stdout.split(/\r?\n/).slice(1).filter(Boolean)
      ports = lines
        .map((line) => {
          const parts = line.split(/\s+/)
          if (parts.length < 5) return null
          const local = parts[4]
          const colonIdx = local.lastIndexOf(':')
          if (colonIdx < 0) return null
          const port = parseInt(local.slice(colonIdx + 1), 10)
          if (!Number.isFinite(port)) return null
          const procMatch = line.match(/users:\(\("([^"]+)",pid=(\d+),/)
          return {
            protocol: (parts[0] || '').toUpperCase(),
            localAddress: local.slice(0, colonIdx),
            localPort: port,
            state: parts[1] || '',
            pid: procMatch ? parseInt(procMatch[2], 10) || 0 : 0,
            processName: procMatch ? procMatch[1] : ''
          }
        })
        .filter(Boolean)
    } catch (e2) {
      logger.warn(`[monitor] lsof 和 ss 都不可用: ${e2?.message || e2}`)
      return []
    }
  }

  if (!all) {
    return ports.filter((p) => p.protocol.startsWith('UDP') || p.state === 'LISTEN' || p.state === 'LISTENING')
  }
  return ports
}

// ── kill 进程 ────────────────────────────────────────────────────────────
async function killProcess(pid, { force = false } = {}) {
  const pidNum = Number(pid)
  if (!Number.isFinite(pidNum)) throw new HttpError(400, 'pid 必须是数字')
  if (pidNum <= 0) throw new HttpError(400, 'pid 必须为正数')

  // 防呆：不允许 kill 监控服务自身进程
  if (pidNum === process.pid) {
    throw new HttpError(400, '不能终止监控服务自身进程')
  }

  if (process.platform === 'win32') {
    // /F 强制终止，/T 终止进程树（避免子进程残留）
    const args = ['/PID', String(pidNum), '/F']
    if (force) args.push('/T')
    try {
      await execFileP('taskkill', args)
    } catch (e) {
      // taskkill 在中文 Windows 上 stderr 是 GBK 编码，promisify 默认 utf8 解码会乱码，
      // 无法可靠匹配 "找不到" 文案。改用 exit code 兜底：
      //   taskkill 非 0 退出码最常见原因是「进程不存在 / 已退出 / 无权限」，
      //   统一映射成 404，避免把乱码原文透传给前端。
      const code = e?.code ?? e?.status
      throw new HttpError(404, `进程 ${pidNum} 不存在或无权限终止 (taskkill exit ${code ?? '?'})`)
    }
  } else {
    // Unix: 先 SIGTERM，2 秒后未退出则 SIGKILL
    try {
      process.kill(pidNum, 'SIGTERM')
    } catch (e) {
      if (e.code === 'ESRCH') throw new HttpError(404, `进程 ${pidNum} 不存在`)
      throw new HttpError(500, `终止进程失败: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
    try {
      // kill 0 不发信号，只检查进程是否存在
      process.kill(pidNum, 0)
      // 仍然存活 → SIGKILL
      process.kill(pidNum, 'SIGKILL')
    } catch (e) {
      // ESRCH 表示已退出，符合预期
      if (e.code !== 'ESRCH') {
        logger.warn(`[monitor] SIGKILL ${pidNum} 异常: ${e.message}`)
      }
    }
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────────
// ports 列表缓存：netstat + tasklist 在 Windows 上对大量连接很慢（3-8s），
// 前端每 10-15s 轮询一次，5s 缓存能把第二次以后的响应压到 <10ms。
// 仅缓存默认场景（all=false，只看监听端口）；all=true 实时查不缓存。
let _portsCache = null
let _portsCacheTime = 0
const PORTS_CACHE_TTL_MS = 5000

export function registerMonitorRoutes({ app }) {
  // 系统概览：CPU + 内存 + 系统信息
  app.get(
    '/api/monitor/system',
    asyncRoute(async (req, res) => {
      const cpu = await getCpuUsage(100)
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      res.json({
        success: true,
        data: {
          cpu,
          memory: {
            total: totalMem,
            free: freeMem,
            used: usedMem,
            usagePercent: totalMem > 0 ? (usedMem / totalMem) * 100 : 0
          },
          system: {
            platform: process.platform,
            arch: process.arch,
            hostname: os.hostname(),
            uptime: os.uptime(),
            nodeVersion: process.version
          },
          timestamp: Date.now()
        }
      })
    })
  )

  // 端口列表：默认只返回监听端口，?all=1 返回全部
  app.get(
    '/api/monitor/ports',
    asyncRoute(async (req, res) => {
      const all = req.query.all === '1' || req.query.all === 'true'
      // 默认场景命中缓存直接返回（all=true 实时查，不缓存）
      const now = Date.now()
      if (!all && _portsCache && (now - _portsCacheTime) < PORTS_CACHE_TTL_MS) {
        return res.json({ success: true, data: _portsCache, cached: true })
      }
      const ports = await listPorts({ all })
      if (!all) {
        _portsCache = ports
        _portsCacheTime = now
      }
      res.json({ success: true, data: ports })
    })
  )

  // kill 端口占用进程
  app.post(
    '/api/monitor/kill',
    asyncRoute(async (req, res) => {
      const { pid, force } = req.body || {}
      const pidNum = Number(pid)
      if (!Number.isFinite(pidNum)) throw new HttpError(400, 'pid 必须是数字')
      await killProcess(pidNum, { force: !!force })
      logger.info(`[monitor] 已终止进程 ${pidNum} (force=${!!force})`)
      res.json({
        success: true,
        message: `已发送终止信号到进程 ${pidNum}`,
        pid: pidNum
      })
    })
  )
}
