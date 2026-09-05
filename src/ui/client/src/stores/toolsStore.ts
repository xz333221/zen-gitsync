// 本地工具检测 store — vscode / claude / codex / opencode 是否安装
// 调用 /api/check-tools,启动时一次 + 每 10 分钟刷新
// 组件始终显示工具按钮；available 决定点击后是直接打开还是展示安装引导
import { defineStore } from 'pinia'
import { ref } from 'vue'

const POLL_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟

export type ToolId = 'vscode' | 'claude' | 'codex' | 'opencode' | 'kimi' | 'zcode' | 'dsh'

export interface ToolInstallerInfo {
  supported: boolean
  command: string
  packageManager: string
  docsUrl: string
  note: string
}

type ToolInstallers = Partial<Record<ToolId, ToolInstallerInfo>>
// 检测完成前默认 false，按钮仍显示，但会走安装引导而不是直接启动工具

export const useToolsStore = defineStore('tools', () => {
  const vscodeAvailable = ref(false)
  const claudeAvailable = ref(false)
  const codexAvailable = ref(false)
  const opencodeAvailable = ref(false)
  const kimiAvailable = ref(false)
  const zcodeAvailable = ref(false)
  const dshAvailable = ref(false)
  const lastCheckedAt = ref<number | null>(null)
  const isChecking = ref(false)
  const platform = ref('')
  const installers = ref<ToolInstallers>({})
  // 各工具本地版本号(--version 采集,tooltip 显示用);zcode 为 null(桌面应用无 CLI 通道)
  const versions = ref<Partial<Record<ToolId, string | null>>>({})
  // npm registry 上的最新版本(更新菜单「当前 → 最新」提示用);null = 未知/查询失败
  const latestVersions = ref<Partial<Record<ToolId, string | null>>>({})
  const isFetchingLatest = ref(false)

  const LATEST_CACHE_MS = 5 * 60 * 1000 // 5 分钟内复用,不重复打 registry
  let latestFetchedAt = 0
  let latestPromise: Promise<void> | null = null
  function fetchLatestVersions(force = false): Promise<void> {
    if (!force && Date.now() - latestFetchedAt < LATEST_CACHE_MS) return Promise.resolve()
    if (latestPromise) return latestPromise
    isFetchingLatest.value = true
    latestPromise = (async () => {
      try {
        const resp = await fetch('/api/latest-tool-versions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        const data = await resp.json()
        if (data.success && data.latest && typeof data.latest === 'object') {
          latestVersions.value = data.latest as Partial<Record<ToolId, string | null>>
          latestFetchedAt = Date.now()
        }
      } catch {
        // 查询失败保持原状态,更新菜单降级为原文案
      } finally {
        isFetchingLatest.value = false
        latestPromise = null
      }
    })()
    return latestPromise
  }

  let checkPromise: Promise<void> | null = null
  function checkTools(): Promise<void> {
    if (checkPromise) return checkPromise
    isChecking.value = true
    checkPromise = (async () => {
      try {
        const resp = await fetch('/api/check-tools')
        const data = await resp.json()
        if (data.success) {
          vscodeAvailable.value = !!data.vscode
          claudeAvailable.value = !!data.claude
          codexAvailable.value = !!data.codex
          opencodeAvailable.value = !!data.opencode
          kimiAvailable.value = !!data.kimi
          zcodeAvailable.value = !!data.zcode
          dshAvailable.value = !!data.dsh
          platform.value = typeof data.platform === 'string' ? data.platform : ''
          installers.value = data.installers && typeof data.installers === 'object'
            ? data.installers as ToolInstallers
            : {}
          versions.value = data.versions && typeof data.versions === 'object'
            ? data.versions as Partial<Record<ToolId, string | null>>
            : {}
          lastCheckedAt.value = Date.now()
        }
      } catch {
        // 检测失败保持原状态,不抛
      } finally {
        isChecking.value = false
        checkPromise = null
      }
    })()
    return checkPromise
  }

  function isToolAvailable(tool: ToolId): boolean {
    switch (tool) {
      case 'vscode': return vscodeAvailable.value
      case 'claude': return claudeAvailable.value
      case 'codex': return codexAvailable.value
      case 'opencode': return opencodeAvailable.value
      case 'kimi': return kimiAvailable.value
      case 'zcode': return zcodeAvailable.value
      case 'dsh': return dshAvailable.value
    }
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null
  function startPolling(): void {
    if (pollTimer) return
    void checkTools()
    pollTimer = setInterval(() => { void checkTools() }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    vscodeAvailable,
    claudeAvailable,
    codexAvailable,
    opencodeAvailable,
    kimiAvailable,
    zcodeAvailable,
    dshAvailable,
    lastCheckedAt,
    isChecking,
    platform,
    installers,
    versions,
    latestVersions,
    isFetchingLatest,
    isToolAvailable,
    checkTools,
    fetchLatestVersions,
    startPolling,
    stopPolling,
  }
})
