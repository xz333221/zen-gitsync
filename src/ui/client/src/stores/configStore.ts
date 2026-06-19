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
import { $t } from '@/lang/static'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { SupportLocale } from '@/locales'
import { setLocale } from '@/locales'
import { useLocaleStore } from './localeStore'

// AI 模型配置
export interface ModelInfo {
  id: string
  name: string
  baseURL: string
  model: string
  isDefault: boolean
  apiKey: string
}

// 节点输出引用类型
export interface NodeOutputRef {
  nodeId: string      // 引用的节点 ID
  outputKey: string   // 输出键名（如 'stdout', 'version' 等）
}

// 节点输入配置类型
export interface NodeInput {
  paramName: string      // 参数名
  inputType: 'reference' | 'manual'  // 引用或手动输入
  required?: boolean     // 是否必填（默认 false）
  // 引用模式
  referenceNodeId?: string
  referenceOutputKey?: string
  // 手动输入模式
  manualValue?: string
}

export interface CodeNodeInput {
  name: string
  source: 'reference' | 'manual'
  required?: boolean     // 是否必填（默认 false）
  manualValue?: string
  ref?: NodeOutputRef
}

export interface UserInputParam {
  name: string
  source: 'reference' | 'manual'
  required?: boolean     // 是否必填（默认 false）
  // 手动输入模式：默认值
  defaultValue?: string
  // 引用模式
  ref?: NodeOutputRef
}

export interface CodeNodeOutputParam {
  key: string
  type?: 'String' | 'Number' | 'Boolean' | 'JSON'
  desc?: string
}

export type ConditionOperator =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'contains'
  | 'not_contains'
  | 'isEmpty'
  | 'isNotEmpty'

export interface ConditionRule {
  left: NodeOutputRef
  op: ConditionOperator
  right?: string
}

export interface ConditionBranch {
  id: string
  name: string
  handleId: string
  priority: number
  combine: 'all' | 'any'
  rules: ConditionRule[]
  isDefault?: boolean
}

// 编排步骤类型
export interface OrchestrationStep {
  id: string
  nodeId?: string  // 流程图中的节点 ID（用于节点间引用）
  type: 'command' | 'wait' | 'version' | 'confirm' | 'code' | 'condition' | 'user_input'
  displayName?: string  // 节点自定义名称（用于显示与引用）
  enabled?: boolean  // 是否启用该步骤（默认 true），禁用的步骤不会执行
  useTerminal?: boolean  // 是否在新终端窗口中执行（仅对 command 类型有效）
  restartExistingTerminal?: boolean  // 终端执行时：是否重启现存的同命令同目录终端会话（仅对 command 类型有效）
  // 对于 command 类型
  commandId?: string  // 引用的自定义命令 ID
  commandName?: string  // 命令名称（用于显示）
  inputs?: NodeInput[]  // 命令输入参数配置（用于替换命令中的变量）
  // 对于 wait 类型
  waitSeconds?: number  // 等待的秒数
  // 对于 version 类型
  versionBump?: 'patch' | 'minor' | 'major'  // 版本号增量类型
  packageJsonPath?: string  // package.json 文件路径（可选，默认当前目录）
  versionTarget?: 'version' | 'dependency'  // 修改目标：version字段还是dependency
  dependencyName?: string  // 要修改的依赖包名称
  dependencyVersion?: string  // 依赖包的新版本号（手动输入模式）
  dependencyVersionBump?: 'patch' | 'minor' | 'major'  // 依赖版本号增量类型（自动递增模式）
  dependencyType?: 'dependencies' | 'devDependencies' | 'peerDependencies'  // 依赖类型
  // 版本节点输入配置（同代码节点）：可用于配置 version / dependencyVersion 等参数
  versionInputs?: CodeNodeInput[]
  // 节点输入输出功能
  inputRef?: NodeOutputRef  // 引用其他节点的输出（当版本号模式为 'reference' 时使用）
  versionSource?: 'bump' | 'manual' | 'reference' | 'input'  // 版本号来源：自动递增 / 手动输入 / 引用其他节点输出 / 引用本节点输入
  extractVersionFromRefOutput?: boolean  // 引用输出时是否自动提取版本号（默认 true）

  // 当 versionSource='input' 时：从本节点输入参数中取值
  versionInputKey?: string
  dependencyVersionInputKey?: string

  // 对于 code 类型
  codeScript?: string
  codeInputs?: CodeNodeInput[]
  codeOutputParams?: CodeNodeOutputParam[]
  codeOutputKeys?: string[]

  commandOutputParams?: Array<{ key: string; desc?: string }>

  // 对于 condition 类型
  conditionBranches?: ConditionBranch[]

  // 对于 user_input 类型
  userInputParams?: UserInputParam[]
}

export const useConfigStore = defineStore('config', () => {
  // 配置状态
  const defaultCommitMessage = ref('')
  const descriptionTemplates = ref<string[]>([])
  const scopeTemplates = ref<string[]>([])
  const messageTemplates = ref<string[]>([])
  const commandTemplates = ref<string[]>([])
  const lockedFiles = ref<string[]>([])
  const customCommands = ref<Array<{id: string, name: string, description?: string, directory: string, command: string}>>([])
  const orchestrations = ref<Array<{id: string, name: string, description?: string, flowData?: any}>>([])
  const startupItems = ref<Array<{id: string, type: 'command' | 'workflow', refId: string, createdAt: number, enabled: boolean}>>([])
  const startupAutoRun = ref(false)
  const afterQuickPushAction = ref<{ enabled: boolean; type: 'command' | 'workflow'; refId: string }>({
    enabled: false,
    type: 'command',
    refId: ''
  })
  const isLoading = ref(false)
  const isLoaded = ref(false)
  // 系统配置文件异常（JSON损坏等）
  const configLoadError = ref('')
  const configFilePath = ref('')
  // 当前工作目录
  const currentDirectory = ref('')
  // Push完成后自动关闭进度弹窗（从文件配置加载，默认false）
  const autoClosePushModal = ref(true)
  // 自动设置默认提交信息（从文件配置加载，默认false）
  const autoSetDefaultMessage = ref(false)
  // 标准化提交（从文件配置加载，默认true）
  const isStandardCommit = ref(true)
  // 跳过钩子检查（从文件配置加载，默认false）
  const skipHooks = ref(false)
  // 回车自动一键提交（从文件配置加载，默认false）
  const autoQuickPushOnEnter = ref(false)
  // 推送前自动拉取远程更新（从文件配置加载，默认true）
  const pullBeforePush = ref(true)
  // 主题设置（从文件配置加载，默认light）
  const theme = ref<'light' | 'dark' | 'auto'>('light')
  // 语言设置（从文件配置加载，默认zh-CN）
  const locale = ref<SupportLocale>('zh-CN')
  // AI 模型列表
  const models = ref<ModelInfo[]>([])

  // ============================================================
  // UI 状态（持久化到 ~/.git-commit-tool.json 的顶层 ui 字段）
  // ============================================================
  // 之前散落在 localStorage 里的视图模式/分割比例/控制台状态/布局比例
  // 因随机端口启动而失效，迁到文件持久化。
  type UiLayout = {
    leftRatio: number
    midRatio: number
    rightRatio: number
    topRatio: number
  }

  type UiCommandConsole = {
    expanded: boolean
    useTerminal: boolean
    showTerminalSessions: boolean
    splitPercent: number
  }

  type UiSettings = {
    layout: UiLayout
    fileListViewMode: 'list' | 'tree'
    fileDiffSplitPercent: number
    commandConsole: UiCommandConsole
    editorAutoSave: boolean
  }

  const defaultUiSettings: UiSettings = {
    layout: { leftRatio: 0.25, midRatio: 0.375, rightRatio: 0.375, topRatio: 0.5 },
    fileListViewMode: 'list',
    fileDiffSplitPercent: 35,
    commandConsole: {
      expanded: true,
      useTerminal: true,
      showTerminalSessions: true,
      splitPercent: 25,
    },
    editorAutoSave: false,
  }

  // 浅拷贝默认值（避免外部 mutate 到 defaultUiSettings）
  const ui = ref<UiSettings>(JSON.parse(JSON.stringify(defaultUiSettings)))
  // UI 配置是否已从文件加载（防止 loadConfig 期间回写造成脏数据）
  const isUiLoaded = ref(false)

  // 设置当前目录
  function setCurrentDirectory(dir: string) {
    currentDirectory.value = dir || ''
  }

  // 应用主题
  function applyTheme(themeValue: 'light' | 'dark' | 'auto') {
    const html = document.documentElement
    if (themeValue === 'dark') {
      html.setAttribute('data-theme', 'dark')
    } else if (themeValue === 'light') {
      html.removeAttribute('data-theme')
    } else {
      // 跟随系统
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (prefersDark) {
        html.setAttribute('data-theme', 'dark')
      } else {
        html.removeAttribute('data-theme')
      }
    }
  }

  // 一键切换 light ↔ dark（不进入 auto 模式；auto 模式下视当前实际渲染决定目标）
  // 用于 header 主题切换按钮,避免在设置里改完之后又被 auto 覆盖。
  function toggleTheme() {
    const html = document.documentElement
    const currentlyDark = html.getAttribute('data-theme') === 'dark'
    const next: 'light' | 'dark' = currentlyDark ? 'light' : 'dark'
    theme.value = next
    applyTheme(next)
    // 同步落盘到文件配置,失败也不阻塞 UI
    saveGeneralSettings({ theme: next }).catch((e) => {
      console.error('保存主题切换结果失败:', e)
    })
    return next
  }

  // 初始化时应用主题
  applyTheme(theme.value)

  // 添加 computed 属性返回完整配置
  const config = computed(() => {
    return {
      defaultCommitMessage: defaultCommitMessage.value,
      descriptionTemplates: descriptionTemplates.value,
      scopeTemplates: scopeTemplates.value,
      messageTemplates: messageTemplates.value,
      commandTemplates: commandTemplates.value,
      lockedFiles: lockedFiles.value,
      customCommands: customCommands.value,
      orchestrations: orchestrations.value,
      startupItems: startupItems.value,
      startupAutoRun: startupAutoRun.value,
      afterQuickPushAction: afterQuickPushAction.value,
      currentDirectory: currentDirectory.value
    }
  })

  const hasConfigLoadError = computed(() => {
    return Boolean(configLoadError.value && configLoadError.value.trim())
  })

  async function openSystemConfigFile() {
    try {
      const response = await fetch('/api/config/open-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      const result = await response.json().catch(() => ({} as any))
      if (response.ok && result?.success) {
        ElMessage.success($t('@D50BB:已打开系统配置文件'))
        return true
      }
      ElMessage.error(`${$t('@D50BB:打开系统配置文件失败: ')}${result?.error || ''}`)
      return false
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:打开系统配置文件失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 加载配置（可强制刷新）
  async function loadConfig(force = false) {
    // 如果已经加载过且未强制刷新，则不再重复加载
    if (!force && isLoaded.value && !isLoading.value) {
      console.log($t('@D50BB:使用缓存的配置信息'))
      return config.value
    }

    isLoading.value = true
    try {
      isLoading.value = true
      console.log($t('@D50BB:加载配置信息...'))
      const response = await fetch('/api/config/getConfig')
      const configData = await response.json().catch(() => ({} as any))

      if (!response.ok || (configData && configData.success === false)) {
        const errMsg = String(configData?.error || $t('@D50BB:加载配置失败'))
        const configPath = String(configData?.configPath || '')
        const hint = configPath ? `\n${$t('@D50BB:配置文件')}: ${configPath}` : ''
        ElMessage.error(`${$t('@D50BB:加载配置失败: ')}${errMsg}${hint}`)

        // 记录异常状态供Header提示
        configLoadError.value = errMsg
        configFilePath.value = configPath
        return null
      }

      // 读取成功，清空异常状态
      configLoadError.value = ''
      configFilePath.value = ''
      
      // 更新状态
      defaultCommitMessage.value = configData.defaultCommitMessage || ''
      descriptionTemplates.value = configData.descriptionTemplates || []
      scopeTemplates.value = configData.scopeTemplates || []
      messageTemplates.value = configData.messageTemplates || []
      commandTemplates.value = configData.commandTemplates || []
      lockedFiles.value = configData.lockedFiles || []
      customCommands.value = configData.customCommands || []
      orchestrations.value = configData.orchestrations || []
      startupItems.value = (configData.startupItems || []).map((it: any) => ({
        id: String(it?.id ?? ''),
        type: (it?.type === 'workflow' ? 'workflow' : 'command') as 'command' | 'workflow',
        refId: String(it?.refId ?? it?.commandId ?? ''),
        createdAt: Number(it?.createdAt ?? Date.now()),
        enabled: typeof it?.enabled === 'boolean' ? it.enabled : true
      })).filter((it: any) => it.id && it.refId)
      startupAutoRun.value = configData.startupAutoRun || false
      afterQuickPushAction.value = {
        enabled: Boolean(configData?.afterQuickPushAction?.enabled),
        type: configData?.afterQuickPushAction?.type === 'workflow' ? 'workflow' : 'command',
        refId: String(configData?.afterQuickPushAction?.refId || '').trim()
      }
      
      // 加载提交设置
      if (configData.isStandardCommit !== undefined) isStandardCommit.value = Boolean(configData.isStandardCommit)
      if (configData.skipHooks !== undefined) skipHooks.value = Boolean(configData.skipHooks)
      if (configData.autoQuickPushOnEnter !== undefined) autoQuickPushOnEnter.value = Boolean(configData.autoQuickPushOnEnter)
      if (configData.autoSetDefaultMessage !== undefined) autoSetDefaultMessage.value = Boolean(configData.autoSetDefaultMessage)
      if (configData.autoClosePushModal !== undefined) autoClosePushModal.value = Boolean(configData.autoClosePushModal)
      if (configData.pullBeforePush !== undefined) pullBeforePush.value = Boolean(configData.pullBeforePush)

      // 加载模型配置
      if (Array.isArray(configData.models)) {
        models.value = configData.models
      }

      // 加载通用设置
      if (configData.theme && ['light', 'dark', 'auto'].includes(configData.theme)) {
        theme.value = configData.theme
        applyTheme(configData.theme)
      }
      if (configData.locale && ['zh-CN', 'en-US'].includes(configData.locale)) {
        locale.value = configData.locale
        // 同步更新 localeStore 和 i18n
        setLocale(configData.locale)
        const localeStore = useLocaleStore()
        localeStore.currentLocale = configData.locale
      }
      
      // 若后端返回当前目录，更新
      if (configData.currentDirectory) {
        currentDirectory.value = configData.currentDirectory
      }

      // ============================================================
      // 加载 UI 状态
      // ============================================================
      // 一次性迁移：若文件 ui 字段从未写入过，从 localStorage 旧键搬过来
      // 搬完即清空 localStorage 旧键，避免下次再触发
      if (configData.ui == null) {
        const ls = (k: string) => {
          try { return localStorage.getItem(k) } catch { return null }
        }
        const legacy: Partial<UiSettings> = {}

        // 布局比例
        const lLeft = ls('zen-gitsync-layout-left-ratio')
        const lMid = ls('zen-gitsync-layout-mid-ratio')
        const lRight = ls('zen-gitsync-layout-right-ratio')
        const lTop = ls('zen-gitsync-layout-top-ratio')
        if (lLeft || lMid || lRight || lTop) {
          const num = (s: string | null, fallback: number) => {
            const v = s == null ? NaN : parseFloat(s)
            return Number.isFinite(v) ? v : fallback
          }
          legacy.layout = {
            leftRatio: num(lLeft, defaultUiSettings.layout.leftRatio),
            midRatio: num(lMid, defaultUiSettings.layout.midRatio),
            rightRatio: num(lRight, defaultUiSettings.layout.rightRatio),
            topRatio: num(lTop, defaultUiSettings.layout.topRatio),
          }
        }

        // 文件列表视图模式
        const lView = ls('zen-gitsync-file-list-view-mode')
        if (lView === 'list' || lView === 'tree') {
          legacy.fileListViewMode = lView
        }

        // 文件差异分割比例（兼容 fileDiff.splitPercent 旧键）
        const lDiff = ls('zen-gitsync-filediff-ratio') ?? ls('fileDiff.splitPercent')
        if (lDiff != null) {
          const v = parseFloat(lDiff)
          if (Number.isFinite(v)) legacy.fileDiffSplitPercent = Math.min(85, Math.max(15, v))
        }

        // 命令控制台 4 个字段
        const lUse = ls('useTerminal')
        const lExp = ls('isConsoleExpanded')
        const lShow = ls('showTerminalSessions')
        const lSplit = ls('zen-gitsync-commandconsole-ratio')
        if (lUse !== null || lExp !== null || lShow !== null || lSplit != null) {
          const split = lSplit != null ? parseFloat(lSplit) : NaN
          legacy.commandConsole = {
            useTerminal: lUse !== 'false',
            expanded: lExp !== 'false',
            showTerminalSessions: lShow == null ? true : lShow === 'true',
            splitPercent: Number.isFinite(split) ? Math.min(85, Math.max(15, split)) : defaultUiSettings.commandConsole.splitPercent,
          }
        }

        // 编辑器自动保存
        const lAuto = ls('zen-gitsync-editor-auto-save')
        if (lAuto != null) {
          legacy.editorAutoSave = lAuto === 'true'
        }

        // 合并到 ref（先于保存，保证内存里就是迁移后的值）
        if (Object.keys(legacy).length > 0) {
          ui.value = { ...ui.value, ...legacy } as UiSettings
        }

        // 立即落盘（不等防抖）
        if (Object.keys(legacy).length > 0) {
          saveUiSettings(legacy, { immediate: true }).catch((e) => {
            console.error('迁移 UI 设置到文件失败:', e)
          })
        }

        // 清空所有旧 localStorage 键（一次性清理）
        try {
          ;[
            'zen-gitsync-theme', 'zen-gitsync-locale', 'zen-gitsync-editor-auto-save',
            'zen-gitsync-file-list-view-mode', 'zen-gitsync-filediff-ratio', 'fileDiff.splitPercent',
            'isConsoleExpanded', 'useTerminal', 'showTerminalSessions',
            'zen-gitsync-commandconsole-ratio',
            'zen-gitsync-layout-left-ratio', 'zen-gitsync-layout-mid-ratio',
            'zen-gitsync-layout-right-ratio', 'zen-gitsync-layout-top-ratio',
            'locale',
          ].forEach((k) => localStorage.removeItem(k))
        } catch (e) {
          // localStorage 不可用时静默忽略
        }
      } else {
        // 已有 ui 字段：从响应合并到 ref（缺字段走默认值补齐）
        ui.value = {
          layout: { ...defaultUiSettings.layout, ...(configData.ui.layout || {}) },
          fileListViewMode: configData.ui.fileListViewMode === 'tree' ? 'tree' : 'list',
          fileDiffSplitPercent: Number.isFinite(Number(configData.ui.fileDiffSplitPercent))
            ? Math.min(85, Math.max(15, Number(configData.ui.fileDiffSplitPercent)))
            : defaultUiSettings.fileDiffSplitPercent,
          commandConsole: {
            expanded: typeof configData.ui.commandConsole?.expanded === 'boolean' ? configData.ui.commandConsole.expanded : defaultUiSettings.commandConsole.expanded,
            useTerminal: typeof configData.ui.commandConsole?.useTerminal === 'boolean' ? configData.ui.commandConsole.useTerminal : defaultUiSettings.commandConsole.useTerminal,
            showTerminalSessions: typeof configData.ui.commandConsole?.showTerminalSessions === 'boolean' ? configData.ui.commandConsole.showTerminalSessions : defaultUiSettings.commandConsole.showTerminalSessions,
            splitPercent: Number.isFinite(Number(configData.ui.commandConsole?.splitPercent))
              ? Math.min(85, Math.max(15, Number(configData.ui.commandConsole.splitPercent)))
              : defaultUiSettings.commandConsole.splitPercent,
          },
          editorAutoSave: typeof configData.ui.editorAutoSave === 'boolean' ? configData.ui.editorAutoSave : defaultUiSettings.editorAutoSave,
        }
      }

      // 标记 UI 配置已加载（启动防抖写入的 watch）
      isUiLoaded.value = true

      // 标记为已加载
      isLoaded.value = true
      
      console.log($t('@D50BB:配置信息加载完成'))
      return config.value
    } catch (error) {
      console.error('加载配置失败:', error)
      ElMessage.error(`${$t('@D50BB:加载配置失败: ')}${(error as Error).message}`)

      // 记录异常状态供Header提示
      configLoadError.value = (error as Error).message
      return null
    } finally {
      isLoading.value = false
    }
  }

  // 保存提交设置到文件配置
  async function saveCommitSettings() {
    try {
      await fetch('/api/config/save-commit-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isStandardCommit: isStandardCommit.value,
          skipHooks: skipHooks.value,
          autoQuickPushOnEnter: autoQuickPushOnEnter.value,
          autoSetDefaultMessage: autoSetDefaultMessage.value,
          autoClosePushModal: autoClosePushModal.value,
          pullBeforePush: pullBeforePush.value
        })
      })
    } catch (error) {
      console.error('保存提交设置失败:', error)
    }
  }

  // 监听提交设置变化，自动保存到文件配置
  watch([isStandardCommit, skipHooks, autoQuickPushOnEnter, autoSetDefaultMessage, autoClosePushModal, pullBeforePush], () => {
    if (isLoaded.value) saveCommitSettings()
  })

  // ============================================================
  // UI 状态自动持久化（防抖 + 浅合并 partial body）
  // ============================================================
  // 多个 ui 子字段可能同时变化（拖拽布局时尤其），合并到一次请求避免抖动
  let _uiSaveTimer: ReturnType<typeof setTimeout> | null = null
  let _uiSavePending: Record<string, any> = {}
  const UI_SAVE_DEBOUNCE_MS = 300

  async function flushUiSaveNow() {
    if (_uiSaveTimer) {
      clearTimeout(_uiSaveTimer)
      _uiSaveTimer = null
    }
    if (Object.keys(_uiSavePending).length === 0) return
    const partial = _uiSavePending
    _uiSavePending = {}
    try {
      await fetch('/api/config/save-ui-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial)
      })
    } catch (e) {
      console.error('保存 UI 设置失败:', e)
    }
  }

  /**
   * 持久化 UI 状态的一部分到文件
   * @param partial 顶层 ui 字段的浅合并片段，例如 { fileListViewMode: 'tree' } 或 { commandConsole: {...} }
   * @param options.immediate 立即发送请求（用于一次性操作如 resetUiLayout、迁移），跳过防抖
   */
  async function saveUiSettings(partial: Record<string, any>, options: { immediate?: boolean } = {}) {
    if (!isUiLoaded.value) return // 未加载完前不要回写
    if (options.immediate) {
      // 合并 pending（防止与正在排队的防抖请求冲突）
      Object.assign(_uiSavePending, partial)
      await flushUiSaveNow()
      return
    }
    Object.assign(_uiSavePending, partial)
    if (_uiSaveTimer) clearTimeout(_uiSaveTimer)
    _uiSaveTimer = setTimeout(() => { flushUiSaveNow() }, UI_SAVE_DEBOUNCE_MS)
  }

  /** 重置布局比例到默认（应用到 DOM + 立即落盘） */
  async function resetUiLayout() {
    ui.value.layout = { ...defaultUiSettings.layout }
    // 落盘
    await saveUiSettings({ layout: ui.value.layout }, { immediate: true })
    return ui.value.layout
  }

  // 监听 ui 子字段变化，自动落盘
  watch(() => ui.value.fileListViewMode, (v) => { if (isUiLoaded.value) saveUiSettings({ fileListViewMode: v }) })
  watch(() => ui.value.fileDiffSplitPercent, (v) => { if (isUiLoaded.value) saveUiSettings({ fileDiffSplitPercent: v }) })
  watch(() => ui.value.editorAutoSave, (v) => { if (isUiLoaded.value) saveUiSettings({ editorAutoSave: v }) })
  watch(() => ui.value.layout, (v) => { if (isUiLoaded.value) saveUiSettings({ layout: v }) }, { deep: true })
  watch(() => ui.value.commandConsole, (v) => { if (isUiLoaded.value) saveUiSettings({ commandConsole: v }) }, { deep: true })

  // 页面卸载时强制 flush 待发送的请求，避免拖拽松手后立刻关闭导致丢数据
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => { flushUiSaveNow() })
  }

  // 保存默认提交信息
  async function saveDefaultMessage(message: string) {
    try {
      const response = await fetch('/api/config/saveDefaultMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ defaultCommitMessage: message })
      })
      
      const result = await response.json()
      if (result.success) {
        defaultCommitMessage.value = message
        ElMessage.success($t('@D50BB:默认提交信息已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:保存失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:保存失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function saveAfterQuickPushAction(action: { enabled: boolean; type: 'command' | 'workflow'; refId: string }) {
    try {
      const response = await fetch('/api/config/save-after-quick-push-action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          afterQuickPushAction: {
            enabled: Boolean(action?.enabled),
            type: action?.type === 'workflow' ? 'workflow' : 'command',
            refId: String(action?.refId || '').trim()
          }
        })
      })

      const result = await response.json()
      if (result.success) {
        afterQuickPushAction.value = {
          enabled: Boolean(action?.enabled),
          type: action?.type === 'workflow' ? 'workflow' : 'command',
          refId: String(action?.refId || '').trim()
        }
        return true
      } else {
        ElMessage.error(`保存提交后启动项失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`保存提交后启动项失败: ${(error as Error).message}`)
      return false
    }
  }

  // 保存模板
  async function saveTemplate(template: string, type: 'description' | 'scope' | 'message' | 'command') {
    try {
      const response = await fetch('/api/config/save-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          if (!descriptionTemplates.value.includes(template)) {
            descriptionTemplates.value.push(template)
          }
        } else if (type === 'scope') {
          if (!scopeTemplates.value.includes(template)) {
            scopeTemplates.value.push(template)
          }
        } else if (type === 'message') {
          if (!messageTemplates.value.includes(template)) {
            messageTemplates.value.push(template)
          }
        } else if (type === 'command') {
          if (!commandTemplates.value.includes(template)) {
            commandTemplates.value.push(template)
          }
        }
        
        ElMessage.success($t('@D50BB:模板已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:保存模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:保存模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 删除模板
  async function deleteTemplate(template: string, type: 'description' | 'scope' | 'message' | 'command') {
    try {
      const response = await fetch('/api/config/delete-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          descriptionTemplates.value = descriptionTemplates.value.filter(t => t !== template)
        } else if (type === 'scope') {
          scopeTemplates.value = scopeTemplates.value.filter(t => t !== template)
        } else if (type === 'message') {
          messageTemplates.value = messageTemplates.value.filter(t => t !== template)
        } else if (type === 'command') {
          commandTemplates.value = commandTemplates.value.filter(t => t !== template)
        }
        
        ElMessage.success($t('@D50BB:模板已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:删除模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:删除模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 更新模板
  async function updateTemplate(oldTemplate: string, newTemplate: string, type: 'description' | 'scope' | 'message' | 'command') {
    try {
      const response = await fetch('/api/config/update-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ oldTemplate, newTemplate, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表
        if (type === 'description') {
          const index = descriptionTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            descriptionTemplates.value[index] = newTemplate
          }
        } else if (type === 'scope') {
          const index = scopeTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            scopeTemplates.value[index] = newTemplate
          }
        } else if (type === 'message') {
          const index = messageTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            messageTemplates.value[index] = newTemplate
          }
        } else if (type === 'command') {
          const index = commandTemplates.value.indexOf(oldTemplate)
          if (index !== -1) {
            commandTemplates.value[index] = newTemplate
          }
        }
        
        ElMessage.success($t('@D50BB:模板已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:更新模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:更新模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 置顶模板
  async function pinTemplate(template: string, type: 'description' | 'scope' | 'message' | 'command') {
    try {
      const response = await fetch('/api/config/pin-template', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ template, type })
      })
      
      const result = await response.json()
      if (result.success) {
        // 更新本地模板列表，将置顶的模板移到第一位
        if (type === 'description') {
          descriptionTemplates.value = descriptionTemplates.value.filter(t => t !== template)
          descriptionTemplates.value.unshift(template)
        } else if (type === 'scope') {
          scopeTemplates.value = scopeTemplates.value.filter(t => t !== template)
          scopeTemplates.value.unshift(template)
        } else if (type === 'message') {
          messageTemplates.value = messageTemplates.value.filter(t => t !== template)
          messageTemplates.value.unshift(template)
        } else if (type === 'command') {
          commandTemplates.value = commandTemplates.value.filter(t => t !== template)
          commandTemplates.value.unshift(template)
        }
        
        ElMessage.success($t('@D50BB:模板已置顶'))
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:置顶模板失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:置顶模板失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 锁定文件相关函数
  async function loadLockedFiles() {
    try {
      const response = await fetch('/api/locked-files')
      const result = await response.json()

      if (result.success) {
        lockedFiles.value = result.lockedFiles || []
        return result.lockedFiles
      } else {
        ElMessage.error(`${$t('@D50BB:加载锁定文件列表失败: ')}${result.error}`)
        return []
      }
    } catch (error) {
      console.error('加载锁定文件列表失败:', error)
      ElMessage.error(`${$t('@D50BB:加载锁定文件列表失败: ')}${(error as Error).message}`)
      return []
    }
  }

  async function lockFile(filePath: string) {
    try {
      const response = await fetch('/api/lock-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        // 重新加载锁定文件列表
        await loadLockedFiles()
        ElMessage.success(`${$t('@D50BB:文件已锁定: ')}${filePath}`)
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:锁定文件失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      console.error('锁定文件失败:', error)
      ElMessage.error(`${$t('@D50BB:锁定文件失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function unlockFile(filePath: string) {
    try {
      const response = await fetch('/api/unlock-file', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        // 重新加载锁定文件列表
        await loadLockedFiles()
        ElMessage.success(`${$t('@D50BB:文件已解锁: ')}${filePath}`)
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:解锁文件失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      console.error('解锁文件失败:', error)
      ElMessage.error(`${$t('@D50BB:解锁文件失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function isFileLocked(filePath: string) {
    try {
      const response = await fetch('/api/check-file-lock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filePath })
      })

      const result = await response.json()

      if (result.success) {
        return result.isLocked
      } else {
        console.error('检查文件锁定状态失败:', result.error)
        return false
      }
    } catch (error) {
      console.error('检查文件锁定状态失败:', error)
      return false
    }
  }

  // 自定义命令管理函数
  async function saveCustomCommand(command: { name: string; description?: string; directory: string; command: string; params?: any[] }) {
    try {
      const response = await fetch('/api/config/save-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ command })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置获取最新的命令列表
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已保存'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:保存命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:保存命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function deleteCustomCommand(id: string) {
    try {
      const response = await fetch('/api/config/delete-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置以确保数据同步
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:删除命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:删除命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function updateCustomCommand(id: string, command: { name: string; description?: string; directory: string; command: string; params?: any[] }) {
    try {
      const response = await fetch('/api/config/update-custom-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id, command })
      })
      
      const result = await response.json()
      if (result.success) {
        // 重新加载配置以确保数据同步
        await loadConfig(true)
        ElMessage.success($t('@CMD01:命令已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@CMD01:更新命令失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@CMD01:更新命令失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function pinCustomCommand(id: string) {
    try {
      const response = await fetch('/api/config/pin-custom-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      })
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        return true
      } else {
        ElMessage.error(result.error)
        return false
      }
    } catch (error) {
      ElMessage.error((error as Error).message)
      return false
    }
  }

  // 指令编排管理函数
  async function saveOrchestration(orchestration: { name: string; description?: string; flowData?: any }) {
    try {
      const response = await fetch('/api/config/save-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orchestration })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已保存'))
        return result.orchestration || null
      } else {
        ElMessage.error(`${$t('@ORCH:保存编排失败: ')}${result.error}`)
        return null
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:保存编排失败: ')}${(error as Error).message}`)
      return null
    }
  }

  async function deleteOrchestration(id: string) {
    try {
      const response = await fetch('/api/config/delete-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已删除'))
        return true
      } else {
        ElMessage.error(`${$t('@ORCH:删除编排失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:删除编排失败: ')}${(error as Error).message}`)
      return false
    }
  }

  async function updateOrchestration(id: string, orchestration: { name: string; description?: string; flowData?: any }) {
    try {
      const response = await fetch('/api/config/update-orchestration', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ id, orchestration })
      })
      
      const result = await response.json()
      if (result.success) {
        await loadConfig(true)
        ElMessage.success($t('@ORCH:编排已更新'))
        return true
      } else {
        ElMessage.error(`${$t('@ORCH:更新编排失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@ORCH:更新编排失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 保存项目启动项
  async function saveStartupItems(items: Array<{id: string, type: 'command' | 'workflow', refId: string, createdAt: number, enabled: boolean}>, autoRun?: boolean) {
    try {
      const response = await fetch('/api/config/save-startup-items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          startupItems: items,
          startupAutoRun: autoRun !== undefined ? autoRun : startupAutoRun.value
        })
      })
      
      const result = await response.json()
      if (result.success) {
        startupItems.value = items
        if (autoRun !== undefined) {
          startupAutoRun.value = autoRun
        }
        return true
      } else {
        ElMessage.error(`保存启动项失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`保存启动项失败: ${(error as Error).message}`)
      return false
    }
  }

  // 保存模型配置
  async function saveModels(updatedModels: ModelInfo[]): Promise<boolean> {
    try {
      const response = await fetch('/api/config/save-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: updatedModels })
      })
      const result = await response.json()
      if (result.success) {
        models.value = updatedModels
        return true
      } else {
        ElMessage.error(`${$t('@D50BB:保存模型失败: ')}${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`${$t('@D50BB:保存模型失败: ')}${(error as Error).message}`)
      return false
    }
  }

  // 保存通用设置
  async function saveGeneralSettings(settings: { theme?: 'light' | 'dark' | 'auto', locale?: SupportLocale }) {
    try {
      const response = await fetch('/api/config/save-general-settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
      })
      
      const result = await response.json()
      if (result.success) {
        if (settings.theme) {
          theme.value = settings.theme
          applyTheme(settings.theme)
        }
        if (settings.locale) {
          locale.value = settings.locale
          // 同步更新 i18n 和 localeStore
          setLocale(settings.locale)
          const localeStore = useLocaleStore()
          localeStore.currentLocale = settings.locale
        }
        return true
      } else {
        ElMessage.error(`保存通用设置失败: ${result.error}`)
        return false
      }
    } catch (error) {
      ElMessage.error(`保存通用设置失败: ${(error as Error).message}`)
      return false
    }
  }

  return {
    // 状态
    models,
    defaultCommitMessage,
    descriptionTemplates,
    scopeTemplates,
    messageTemplates,
    commandTemplates,
    lockedFiles,
    customCommands,
    orchestrations,
    startupItems,
    startupAutoRun,
    afterQuickPushAction,
    isLoading,
    isLoaded,
    configLoadError,
    configFilePath,
    hasConfigLoadError,
    currentDirectory,
    config,
    autoClosePushModal,
    autoSetDefaultMessage,
    isStandardCommit,
    skipHooks,
    autoQuickPushOnEnter,
    pullBeforePush,
    theme,
    locale,
    ui,
    isUiLoaded,

    // 方法
    loadConfig,
    setCurrentDirectory,
    openSystemConfigFile,
    saveTemplate,
    saveModels,
    saveGeneralSettings,
    saveUiSettings,
    resetUiLayout,
    applyTheme,
    toggleTheme,
    saveDefaultMessage,
    deleteTemplate,
    updateTemplate,
    pinTemplate,
    loadLockedFiles,
    lockFile,
    unlockFile,
    isFileLocked,
    saveCustomCommand,
    deleteCustomCommand,
    updateCustomCommand,
    pinCustomCommand,
    saveOrchestration,
    deleteOrchestration,
    updateOrchestration,
    saveStartupItems,
    saveAfterQuickPushAction,
    saveCommitSettings
  }
}) 
