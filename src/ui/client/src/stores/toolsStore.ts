// 本地工具检测 store — vscode / claude 是否安装
// 调用 /api/check-tools,启动时一次 + 每 10 分钟刷新
// 组件用 v-if="toolsStore.vscodeAvailable" 决定是否显示对应按钮
import { defineStore } from 'pinia'
import { ref } from 'vue'

const POLL_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟
// 检测完成前默认 false(不显示按钮),等首次检测完才决定
// 不预设 true 是为了不向用户承诺一个未经验证的状态

export const useToolsStore = defineStore('tools', () => {
  const vscodeAvailable = ref(false)
  const claudeAvailable = ref(false)
  const lastCheckedAt = ref<number | null>(null)
  const isChecking = ref(false)

  async function checkTools(): Promise<void> {
    if (isChecking.value) return
    isChecking.value = true
    try {
      const resp = await fetch('/api/check-tools')
      const data = await resp.json()
      if (data.success) {
        vscodeAvailable.value = !!data.vscode
        claudeAvailable.value = !!data.claude
        lastCheckedAt.value = Date.now()
      }
    } catch {
      // 检测失败保持原状态,不抛
    } finally {
      isChecking.value = false
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
    lastCheckedAt,
    isChecking,
    checkTools,
    startPolling,
    stopPolling,
  }
})