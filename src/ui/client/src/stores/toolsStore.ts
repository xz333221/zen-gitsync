// 本地工具检测 store — vscode / claude / codex / opencode 是否安装
// 调用 /api/check-tools,启动时一次 + 每 10 分钟刷新
// 组件始终显示工具按钮；available 决定点击后是直接打开还是展示安装引导
//
// 另外持有**执行器当前配置的模型**（claude / codex / opencode 三个 CLI 各自的
// 配置文件里写了什么模型）。归到这里的原因：同属"本机 CLI 环境探测"、同一批执行器、
// 同一个刷新节奏；三处执行器下拉（主 Agent 控制台 ×2、工作台执行按钮、设置弹窗）
// 要的是同一份数据，各拉一次只会各踩各的缓存。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { $t } from '@/lang/static'
import {
  TASK_EXECUTOR_OPTIONS,
  isTaskExecutorId,
  type ExecutorModelInfo,
  type ExecutorModelState,
  type TaskExecutorId,
} from '@/utils/taskExecutor'

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

/**
 * 把后端给的一条模型记录收成展示用的窄类型。
 * 后端已经 format 过（formatExecutorModel），这里只做防御：字段缺失/类型不对一律
 * 当"没探测到"，绝不把半截数据往上抛。
 */
function normalizeExecutorModel(raw: unknown): ExecutorModelInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<ExecutorModelInfo>
  if (typeof r.name !== 'string' || !r.name) return null
  return {
    name: r.name,
    detail: typeof r.detail === 'string' && r.detail ? r.detail : null,
    provider: typeof r.provider === 'string' && r.provider ? r.provider : null,
  }
}

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

  // ── 执行器当前配置的模型 ────────────────────────────────────────────────
  //
  // 工作台派任务**一律不传 --model**，模型完全跟随各 CLI 的配置文件，而界面上
  // 原本一个模型都看不到。这份数据就是"那三个文件里写了什么"的只读投影。

  /** executor id → 模型信息（该 CLI 没在配置里写模型时为 null）。空对象 = 还没探测到 */
  const executorModels = ref<Partial<Record<TaskExecutorId, ExecutorModelInfo | null>>>({})
  /** 探测成功回来过一次没有。区分"没配模型"与"还没问到"的唯一依据（三态见 utils/taskExecutor） */
  const executorModelsReady = ref(false)

  // 模型比 check-tools 更不需要勤刷：它只在用户改 CLI 配置文件时才变
  const MODELS_TTL_MS = 10 * 60 * 1000
  let modelsFetchedAt = 0
  let modelsPromise: Promise<void> | null = null

  /**
   * 某个执行器现在用什么模型。三态（unknown / unset / set）供需要**分支渲染**的
   * 调用方用（比如"没配就整行不显示"）；只要一行文案的直接用 executorModelText。
   */
  function executorModelState(id?: string | null): ExecutorModelState {
    if (!executorModelsReady.value) return { status: 'unknown' }
    // 未知 id（老 job 的 agent 字段、将来删掉的执行器）按 unset 处理，不落到 undefined 上装死
    if (!isTaskExecutorId(id)) return { status: 'unset' }
    const info = executorModels.value[id]
    return info ? { status: 'set', info } : { status: 'unset' }
  }

  /**
   * 拉一次三个执行器的模型。并发去重 + TTL 缓存，三处下拉各调各的不会打出三次请求。
   * @param force 忽略 TTL 强制重探（用户手动刷新时用）
   */
  function fetchExecutorModels(force = false): Promise<void> {
    if (!force && executorModelsReady.value && Date.now() - modelsFetchedAt < MODELS_TTL_MS) {
      return Promise.resolve()
    }
    if (modelsPromise) return modelsPromise
    modelsPromise = (async () => {
      try {
        const resp = await fetch('/api/workbench/executor-models')
        const data = await resp.json()
        if (data?.success && data.models && typeof data.models === 'object') {
          const next: Partial<Record<TaskExecutorId, ExecutorModelInfo | null>> = {}
          // 按 TASK_EXECUTOR_OPTIONS 遍历，不在前端另立一份 id 清单
          for (const opt of TASK_EXECUTOR_OPTIONS) {
            next[opt.id] = normalizeExecutorModel(data.models[opt.id])
          }
          executorModels.value = next
          executorModelsReady.value = true
          modelsFetchedAt = Date.now()
        }
      } catch {
        // 探测失败保持原状，下拉降级为不显示模型。绝不用"看起来对"的值填充 ——
        // 报一个假模型名比什么都不报更坏：用户会据此判断任务到底是谁跑的
      } finally {
        modelsPromise = null
      }
    })()
    return modelsPromise
  }

  /**
   * 模型的一行文案：探测到 → 模型名；探测到但没配 → 「未在配置中指定」；
   * **还没探测到 → 空串**（调用方据此整块不渲染，别先闪一句假的"未配置"）。
   *
   * 文案收在 store 里、不收在各下拉组件里：这个字符串要在四处出现
   * （右侧控制台下拉、工作台执行按钮、设置弹窗的选项与提示行），
   * 各写一遍必然出现"有一处漏改"。
   */
  function executorModelText(id?: string | null): string {
    const s = executorModelState(id)
    if (s.status === 'unknown') return ''
    return s.status === 'set' ? s.info.name : $t('@42BB9:未在配置中指定')
  }

  /**
   * 次要信息（claude 的 CLI 别名 / 服务商 / base_url），不含模型名本身。
   * 给 title 与设置弹窗的括号用；没有 → 空串。
   */
  function executorModelDetail(id?: string | null): string {
    const s = executorModelState(id)
    if (s.status !== 'set') return ''
    return [s.info.detail, s.info.provider].filter(Boolean).join(' · ')
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null
  function startPolling(): void {
    if (pollTimer) return
    void checkTools()
    void fetchExecutorModels()
    pollTimer = setInterval(() => {
      void checkTools()
      void fetchExecutorModels()
    }, POLL_INTERVAL_MS)
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
    executorModels,
    executorModelsReady,
    executorModelState,
    executorModelText,
    executorModelDetail,
    fetchExecutorModels,
    checkTools,
    fetchLatestVersions,
    startPolling,
    stopPolling,
  }
})
