/**
 * 后端 URL 工具单点 — 替换 gitStore/instancesStore/CommandConsole 三处复制。
 *
 * 端口探测策略:
 *   - dev 环境: 当前页面跑在 Vite dev server(5173/4173/5544),从 import.meta.env.VITE_BACKEND_PORT 读后端端口
 *   - 生产环境: 后端与前端同源,用 window.location.port
 *   - 兜底: 3000(dev 期找不到 env 时)
 *
 * 注意: history.push 走 vite proxy,所以 fetch('/api/xxx') 不需要拼端口;
 * 只有直连(websocket / 新窗口 / 外部链接)才需要 backendUrl + port。
 */

// Vite dev server 端口白名单 — 与 .claude/launch.json + vite.config strictPort=5544 对齐
const VITE_DEV_PORTS = new Set(['5173', '4173', '5544'])
const DEFAULT_BACKEND_PORT = 3000

/**
 * 探测后端端口。开发期读 VITE_BACKEND_PORT,生产期用当前页面端口。
 */
export function getBackendPort(): number {
  if (typeof window === 'undefined') return DEFAULT_BACKEND_PORT
  const currentPort = window.location.port || '80'

  // dev 期: Vite dev server 端口,需要找真正的后端端口
  if (VITE_DEV_PORTS.has(currentPort)) {
    const envPort = import.meta.env?.VITE_BACKEND_PORT
    if (envPort) {
      const n = parseInt(String(envPort), 10)
      if (!Number.isNaN(n)) return n
    }
    return DEFAULT_BACKEND_PORT
  }

  // 生产期: 同源,直接用当前页面端口
  const n = parseInt(currentPort, 10)
  return Number.isNaN(n) ? DEFAULT_BACKEND_PORT : n
}

/**
 * 拼后端完整 URL(无 path → 根,带 path → 拼到 host)。
 * 用法: backendUrl() = 'http://127.0.0.1:5545', backendUrl('/api/foo') = 'http://127.0.0.1:5545/api/foo'
 */
export function backendUrl(path = ''): string {
  if (typeof window === 'undefined') return `http://127.0.0.1:${DEFAULT_BACKEND_PORT}${path}`
  const { protocol, hostname } = window.location
  const port = getBackendPort()
  return `${protocol}//${hostname}:${port}${path}`
}