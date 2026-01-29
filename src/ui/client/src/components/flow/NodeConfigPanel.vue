<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Clock, DocumentAdd, Link, Folder, Select, Plus, Delete, Minus } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep, type NodeOutputRef, type NodeInput, type CodeNodeInput, type CodeNodeOutputParam, type ConditionBranch, type ConditionRule, type UserInputParam } from '@stores/configStore'
import type { FlowNode, FlowEdge } from './FlowOrchestrationWorkspace.vue'
import CommonDialog from '@components/CommonDialog.vue'
import PackageJsonSelector from '@components/PackageJsonSelector.vue'
import NodeInputConfig from './NodeInputConfig.vue'
import CodeNodeInputConfig from './CodeNodeInputConfig.vue'
import UserInputParamConfig from './UserInputParamConfig.vue'
import ParamListContainer from './ParamListContainer.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import type { CustomCommand } from '@components/CustomCommandManager.vue'
import type { PackageFile } from '@components/PackageJsonSelector.vue'
import { extractVariables } from '@/utils/commandParser'
import { $t } from '@/lang/static'

const codeScriptExample = 'function main(param) {\n  const out = new Object()\n  out.key0 = param.input\n  return out\n}'

const codeScriptExamples = [
  {
    key: 'extractVersion',
    title: $t('@NODECFG:提取版本号'),
    script:
      'function main(param) {\n'
      + '  const text = String((param && param.input) ?? "")\n'
      + '  // 匹配形如 2.10.73 / v2.10.73 的版本号\n'
      + '  const m = text.match(/\\bv?(\\d+\\.\\d+\\.\\d+)\\b/)\n'
      + '  const out = new Object()\n'
      + '  out.version = m ? m[1] : ""\n'
      + '  return out\n'
      + '}'
  },
  {
    key: 'commitMessage',
    title: $t('@NODECFG:生成提交信息'),
    script:
      'function main(param) {\n'
      + '  const text = String((param && param.input) ?? "")\n'
      + '  // 兼容：@scope/workflow@2.10.73 或 workflow@2.10.73 或 workflow 2.10.73\n'
      + '  const m = text.match(/(?:@[^\\/\\s]+\\/)?([A-Za-z0-9._-]+)(?:@|\\s+)(v?\\d+\\.\\d+\\.\\d+)/)\n'
      + '  const name = m ? m[1] : ""\n'
      + '  const ver = m ? m[2].replace(/^v/, "") : ""\n'
      + '  const out = new Object()\n'
      + '  out.message = (name && ver) ? `【${name}】更新版本到${ver}` : ""\n'
      + '  return out\n'
      + '}'
  }
]

function applyCodeExample(script: string) {
  formData.value.codeScript = script
  ElMessage.success($t('@NODECFG:已应用示例'))
}

const props = defineProps<{
  modelValue: boolean
  node: FlowNode | null
  allNodes?: FlowNode[]  // 所有节点列表
  edges?: FlowEdge[]     // 所有边列表
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'update-config', nodeId: string, config: OrchestrationStep): void
  (e: 'open-command-manager'): void
}>()

function openCommandManager() {
  emit('open-command-manager')
}

const configStore = useConfigStore()

const dialogTitle = computed(() => {
  const base = $t('@NODECFG:节点配置')
  if (!props.node) return base
  const map: Record<string, string> = {
    command: $t('@FLOWNODE:命令节点'),
    wait: $t('@FLOWNODE:等待节点'),
    version: $t('@FLOWNODE:版本管理'),
    confirm: $t('@FLOWNODE:用户确认'),
    code: $t('@FLOWNODE:代码节点'),
    condition: $t('@FLOWNODE:条件'),
    user_input: $t('@FLOWNODE:用户输入')
  }
  const typeLabel = map[props.node.type] || props.node.type
  return `${base} - ${typeLabel}`
})

// 弹窗显示控制
const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const codeInputRef = ref<InstanceType<typeof CodeNodeInputConfig> | null>(null)
const userInputRef = ref<InstanceType<typeof UserInputParamConfig> | null>(null)

// 表单数据
const formData = ref<{
  // 命令节点
  commandId?: string
  commandName?: string
  useTerminal?: boolean
  restartExistingTerminal?: boolean
  inputs?: NodeInput[]  // 命令输入参数配置
  
  // 等待节点
  waitSeconds?: number
  
  // 版本节点
  versionTarget?: 'version' | 'dependency'
  versionBump?: 'patch' | 'minor' | 'major'
  packageJsonPath?: string
  selectedPackageFile?: PackageFile | null
  dependencyName?: string
  dependencyVersion?: string
  dependencyType?: 'dependencies' | 'devDependencies'
  dependencyVersionMode?: 'bump' | 'manual'
  dependencyVersionBump?: 'patch' | 'minor' | 'major'
  // 输入引用功能
  versionSource?: 'bump' | 'manual' | 'reference'  // 版本号来源
  inputRef?: NodeOutputRef  // 引用的节点输出
  extractVersionFromRefOutput?: boolean

  // 代码节点
  codeScript?: string
  codeInputs?: CodeNodeInput[]
  codeOutputParams?: CodeNodeOutputParam[]
  commandOutputParams?: Array<{ key: string; desc?: string }>
  
  // 通用
  nodeName?: string
  enabled?: boolean

  // 条件节点
  conditionBranches?: ConditionBranch[]

  // 用户输入节点
  userInputParams?: UserInputParam[]
}>({})

type NormalizedConditionBranch = Omit<ConditionBranch, 'isDefault'> & { isDefault: boolean }

function createDefaultBranch(): NormalizedConditionBranch {
  return {
    id: `branch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: $t('@COND:默认分支'),
    handleId: 'default',
    priority: 999,
    combine: 'all',
    rules: [],
    isDefault: true
  }
}

function normalizeBranches(list: ConditionBranch[] | undefined): NormalizedConditionBranch[] {
  const arr = Array.isArray(list) ? list : []
  const normalized: NormalizedConditionBranch[] = arr
    .map((b) => ({
      id: String(b?.id || `branch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
      name: String(b?.name || '').trim() || $t('@COND:分支名称'),
      handleId: String(b?.handleId || '').trim() || 'branch',
      priority: Number.isFinite(Number(b?.priority)) ? Number(b?.priority) : 0,
      combine: (b?.combine === 'any' ? 'any' : 'all') as 'all' | 'any',
      rules: Array.isArray(b?.rules) ? b.rules : [],
      isDefault: Boolean(b?.isDefault)
    }))

  let hasDefault = normalized.some((b) => b.handleId === 'default' || b.isDefault)
  if (!hasDefault) normalized.push(createDefaultBranch())

  // 强制 default
  for (const b of normalized) {
    if (b.handleId === 'default') {
      b.isDefault = true
      if (!b.name) b.name = $t('@COND:默认分支')
    }
  }

  return normalized
}

function createRule(): ConditionRule {
  return {
    left: { nodeId: '', outputKey: 'stdout' },
    op: 'contains',
    right: ''
  }
}

function addBranch() {
  const cur = normalizeBranches(formData.value.conditionBranches)
  cur.push({
    id: `branch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: $t('@COND:分支名称'),
    handleId: `branch-${cur.length}`,
    priority: cur.length,
    combine: 'all',
    rules: [createRule()],
    isDefault: false
  })
  formData.value.conditionBranches = cur as any
}

function removeBranch(branchId: string) {
  const cur = normalizeBranches(formData.value.conditionBranches)
  const target = cur.find((b) => b.id === branchId)
  if (target?.handleId === 'default' || target?.isDefault) {
    ElMessage.warning($t('@COND:请至少保留一个默认分支'))
    return
  }
  formData.value.conditionBranches = cur.filter((b) => b.id !== branchId) as any
}

function addRuleRow(branchId: string) {
  const cur = normalizeBranches(formData.value.conditionBranches)
  const b = cur.find((it) => it.id === branchId)
  if (!b) return
  b.rules = Array.isArray(b.rules) ? [...b.rules, createRule()] : [createRule()]
  formData.value.conditionBranches = cur as any
}

function removeRuleRow(branchId: string, idx: number) {
  const cur = normalizeBranches(formData.value.conditionBranches)
  const b = cur.find((it) => it.id === branchId)
  if (!b) return
  b.rules = (Array.isArray(b.rules) ? b.rules : []).filter((_, i) => i !== idx)
  formData.value.conditionBranches = cur as any
}

function normalizeCodeInputs(list: CodeNodeInput[] | undefined) {
  const arr = Array.isArray(list) ? list : []
  const normalized = arr
    .map((it) => ({
      name: String(it?.name || '').trim(),
      source: (it?.source === 'manual' ? 'manual' : 'reference') as 'manual' | 'reference',
      manualValue: it?.manualValue === undefined || it?.manualValue === null ? '' : String(it.manualValue),
      ref: it?.ref ? { nodeId: String(it.ref.nodeId || ''), outputKey: String(it.ref.outputKey || 'stdout') } : undefined
    }))
    .filter((it) => Boolean(it.name) || Boolean(it.manualValue) || Boolean(it.ref?.nodeId))

  const seen = new Set<string>()
  const unique: CodeNodeInput[] = []
  for (const it of normalized) {
    if (seen.has(it.name)) continue
    seen.add(it.name)
    unique.push(it)
  }
  return unique.slice(0, 30)
}

function normalizeCodeOutputs(list: CodeNodeOutputParam[] | undefined) {
  const arr = Array.isArray(list) ? list : []
  const normalized = arr
    .map((it) => ({
      key: String((it as any)?.key || '').trim(),
      type: ((it as any)?.type || 'String') as 'String' | 'Number' | 'Boolean' | 'JSON',
      desc: String((it as any)?.desc || '').trim()
    }))
    .filter((it) => Boolean(it.key))

  const seen = new Set<string>()
  const unique: CodeNodeOutputParam[] = []
  for (const it of normalized) {
    if (seen.has(it.key)) continue
    seen.add(it.key)
    unique.push(it)
  }
  return unique.slice(0, 30)
}

function createCodeOutputParam(): CodeNodeOutputParam {
  return { key: '', type: 'String' }
}

function addCodeOutputRow() {
  const cur = Array.isArray(formData.value.codeOutputParams) ? [...formData.value.codeOutputParams] : []
  cur.push(createCodeOutputParam())
  formData.value.codeOutputParams = cur
}

// 可用的依赖列表
const availableDependencies = ref<string[]>([])

// 可用的自定义命令
const availableCommands = computed(() => configStore.customCommands || [])

// 当前命令的变量列表
const currentCommandVariables = computed(() => {
  if (!formData.value.commandId) return []
  const command = availableCommands.value.find(c => c.id === formData.value.commandId)
  if (!command) return []
  return extractVariables(command.command)
})

// 计算前置节点（可以引用输出的节点）
const predecessorNodes = computed(() => {
  if (!props.node || !props.allNodes || !props.edges) return []
  
  const currentNodeId = props.node.id
  const allEdges = props.edges
  const allNodes = props.allNodes
  
  // 使用 BFS 查找所有可以到达当前节点的前置节点
  const predecessors: FlowNode[] = []
  const visited = new Set<string>()
  const queue: string[] = [currentNodeId]
  
  // 获取指向目标节点的所有源节点
  function getPredecessors(nodeId: string): string[] {
    return allEdges
      .filter(edge => edge.target === nodeId)
      .map(edge => edge.source)
  }
  
  // BFS 遍历
  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const preds = getPredecessors(nodeId)
    
    for (const predId of preds) {
      if (!visited.has(predId)) {
        visited.add(predId)
        queue.push(predId)
        
        // 找到节点对象
        const predNode = allNodes.find(n => n.id === predId)
        // 只添加可输出结果的节点，排除开始节点
        if (predNode && (predNode.type === 'command' || predNode.type === 'code' || predNode.type === 'user_input') && predNode.data.config) {
          if (predNode.type === 'command' && (predNode.data.config as any)?.useTerminal === true) {
            continue
          }
          predecessors.push(predNode)
        }
      }
    }
  }
  
  return predecessors
})

// 获取节点的可用输出项
function getNodeOutputOptions(node?: FlowNode) {
  if (!node) return []
  if (node.type === 'command') {
    return [
      { key: 'stdout', label: $t('@NODECFG:标准输出(stdout)') },
      { key: 'stderr', label: $t('@NODECFG:标准错误(stderr)') },
      { key: 'error', label: $t('@NODECFG:错误(error)') }
    ]
  }
  if (node.type === 'code') {
    const cfg: any = (node.data as any)?.config
    const params = Array.isArray(cfg?.codeOutputParams) ? cfg.codeOutputParams : []
    if (params.length > 0) {
      return params
        .map((p: any) => String(p?.key || '').trim())
        .filter((k: string) => Boolean(k))
        .map((k: string) => ({ key: k, label: k }))
    }

    const keys = cfg?.codeOutputKeys
    const list = Array.isArray(keys) ? keys : []
    return list
      .map((k: any) => String(k || '').trim())
      .filter((k: string) => Boolean(k))
      .map((k: string) => ({ key: k, label: k }))
  }
  if (node.type === 'user_input') {
    const cfg: any = (node.data as any)?.config
    const list = Array.isArray(cfg?.userInputParams) ? cfg.userInputParams : []
    return list
      .map((p: any) => String(p?.name || '').trim())
      .filter((k: string) => Boolean(k))
      .map((k: string) => ({ key: k, label: k }))
  }
  return []
}

// 获取节点显示名称
function getNodeDisplayName(node: FlowNode): string {
  if (node.type === 'command') {
    return node.data.config?.commandName || node.data.label || $t('@NODECFG:命令节点')
  }
  if (node.type === 'code') {
    return node.data.label || $t('@FLOWNODE:代码节点')
  }
  if (node.type === 'user_input') {
    return node.data.label || $t('@FLOWNODE:用户输入')
  }
  return node.data.label || node.id
}

function ensureCommandOutputParams(list: Array<{ key: string; desc?: string }> | undefined) {
  const map = new Map<string, string>()
  for (const it of Array.isArray(list) ? list : []) {
    const k = String(it?.key || '').trim()
    if (!k) continue
    map.set(k, String(it?.desc || '').trim())
  }
  return [
    { key: 'stdout', desc: map.get('stdout') || '' },
    { key: 'stderr', desc: map.get('stderr') || '' },
    { key: 'error', desc: map.get('error') || '' }
  ]
}

// 监听节点变化，加载配置
watch(() => props.node, (node) => {
  if (!node) return
  
  const config = node.data.config
  
  if (node.type === 'command') {
    formData.value = {
      commandId: config?.commandId,
      commandName: config?.commandName,
      useTerminal: config?.useTerminal || false,
      restartExistingTerminal: config?.restartExistingTerminal || false,
      inputs: Array.isArray(config?.inputs) ? config.inputs : [],
      commandOutputParams: ensureCommandOutputParams((config as any)?.commandOutputParams),
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'wait') {
    formData.value = {
      waitSeconds: config?.waitSeconds || 5,
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'version') {
    // 判断版本来源模式
    let versionSource: 'bump' | 'manual' | 'reference' = 'bump'
    if (config?.inputRef) {
      versionSource = 'reference'
    } else if (config?.dependencyVersion || (config?.versionTarget !== 'dependency' && !config?.versionBump)) {
      versionSource = 'manual'
    } else if (config?.dependencyVersionBump || config?.versionBump) {
      versionSource = 'bump'
    }
    
    formData.value = {
      versionTarget: config?.versionTarget || 'version',
      versionBump: config?.versionBump || 'patch',
      packageJsonPath: config?.packageJsonPath || '',
      dependencyName: config?.dependencyName || '',
      dependencyVersion: config?.dependencyVersion || '',
      dependencyType: config?.dependencyType || 'dependencies',
      dependencyVersionMode: config?.dependencyVersionBump ? 'bump' : 'manual',
      dependencyVersionBump: config?.dependencyVersionBump || 'patch',
      versionSource: versionSource,
      inputRef: config?.inputRef,
      extractVersionFromRefOutput: (config as any)?.extractVersionFromRefOutput ?? true,
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
    
    if (config?.packageJsonPath) {
      loadDependenciesFromPackageJson(config.packageJsonPath)
    }
  } else if (node.type === 'code') {
    const inputs = Array.isArray((config as any)?.codeInputs) ? (config as any).codeInputs : []
    const outputs = Array.isArray((config as any)?.codeOutputParams) ? (config as any).codeOutputParams : []
    formData.value = {
      codeScript: (config as any)?.codeScript || '',
      codeInputs: inputs,
      codeOutputParams: outputs,
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'confirm') {
    formData.value = {
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'condition') {
    const branches = normalizeBranches((config as any)?.conditionBranches)
    formData.value = {
      conditionBranches: branches,
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'user_input') {
    formData.value = {
      userInputParams: Array.isArray((config as any)?.userInputParams) ? (config as any).userInputParams : [],
      nodeName: (config as any)?.displayName || node.data.label || '',
      enabled: node.data.enabled ?? true
    }
  }
}, { immediate: true })

// 从 package.json 加载依赖列表
async function loadDependenciesFromPackageJson(pkgPath: string) {
  try {
    const response = await fetch('/api/read-package-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageJsonPath: pkgPath })
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    
    const result = await response.json()
    if (result.success) {
      const deps = []
      const depType = formData.value.dependencyType || 'dependencies'
      if (depType === 'dependencies' && result.dependencies) {
        deps.push(...Object.keys(result.dependencies))
      } else if (depType === 'devDependencies' && result.devDependencies) {
        deps.push(...Object.keys(result.devDependencies))
      }
      availableDependencies.value = deps.sort()
    }
  } catch (error) {
    console.error($t('@NODECFG:读取依赖列表失败'), error)
    availableDependencies.value = []
  }
}

// 监听依赖类型变化
watch(() => formData.value.dependencyType, () => {
  if (formData.value.packageJsonPath) {
    loadDependenciesFromPackageJson(formData.value.packageJsonPath)
  }
})

// 处理 package.json 文件选择
function handlePackageFileChange(packageFile: PackageFile | null) {
  formData.value.selectedPackageFile = packageFile
  if (packageFile) {
    formData.value.packageJsonPath = packageFile.fullPath
    loadDependenciesFromPackageJson(packageFile.fullPath)
  } else {
    availableDependencies.value = []
  }
}

// 选择命令
function selectCommand(command: CustomCommand) {
  formData.value.commandId = command.id
  formData.value.commandName = command.name
}

// 生成唯一 ID
function generateId() {
  return `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// 保存配置
function saveConfig() {
  if (!props.node) return
  
  let config: OrchestrationStep | null = null
  
  if (props.node.type === 'command') {
    if (!formData.value.commandId) {
      ElMessage.warning($t('@NODECFG:请选择要执行的命令'))
      return
    }

    const inputsToCheck = Array.isArray(formData.value.inputs) ? formData.value.inputs : []
    for (const it of inputsToCheck) {
      if (!it || !it.required) continue
      const name = String((it as any).paramName || '').trim() || $t('@NODEINPUT:参数名')
      const type = (it as any).inputType
      if (type === 'reference') {
        const nodeId = String((it as any).referenceNodeId || '').trim()
        const key = String((it as any).referenceOutputKey || '').trim()
        if (!nodeId || !key) {
          ElMessage.warning($t('@NODECFG:必填参数未选择引用输出', { name }))
          return
        }
      } else {
        const v = (it as any).manualValue
        if (v === undefined || v === null || String(v).trim() === '') {
          ElMessage.warning($t('@NODECFG:请输入必填参数的值', { name }))
          return
        }
      }
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID，用于节点间引用
      type: 'command',
      displayName: formData.value.nodeName?.trim() || undefined,
      commandId: formData.value.commandId,
      commandName: formData.value.commandName || '',
      useTerminal: formData.value.useTerminal || false,
      restartExistingTerminal: formData.value.useTerminal ? (formData.value.restartExistingTerminal || false) : false,
      inputs: formData.value.inputs || [],
      commandOutputParams: ensureCommandOutputParams(formData.value.commandOutputParams),
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'wait') {
    if (!formData.value.waitSeconds || formData.value.waitSeconds <= 0) {
      ElMessage.warning($t('@NODECFG:等待时间必须大于0秒'))
      return
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID
      type: 'wait',
      displayName: formData.value.nodeName?.trim() || undefined,
      waitSeconds: formData.value.waitSeconds,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'version') {
    if (formData.value.versionTarget === 'dependency') {
      if (!formData.value.dependencyName?.trim()) {
        ElMessage.warning($t('@NODECFG:请选择依赖包名称'))
        return
      }
      // 根据版本来源验证
      if (formData.value.versionSource === 'manual' && !formData.value.dependencyVersion?.trim()) {
        ElMessage.warning($t('@NODECFG:请输入依赖包版本号'))
        return
      }
      if (formData.value.versionSource === 'reference' && !formData.value.inputRef) {
        ElMessage.warning($t('@NODECFG:请选择要引用的节点输出'))
        return
      }
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID
      type: 'version',
      displayName: formData.value.nodeName?.trim() || undefined,
      versionTarget: formData.value.versionTarget || 'version',
      versionBump: formData.value.versionSource === 'bump' ? (formData.value.versionBump || 'patch') : undefined,
      packageJsonPath: formData.value.packageJsonPath?.trim() || undefined,
      dependencyName: formData.value.versionTarget === 'dependency' ? formData.value.dependencyName?.trim() : undefined,
      dependencyVersion: formData.value.versionTarget === 'dependency' && formData.value.versionSource === 'manual' ? formData.value.dependencyVersion?.trim() : undefined,
      dependencyVersionBump: formData.value.versionTarget === 'dependency' && formData.value.versionSource === 'bump' ? formData.value.dependencyVersionBump : undefined,
      dependencyType: formData.value.versionTarget === 'dependency' ? formData.value.dependencyType : undefined,
      versionSource: formData.value.versionSource,
      inputRef: formData.value.versionSource === 'reference' ? formData.value.inputRef : undefined,
      extractVersionFromRefOutput: formData.value.versionSource === 'reference' ? (formData.value.extractVersionFromRefOutput ?? true) : undefined,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'code') {
    if (!formData.value.codeScript || !String(formData.value.codeScript).trim()) {
      ElMessage.warning($t('@NODECFG:请输入脚本'))
      return
    }

    const inputs = normalizeCodeInputs(formData.value.codeInputs)
    for (const it of Array.isArray(inputs) ? inputs : []) {
      if (!it || !(it as any).required) continue
      const name = String((it as any).name || '').trim() || $t('@NODECFG:参数名')
      const source = (it as any).source
      if (source === 'reference') {
        const nodeId = String((it as any).ref?.nodeId || '').trim()
        const key = String((it as any).ref?.outputKey || '').trim()
        if (!nodeId || !key) {
          ElMessage.warning($t('@NODECFG:必填参数未选择引用输出', { name }))
          return
        }
      } else {
        const v = (it as any).manualValue
        if (v === undefined || v === null || String(v).trim() === '') {
          ElMessage.warning($t('@NODECFG:请输入必填参数的值', { name }))
          return
        }
      }
    }
    const outputs = normalizeCodeOutputs(formData.value.codeOutputParams)
    if (outputs.length === 0) {
      ElMessage.warning($t('@NODECFG:请配置输出键'))
      return
    }

    const keys = outputs.map((p: CodeNodeOutputParam) => p.key)

    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,
      type: 'code',
      displayName: formData.value.nodeName?.trim() || undefined,
      codeScript: formData.value.codeScript,
      codeInputs: inputs,
      codeOutputParams: outputs,
      codeOutputKeys: keys,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'confirm') {
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,
      type: 'confirm',
      displayName: formData.value.nodeName?.trim() || undefined,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'condition') {
    const branches = normalizeBranches(formData.value.conditionBranches)
    const hasDefault = branches.some((b) => b.handleId === 'default' || b.isDefault)
    if (!hasDefault) {
      ElMessage.warning($t('@COND:请至少保留一个默认分支'))
      return
    }
    // 强制 default handleId
    for (const b of branches) {
      if (b.isDefault && b.handleId !== 'default') {
        ElMessage.warning($t('@COND:默认分支必须使用handleId=default'))
        return
      }
    }

    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,
      type: 'condition',
      displayName: formData.value.nodeName?.trim() || undefined,
      conditionBranches: branches,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'user_input') {
    const list = Array.isArray(formData.value.userInputParams) ? formData.value.userInputParams : []
    const cleaned = list
      .map((it: any) => ({
        name: String(it?.name || '').trim(),
        source: (it?.source === 'reference' ? 'reference' : 'manual') as 'reference' | 'manual',
        required: Boolean(it?.required),
        defaultValue: it?.defaultValue === undefined || it?.defaultValue === null ? '' : String(it.defaultValue),
        ref: it?.ref ? { nodeId: String(it.ref.nodeId || ''), outputKey: String(it.ref.outputKey || 'stdout') } : undefined
      }))
      .filter((it: any) => Boolean(it.name))

    const seen = new Set<string>()
    const unique: UserInputParam[] = []
    for (const it of cleaned) {
      if (!it.name) continue
      if (seen.has(it.name)) continue
      seen.add(it.name)
      unique.push(it)
    }

    for (const it of unique) {
      if (!it.required) continue
      if (it.source === 'reference') {
        const nodeId = String(it?.ref?.nodeId || '').trim()
        const key = String(it?.ref?.outputKey || '').trim()
        if (!nodeId || !key) {
          ElMessage.warning($t('@NODECFG:必填参数未选择引用输出', { name: it.name }))
          return
        }
      }
    }

    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,
      type: 'user_input',
      displayName: formData.value.nodeName?.trim() || undefined,
      userInputParams: unique,
      enabled: formData.value.enabled ?? true
    }
  }
  
  if (config) {
    emit('update-config', props.node.id, config)
    ElMessage.success($t('@NODECFG:节点配置已保存'))
    visible.value = false
  }
}
</script>

<template>
  <CommonDialog
    v-model="visible"
    :title="dialogTitle"
    size="extra-large"
    :append-to-body="true"
    :z-index="800000"
    custom-class="node-config-dialog"
  >
    <div v-if="node" class="config-content">
      <!-- 通用配置 -->
      <div class="config-section">
        <div class="section-title">
          <el-icon><Select /></el-icon>
          {{ $t('@NODECFG:通用设置') }}
        </div>

        <el-form label-width="120px">
          <el-form-item :label="$t('@NODECFG:节点名称')">
            <el-input v-model="formData.nodeName" :placeholder="$t('@NODECFG:请输入节点名称')" />
          </el-form-item>

          <el-form-item :label="$t('@NODECFG:启用节点')">
            <el-switch v-model="formData.enabled" />
          </el-form-item>
        </el-form>
      </div>

      <!-- 条件节点配置 -->
      <div v-if="node?.type === 'condition'" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@COND:条件配置') }}
          <el-button class="icon-btn" type="primary" plain circle :icon="Plus" style="margin-left: auto;" :title="$t('@COND:添加分支')" @click="addBranch" />
        </div>

        <div class="sub-section">
          <div class="sub-title">
            <span>{{ $t('@COND:分支列表') }}</span>
          </div>

          <div v-if="!formData.conditionBranches || formData.conditionBranches.length === 0" class="empty-tip">
            {{ $t('@COND:请至少保留一个默认分支') }}
          </div>

          <div v-else class="condition-branch-list">
            <div v-for="b in formData.conditionBranches" :key="b.id" class="condition-branch-card">
              <div class="branch-main">
                <div class="branch-header">
                  <div class="branch-title">
                    <span class="branch-badge" v-if="b.handleId === 'default' || b.isDefault">{{ $t('@COND:默认分支') }}</span>
                    <el-input v-model="b.name" size="small" :disabled="b.handleId === 'default' || b.isDefault" :placeholder="$t('@COND:分支名称')" />
                  </div>
                </div>

                <div class="branch-meta">
                  <el-form label-width="80px">
                    <el-form-item :label="$t('@COND:优先级')">
                      <el-input-number v-model="b.priority" :min="0" :max="9999" size="small" />
                    </el-form-item>
                    <el-form-item :label="$t('@COND:规则组合')">
                      <el-radio-group v-model="b.combine" size="small">
                        <el-radio value="all">{{ $t('@COND:且(ALL)') }}</el-radio>
                        <el-radio value="any">{{ $t('@COND:或(ANY)') }}</el-radio>
                      </el-radio-group>
                    </el-form-item>
                  </el-form>
                </div>

                <div v-if="b.handleId !== 'default' && !b.isDefault" class="branch-rules">
                  <div class="rules-header">
                    <span>{{ $t('@COND:规则') }}</span>
                    <el-button class="icon-btn" type="primary" plain circle :icon="Plus" :title="$t('@COND:添加规则')" @click="addRuleRow(b.id)" />
                  </div>

                  <div v-for="(r, idx) in b.rules" :key="idx" class="rule-row">
                    <div class="rule-col">
                      <div class="field-label">{{ $t('@COND:左值(引用输出)') }}</div>
                      <el-select v-model="r.left.nodeId" filterable clearable size="small" style="width: 100%" :placeholder="$t('@NODECFG:引用节点')">
                        <el-option
                          v-for="pn in predecessorNodes"
                          :key="pn.id"
                          :label="getNodeDisplayName(pn)"
                          :value="pn.id"
                        />
                      </el-select>
                      <el-select v-model="r.left.outputKey" filterable size="small" style="width: 100%; margin-top: 6px" :placeholder="$t('@NODECFG:输出')">
                        <el-option
                          v-for="opt in getNodeOutputOptions(predecessorNodes.find((n) => n.id === r.left.nodeId))"
                          :key="opt.key"
                          :label="opt.label"
                          :value="opt.key"
                        />
                      </el-select>
                    </div>
                    <div class="rule-col">
                      <div class="field-label">{{ $t('@COND:操作符') }}</div>
                      <el-select v-model="r.op" size="small" style="width: 100%">
                        <el-option label="==" value="==" />
                        <el-option label="!=" value="!=" />
                        <el-option label=">" value=">" />
                        <el-option label=">=" value=">=" />
                        <el-option label="<" value="<" />
                        <el-option label="<=" value="<=" />
                        <el-option label="contains" value="contains" />
                        <el-option label="not_contains" value="not_contains" />
                        <el-option label="isEmpty" value="isEmpty" />
                        <el-option label="isNotEmpty" value="isNotEmpty" />
                      </el-select>
                    </div>
                    <div class="rule-col">
                      <div class="field-label">{{ $t('@COND:右值') }}</div>
                      <el-input v-model="r.right" size="small" :disabled="r.op === 'isEmpty' || r.op === 'isNotEmpty'" />
                    </div>
                    <div class="rule-col" style="align-self: flex-end;">
                      <el-button class="icon-btn" type="danger" plain circle :icon="Minus" :title="$t('@COND:删除规则')" @click="removeRuleRow(b.id, idx)" />
                    </div>
                  </div>
                </div>
                <div v-else class="branch-default-tip">
                  {{ $t('@COND:默认分支') }}：不配置规则，未命中其它分支时走这里
                </div>
              </div>

              <div class="branch-actions" v-if="!(b.handleId === 'default' || b.isDefault)">
                <el-button
                  class="icon-btn"
                  type="danger"
                  plain
                  circle
                  :icon="Delete"
                  :title="$t('@COND:删除分支')"
                  @click="removeBranch(b.id)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="node?.type === 'command'" class="config-section">
        <div class="section-title">
          <el-icon><Select /></el-icon>
          {{ $t('@NODECFG:执行方式') }}
        </div>

        <el-form label-width="120px">
          <el-form-item :label="$t('@NODECFG:执行方式')">
            <el-radio-group v-model="formData.useTerminal">
              <el-radio :value="false">{{ $t('@NODECFG:普通执行') }}</el-radio>
              <el-radio :value="true">{{ $t('@NODECFG:终端执行') }}</el-radio>
            </el-radio-group>
          </el-form-item>

          <el-form-item v-if="formData.useTerminal" :label="$t('@NODECFG:终端选项')">
            <el-checkbox v-model="formData.restartExistingTerminal">{{ $t('@NODECFG:重启现存终端命令') }}</el-checkbox>
          </el-form-item>
        </el-form>
      </div>

      <!-- 命令输入参数配置（独立版块） -->
      <div v-if="node?.type === 'command' && formData.commandId && formData.inputs" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@NODECFG:输入配置') }}
        </div>
        <NodeInputConfig
          v-model="formData.inputs"
          :param-names="currentCommandVariables"
          :disable-param-name-edit="true"
          :predecessor-nodes="predecessorNodes"
        />
      </div>

      <!-- 代码节点输入参数配置（节点级独立版块） -->
      <div v-if="node?.type === 'code'" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@NODECFG:输入配置') }}
          <el-button type="primary" plain :icon="Plus" style="margin-left: auto;" @click="codeInputRef?.addRow()" />
        </div>
        <CodeNodeInputConfig
          ref="codeInputRef"
          :model-value="formData.codeInputs || []"
          @update:model-value="(v) => (formData.codeInputs = v)"
          :predecessor-nodes="predecessorNodes"
          :title="undefined"
          :addable="false"
        />
      </div>

      <!-- 用户输入节点参数配置（节点级独立版块） -->
      <div v-if="node?.type === 'user_input'" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@NODECFG:输入配置') }}
          <el-button type="primary" plain :icon="Plus" style="margin-left: auto;" @click="userInputRef?.addRow()" />
        </div>
        <UserInputParamConfig
          ref="userInputRef"
          :model-value="formData.userInputParams || []"
          @update:model-value="(v) => (formData.userInputParams = v)"
          :predecessor-nodes="predecessorNodes"
          :title="undefined"
          :addable="false"
        />
      </div>
      
      <!-- 命令节点配置 -->
      <div v-if="node?.type === 'command'" class="config-section">
        <div class="section-title">
          <el-icon><svg-icon icon-class="custom-cmd" /></el-icon>
          {{ $t('@NODECFG:命令配置') }}
          <el-button
            type="primary"
            plain
            size="small"
            style="margin-left: auto;"
            @click="openCommandManager"
          >
            {{ $t('@NODECFG:管理命令') }}
          </el-button>
        </div>
        
        <el-form label-width="100px">
          <el-form-item :label="$t('@NODECFG:选择命令')" required>
            <div v-if="availableCommands.length === 0" class="empty-tip">
              {{ $t('@NODECFG:暂无可用命令请先创建命令') }}
            </div>
            <div v-else class="command-list">
              <div
                v-for="command in availableCommands"
                :key="command.id"
                class="command-item"
                :class="{ 'selected': formData.commandId === command.id }"
                @click="selectCommand(command)"
              >
                <div class="command-info">
                  <div class="command-header">
                    <span class="command-name">{{ command.name }}</span>
                    <span v-if="command.description" class="command-desc">{{ command.description }}</span>
                  </div>
                  <code class="command-code">{{ command.command }}</code>
                  <div class="command-dir">
                    <el-icon><Folder /></el-icon>
                    <span>{{ command.directory ? command.directory.replace(/\\/g, '/') : $t('@NODECFG:当前目录') }}</span>
                  </div>
                </div>
                <el-icon v-if="formData.commandId === command.id" class="check-icon">
                  <Select />
                </el-icon>
              </div>
            </div>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 等待节点配置 -->
      <div v-if="node?.type === 'wait'" class="config-section">
        <div class="section-title">
          <el-icon><Clock /></el-icon>
          {{ $t('@NODECFG:等待配置') }}
        </div>
        
        <el-form label-width="100px">
          <el-form-item :label="$t('@NODECFG:等待时间')" required>
            <el-input-number 
              v-model="formData.waitSeconds" 
              :min="1" 
              :max="3600" 
              :step="1"
            />
            <span style="margin-left: var(--spacing-md);">{{ $t('@NODECFG:秒') }}</span>
          </el-form-item>
        </el-form>
      </div>

      <div v-if="node?.type === 'code'" class="config-section">
        <div class="section-title">
          <el-icon><DocumentAdd /></el-icon>
          {{ $t('@NODECFG:代码配置') }}
        </div>

        <div class="sub-section">
          <div class="sub-title">
            <span>{{ $t('@NODECFG:代码') }}</span>
          </div>

          <el-input
            v-model="formData.codeScript"
            type="textarea"
            :rows="10"
            :placeholder="codeScriptExample"
          />

          <div class="code-examples">
            <div class="examples-title">{{ $t('@NODECFG:示例代码') }}</div>
            <div class="examples-actions">
              <el-button
                v-for="ex in codeScriptExamples"
                :key="ex.key"
                type="primary"
                plain
                @click="applyCodeExample(ex.script)"
              >
                {{ ex.title }}
              </el-button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 版本节点配置 -->
      <div v-if="node?.type === 'version'" class="config-section">
        <div class="section-title">
          <el-icon><DocumentAdd /></el-icon>
          {{ $t('@NODECFG:版本配置') }}
        </div>
        
        <el-form label-width="120px">
          <el-form-item :label="$t('@NODECFG:package.json')">
            <PackageJsonSelector
              v-model="formData.packageJsonPath!"
              :placeholder="$t('@NODECFG:留空则使用当前目录的package.json')"
              clearable
              @change="handlePackageFileChange"
            />
          </el-form-item>
          
          <el-form-item :label="$t('@NODECFG:修改目标')" required>
            <el-radio-group v-model="formData.versionTarget">
              <el-radio value="version">{{ $t('@NODECFG:version字段') }}</el-radio>
              <el-radio value="dependency">{{ $t('@NODECFG:dependencies中的依赖') }}</el-radio>
            </el-radio-group>
          </el-form-item>
          
          <!-- version 字段配置 -->
          <template v-if="formData.versionTarget === 'version'">
            <el-form-item :label="$t('@NODECFG:版本增量类型')" required>
              <el-radio-group v-model="formData.versionBump">
                <el-radio value="patch">{{ $t('@NODECFG:补丁版本x.x.+1') }}</el-radio>
                <el-radio value="minor">{{ $t('@NODECFG:次版本x.+1.0') }}</el-radio>
                <el-radio value="major">{{ $t('@NODECFG:主版本+1.0.0') }}</el-radio>
              </el-radio-group>
            </el-form-item>
          </template>
          
          <!-- dependency 配置 -->
          <template v-if="formData.versionTarget === 'dependency'">
            <el-form-item :label="$t('@NODECFG:依赖类型')" required>
              <el-radio-group v-model="formData.dependencyType">
                <el-radio value="dependencies">dependencies</el-radio>
                <el-radio value="devDependencies">devDependencies</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item :label="$t('@NODECFG:依赖包名称')" required>
              <el-select 
                v-model="formData.dependencyName" 
                :placeholder="$t('@NODECFG:请先选择package.json')"
                clearable
                filterable
                allow-create
                style="width: 100%"
              >
                <el-option
                  v-for="dep in availableDependencies"
                  :key="dep"
                  :label="dep"
                  :value="dep"
                />
              </el-select>
            </el-form-item>
            
            <el-form-item :label="$t('@NODECFG:版本号来源')" required>
              <el-radio-group v-model="formData.versionSource">
                <el-radio value="bump">{{ $t('@NODECFG:自动递增') }}</el-radio>
                <el-radio value="manual">{{ $t('@NODECFG:手动输入') }}</el-radio>
                <el-radio value="reference" :disabled="predecessorNodes.length === 0">
                  {{ $t('@NODECFG:引用输出') }}
                  <el-tooltip v-if="predecessorNodes.length === 0" :content="$t('@NODECFG:无可用的前置命令节点')" placement="top">
                    <el-icon style="margin-left: 4px;"><Link /></el-icon>
                  </el-tooltip>
                </el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.versionSource === 'bump'" :label="$t('@NODECFG:递增类型')" required>
              <el-radio-group v-model="formData.dependencyVersionBump">
                <el-radio value="patch">{{ $t('@NODECFG:补丁版本') }}</el-radio>
                <el-radio value="minor">{{ $t('@NODECFG:次版本') }}</el-radio>
                <el-radio value="major">{{ $t('@NODECFG:主版本') }}</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.versionSource === 'manual'" :label="$t('@NODECFG:版本号')" required>
              <el-input 
                v-model="formData.dependencyVersion" 
                :placeholder="$t('@NODECFG:例如1.2.3')"
              />
            </el-form-item>
            
            <!-- 引用输出配置 -->
            <template v-if="formData.versionSource === 'reference'">
              <el-form-item :label="$t('@NODECFG:引用节点')" required>
                <el-select 
                  v-model="formData.inputRef"
                  value-key="nodeId"
                  :placeholder="$t('@NODECFG:选择要引用的前置节点')"
                  style="width: 100%"
                >
                  <el-option
                    v-for="predNode in predecessorNodes"
                    :key="predNode.id"
                    :label="getNodeDisplayName(predNode)"
                    :value="{ nodeId: predNode.id, outputKey: 'stdout' }"
                  >
                    <div class="node-option">
                      <span class="node-name">{{ getNodeDisplayName(predNode) }}</span>
                      <span class="node-id">{{ $t('@NODECFG:ID') }}: {{ predNode.id.substring(0, 15) }}...</span>
                    </div>
                  </el-option>
                </el-select>
              </el-form-item>
              
              <el-form-item v-if="formData.inputRef" :label="$t('@NODECFG:输出字段')" required>
                <el-select 
                  v-model="formData.inputRef.outputKey"
                  :placeholder="$t('@NODECFG:选择要引用的输出字段')"
                  style="width: 100%"
                >
                  <el-option
                    v-for="opt in getNodeOutputOptions(predecessorNodes.find(n => n.id === formData.inputRef?.nodeId))"
                    :key="opt.key"
                    :label="opt.label"
                    :value="opt.key"
                  />
                </el-select>
              </el-form-item>

              <el-form-item v-if="formData.inputRef" :label="$t('@NODECFG:提取版本号')">
                <el-switch v-model="formData.extractVersionFromRefOutput" />
              </el-form-item>
              
              <div class="reference-tip">
                <el-icon><Link /></el-icon>
                <span>{{ $t('@NODECFG:版本号将使用所选节点的输出结果') }}</span>
              </div>
            </template>
          </template>
        </el-form>
      </div>

      <div v-if="node?.type === 'code'" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@NODECFG:输出') }}
          <el-button type="primary" plain :icon="Plus" style="margin-left: auto;" @click="addCodeOutputRow" />
        </div>

        <ParamListContainer
          :model-value="formData.codeOutputParams || []"
          :title="undefined"
          :addable="false"
          :removable="true"
          :min-items="0"
          :create-item="createCodeOutputParam"
          @update:modelValue="(v: CodeNodeOutputParam[]) => (formData.codeOutputParams = v)"
        >
          <template #empty>
            {{ $t('@NODECFG:暂无输出参数') || '' }}
          </template>

          <template #row="{ item: row }">
            <div class="output-param-row">
              <div class="output-param-field">
                <label class="field-label">{{ $t('@NODECFG:参数名') }}</label>
                <el-input v-model="row.key" :placeholder="$t('@NODECFG:参数名')" />
              </div>
              <div class="output-param-field">
                <label class="field-label">{{ $t('@NODECFG:参数类型') }}</label>
                <el-select v-model="row.type" style="width: 180px">
                  <el-option label="String" value="String" />
                  <el-option label="Number" value="Number" />
                  <el-option label="Boolean" value="Boolean" />
                  <el-option label="JSON" value="JSON" />
                </el-select>
              </div>
            </div>
          </template>
        </ParamListContainer>
      </div>

      <div v-if="node?.type === 'command'" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          {{ $t('@NODECFG:输出配置') }}
        </div>

        <ParamListContainer
          :model-value="formData.commandOutputParams || []"
          :title="undefined"
          :addable="false"
          :removable="false"
          @update:modelValue="(v: Array<{ key: string; desc?: string }>) => (formData.commandOutputParams = v)"
        >
          <template #empty>
            {{ $t('@NODECFG:暂无输出参数') || '' }}
          </template>

          <template #row="{ item: row }">
            <div class="output-param-row">
              <div class="output-param-field">
                <label class="field-label">{{ $t('@NODECFG:参数名') }}</label>
                <el-input v-model="row.key" disabled />
              </div>
              <div class="output-param-field">
                <label class="field-label">{{ $t('@NODECFG:参数描述') }}</label>
                <el-input v-model="row.desc" :placeholder="$t('@NODECFG:参数描述')" />
              </div>
            </div>
          </template>
        </ParamListContainer>
      </div>
    </div>
    
    <template #footer>
      <div class="dialog-footer">
        <div class="footer-actions">
          <button type="button" class="dialog-cancel-btn" @click="visible = false">
            {{ $t('@NODECFG:取消') }}
          </button>
          <button type="button" class="dialog-confirm-btn" @click="saveConfig">
            <el-icon><Select /></el-icon>
            <span>{{ $t('@NODECFG:保存配置') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<style scoped lang="scss">

.config-section {
  margin-bottom: 20px;
  padding: var(--spacing-lg);
  background: var(--bg-component-area);
  border-radius: var(--radius-lg);
  
  .section-title {
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    margin-bottom: var(--spacing-lg);
    display: flex;
    align-items: center;
    gap: var(--spacing-base);
    color: var(--text-primary);
  }
}

.command-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--spacing-lg);
  width: 100%;
}

.code-examples {
  margin-top: var(--spacing-md);
  padding-top: var(--spacing-md);
  border-top: 1px dashed var(--border-component);
}

.examples-title {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  margin-bottom: var(--spacing-sm);
}

.examples-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

/* 让 el-form-item 内容区撑满，避免 grid 容器被内容宽度收缩导致只显示单列 */
:deep(.el-form-item__content) {
  width: 100%;
}

.command-item {
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  border: 2px solid var(--border-component);
  cursor: pointer;
  transition: var(--transition-all);
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-md);
  
  &:hover {
    border-color: var(--color-primary);
    background: var(--bg-input-hover);
  }
  
  &.selected {
    border-color: var(--color-primary);
    background: rgba(64, 158, 255, 0.12);
    
    .command-name {
      color: var(--color-primary);
    }
  }
  
  .command-info {
    flex: 1;
    min-width: 0;
    
    .command-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-base);
      margin-bottom: var(--spacing-sm);
      flex-wrap: wrap;
    }
    
    .command-name {
      font-weight: var(--font-weight-semibold);
      font-size: var(--font-size-md);
    }
    
    .command-desc {
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
    }
    
    .command-code {
      display: block;
      padding: var(--spacing-sm) var(--spacing-base);
      background: var(--bg-container);
      border-radius: var(--radius-base);
      font-size: var(--font-size-sm);
      color: var(--text-primary);
      margin-bottom: var(--spacing-sm);
      word-break: break-all;
    }
    
    .command-dir {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
      
      .el-icon {
        color: var(--color-warning);
        font-size: 14px;
      }
      
      span {
        word-break: break-all;
      }
    }
  }
  
  .check-icon {
    color: var(--color-primary);
    font-size: 22px;
    flex-shrink: 0;
  }
}

.empty-tip {
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
  padding: 20px;
  text-align: center;
}

.condition-branch-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.condition-branch-card {
  border: 1px solid var(--border-component);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.02);
  padding: var(--spacing-md);
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--spacing-md);
}

.branch-main {
  min-width: 0;
}

.branch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-md);
}

.branch-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;

  :deep(.el-input) {
    width: 100%;
  }
}

.branch-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.25);
  flex-shrink: 0;
}

.branch-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-left: var(--spacing-md);
  border-left: 1px solid var(--border-component);
}

:deep(.icon-btn.el-button) {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

:deep(.icon-btn.el-button.is-circle) {
  padding: 0;
}

:deep(.icon-btn.el-button.is-plain) {
  background: transparent;
}

:deep(.icon-btn.el-button:hover) {
  filter: brightness(1.03);
}

:deep(.icon-btn.el-button:active) {
  transform: translateY(0.5px);
}

.branch-meta {
  margin-bottom: var(--spacing-md);

  :deep(.el-form) {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--spacing-md);
    align-items: start;
  }

  :deep(.el-form-item) {
    margin-bottom: 0;
  }

  :deep(.el-form-item__content) {
    width: 100%;
  }
}

.rules-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.rule-row {
  display: grid;
  grid-template-columns: minmax(280px, 2fr) minmax(140px, 1fr) minmax(220px, 2fr) auto;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-md);
  background: var(--bg-container);
  margin-bottom: var(--spacing-sm);
}

.rule-row .rule-col:last-child {
  display: flex;
  justify-content: center;
}

.rule-col {
  min-width: 0;

  :deep(.el-select),
  :deep(.el-input),
  :deep(.el-input-number) {
    width: 100%;
  }
}

.field-label {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.branch-default-tip {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: var(--spacing-sm);
  border-radius: var(--radius-md);
  background: rgba(64, 158, 255, 0.08);
  border: 1px solid rgba(64, 158, 255, 0.18);
}

.form-tip {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  
  .el-icon {
    font-size: var(--font-size-base);
    color: var(--color-primary);
  }
}

.reference-tip {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-md);
  margin-top: var(--spacing-base);
  background: rgba(64, 158, 255, 0.08);
  border-radius: var(--radius-md);
  border: 1px solid rgba(64, 158, 255, 0.2);
  font-size: var(--font-size-sm);
  color: var(--color-primary);
  
  .el-icon {
    font-size: var(--font-size-md);
  }
}

.node-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  
  .node-name {
    font-weight: var(--font-weight-medium);
    color: var(--text-primary);
  }
  
  .node-id {
    font-size: 11px;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
  }
}

.output-rows {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  width: 100%;
}

.output-row {
  display: grid;
  grid-template-columns: 160px 1fr 44px;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  background: var(--bg-component-area);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-component);
  transition: var(--transition-all);
}

.output-row:hover {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-sm);
}

.output-row.output-row-header {
  grid-template-columns: 160px 1fr 44px;
  align-items: center;
  padding: 2px 0;
  background: transparent;
  border: 0;
  box-shadow: none;
}

.output-param-row {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: var(--spacing-md);
  align-items: end;
}

.output-param-field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.field-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
}

.output-row.output-row-footer {
  grid-template-columns: 1fr;
}

.output-col-title {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.output-col-actions {
  display: flex;
  justify-content: flex-end;
}

.sub-section {
  background: var(--bg-container);
  border: 1px solid var(--border-component);
  border-radius: var(--radius-md);
  padding: var(--spacing-lg);
}

.sub-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.table-rows {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.table-row {
  display: grid;
  grid-template-columns: 220px 1fr 44px;
  gap: var(--spacing-md);
  align-items: center;
}

.table-row.table-header {
  grid-template-columns: 220px 1fr 44px;
  padding: 2px 0;
}

.col-title {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.col-actions {
  display: flex;
  justify-content: flex-end;
}

.value-cell {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-width: 0;
}
</style>
