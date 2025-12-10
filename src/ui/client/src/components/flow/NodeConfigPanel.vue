<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Clock, DocumentAdd, Link, Folder, Select } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep, type NodeOutputRef, type NodeInput } from '@stores/configStore'
import type { FlowNode, FlowEdge } from './FlowOrchestrationWorkspace.vue'
import CommonDialog from '@components/CommonDialog.vue'
import PackageJsonSelector from '@components/PackageJsonSelector.vue'
import NodeInputConfig from './NodeInputConfig.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import type { CustomCommand } from '@components/CustomCommandManager.vue'
import type { PackageFile } from '@components/PackageJsonSelector.vue'
import { extractVariables } from '@/utils/commandParser'

const props = defineProps<{
  modelValue: boolean
  node: FlowNode | null
  allNodes?: FlowNode[]  // 所有节点列表
  edges?: FlowEdge[]     // 所有边列表
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'update-config', nodeId: string, config: OrchestrationStep): void
}>()

const configStore = useConfigStore()

// 弹窗显示控制
const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

// 表单数据
const formData = ref<{
  // 命令节点
  commandId?: string
  commandName?: string
  useTerminal?: boolean
  outputKey?: string  // 输出键名（命令节点可以输出结果）
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
  
  // 通用
  enabled?: boolean
}>({})

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
        // 只添加命令节点（可以输出结果），排除开始节点
        if (predNode && predNode.type === 'command' && predNode.data.config) {
          predecessors.push(predNode)
        }
      }
    }
  }
  
  return predecessors
})

// 获取节点的可用输出项
function getNodeOutputOptions(node: FlowNode) {
  if (node.type === 'command') {
    return [
      { key: 'stdout', label: '标准输出 (stdout)' },
      { key: 'version', label: '提取的版本号' }
    ]
  }
  return []
}

// 获取节点显示名称
function getNodeDisplayName(node: FlowNode): string {
  if (node.type === 'command') {
    return node.data.config?.commandName || node.data.label || '命令节点'
  }
  return node.data.label || node.id
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
      inputs: Array.isArray(config?.inputs) ? config.inputs : [],
      outputKey: config?.outputKey,
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'wait') {
    formData.value = {
      waitSeconds: config?.waitSeconds || 5,
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
      enabled: node.data.enabled ?? true
    }
    
    if (config?.packageJsonPath) {
      loadDependenciesFromPackageJson(config.packageJsonPath)
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
    console.error('读取依赖列表失败:', error)
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
      ElMessage.warning('请选择要执行的命令')
      return
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID，用于节点间引用
      type: 'command',
      commandId: formData.value.commandId,
      commandName: formData.value.commandName || '',
      useTerminal: formData.value.useTerminal || false,
      outputKey: formData.value.outputKey || undefined,
      inputs: formData.value.inputs || [],
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'wait') {
    if (!formData.value.waitSeconds || formData.value.waitSeconds <= 0) {
      ElMessage.warning('等待时间必须大于0秒')
      return
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID
      type: 'wait',
      waitSeconds: formData.value.waitSeconds,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'version') {
    if (formData.value.versionTarget === 'dependency') {
      if (!formData.value.dependencyName?.trim()) {
        ElMessage.warning('请选择依赖包名称')
        return
      }
      // 根据版本来源验证
      if (formData.value.versionSource === 'manual' && !formData.value.dependencyVersion?.trim()) {
        ElMessage.warning('请输入依赖包版本号')
        return
      }
      if (formData.value.versionSource === 'reference' && !formData.value.inputRef) {
        ElMessage.warning('请选择要引用的节点输出')
        return
      }
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      nodeId: props.node.id,  // 保存流程图节点 ID
      type: 'version',
      versionTarget: formData.value.versionTarget || 'version',
      versionBump: formData.value.versionSource === 'bump' ? (formData.value.versionBump || 'patch') : undefined,
      packageJsonPath: formData.value.packageJsonPath?.trim() || undefined,
      dependencyName: formData.value.versionTarget === 'dependency' ? formData.value.dependencyName?.trim() : undefined,
      dependencyVersion: formData.value.versionTarget === 'dependency' && formData.value.versionSource === 'manual' ? formData.value.dependencyVersion?.trim() : undefined,
      dependencyVersionBump: formData.value.versionTarget === 'dependency' && formData.value.versionSource === 'bump' ? formData.value.dependencyVersionBump : undefined,
      dependencyType: formData.value.versionTarget === 'dependency' ? formData.value.dependencyType : undefined,
      versionSource: formData.value.versionSource,
      inputRef: formData.value.versionSource === 'reference' ? formData.value.inputRef : undefined,
      enabled: formData.value.enabled ?? true
    }
  }
  
  if (config) {
    emit('update-config', props.node.id, config)
    ElMessage.success('节点配置已保存')
    visible.value = false
  }
}
</script>

<template>
  <CommonDialog
    v-model="visible"
    title="节点配置"
    size="extra-large"
    :append-to-body="true"
    custom-class="node-config-dialog"
  >
    <div v-if="node" class="config-content">
      <!-- 通用配置 -->
      <div class="config-section">
        <div class="section-title">通用设置</div>
        <el-form label-width="100px">
          <el-form-item label="启用节点">
            <el-switch v-model="formData.enabled" />
          </el-form-item>
          
          <!-- 命令节点的执行方式 -->
          <el-form-item v-if="node.type === 'command'" label="执行方式">
            <el-radio-group v-model="formData.useTerminal">
              <el-radio :value="false">普通执行</el-radio>
              <el-radio :value="true">终端执行</el-radio>
            </el-radio-group>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 命令输入参数配置（独立版块） -->
      <div v-if="node.type === 'command' && formData.commandId && formData.inputs" class="config-section">
        <div class="section-title">
          <el-icon><Link /></el-icon>
          输入配置
        </div>
        <NodeInputConfig
          v-model="formData.inputs"
          :param-names="currentCommandVariables"
          :disable-param-name-edit="true"
          :predecessor-nodes="predecessorNodes"
        />
      </div>
      
      <!-- 命令节点配置 -->
      <div v-if="node.type === 'command'" class="config-section">
        <div class="section-title">
          <el-icon><svg-icon icon-class="custom-cmd" /></el-icon>
          命令配置
        </div>
        
        <el-form label-width="100px">
          <el-form-item label="选择命令" required>
            <div v-if="availableCommands.length === 0" class="empty-tip">
              暂无可用命令，请先创建命令
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
                    <span>{{ command.directory ? command.directory.replace(/\\/g, '/') : '当前目录' }}</span>
                  </div>
                </div>
                <el-icon v-if="formData.commandId === command.id" class="check-icon">
                  <Select />
                </el-icon>
              </div>
            </div>
          </el-form-item>
          
          <el-form-item label="输出键名">
            <el-input 
              v-model="formData.outputKey" 
              placeholder="可选，用于其他节点引用此命令的输出"
              clearable
            />
            <div class="form-tip">
              <el-icon><Link /></el-icon>
              设置后，其他节点可以引用此命令的输出结果
            </div>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 等待节点配置 -->
      <div v-if="node.type === 'wait'" class="config-section">
        <div class="section-title">
          <el-icon><Clock /></el-icon>
          等待配置
        </div>
        
        <el-form label-width="100px">
          <el-form-item label="等待时间" required>
            <el-input-number 
              v-model="formData.waitSeconds" 
              :min="1" 
              :max="3600" 
              :step="1"
            />
            <span style="margin-left: var(--spacing-md);">秒</span>
          </el-form-item>
        </el-form>
      </div>
      
      <!-- 版本节点配置 -->
      <div v-if="node.type === 'version'" class="config-section">
        <div class="section-title">
          <el-icon><DocumentAdd /></el-icon>
          版本配置
        </div>
        
        <el-form label-width="120px">
          <el-form-item label="package.json">
            <PackageJsonSelector
              v-model="formData.packageJsonPath!"
              placeholder="留空则使用当前目录的 package.json"
              clearable
              @change="handlePackageFileChange"
            />
          </el-form-item>
          
          <el-form-item label="修改目标" required>
            <el-radio-group v-model="formData.versionTarget">
              <el-radio value="version">version 字段</el-radio>
              <el-radio value="dependency">dependencies 中的依赖</el-radio>
            </el-radio-group>
          </el-form-item>
          
          <!-- version 字段配置 -->
          <template v-if="formData.versionTarget === 'version'">
            <el-form-item label="版本增量类型" required>
              <el-radio-group v-model="formData.versionBump">
                <el-radio value="patch">补丁版本 (x.x.+1)</el-radio>
                <el-radio value="minor">次版本 (x.+1.0)</el-radio>
                <el-radio value="major">主版本 (+1.0.0)</el-radio>
              </el-radio-group>
            </el-form-item>
          </template>
          
          <!-- dependency 配置 -->
          <template v-if="formData.versionTarget === 'dependency'">
            <el-form-item label="依赖类型" required>
              <el-radio-group v-model="formData.dependencyType">
                <el-radio value="dependencies">dependencies</el-radio>
                <el-radio value="devDependencies">devDependencies</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item label="依赖包名称" required>
              <el-select 
                v-model="formData.dependencyName" 
                placeholder="请先选择 package.json"
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
            
            <el-form-item label="版本号来源" required>
              <el-radio-group v-model="formData.versionSource">
                <el-radio value="bump">自动递增</el-radio>
                <el-radio value="manual">手动输入</el-radio>
                <el-radio value="reference" :disabled="predecessorNodes.length === 0">
                  引用输出
                  <el-tooltip v-if="predecessorNodes.length === 0" content="无可用的前置命令节点" placement="top">
                    <el-icon style="margin-left: 4px;"><Link /></el-icon>
                  </el-tooltip>
                </el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.versionSource === 'bump'" label="递增类型" required>
              <el-radio-group v-model="formData.dependencyVersionBump">
                <el-radio value="patch">补丁版本</el-radio>
                <el-radio value="minor">次版本</el-radio>
                <el-radio value="major">主版本</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.versionSource === 'manual'" label="版本号" required>
              <el-input 
                v-model="formData.dependencyVersion" 
                placeholder="例如: 1.2.3"
              />
            </el-form-item>
            
            <!-- 引用输出配置 -->
            <template v-if="formData.versionSource === 'reference'">
              <el-form-item label="引用节点" required>
                <el-select 
                  v-model="formData.inputRef"
                  value-key="nodeId"
                  placeholder="选择要引用的前置节点"
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
                      <span class="node-id">ID: {{ predNode.id.substring(0, 15) }}...</span>
                    </div>
                  </el-option>
                </el-select>
              </el-form-item>
              
              <el-form-item v-if="formData.inputRef" label="输出字段" required>
                <el-select 
                  v-model="formData.inputRef.outputKey"
                  placeholder="选择要引用的输出字段"
                  style="width: 100%"
                >
                  <el-option
                    v-for="opt in getNodeOutputOptions(predecessorNodes.find(n => n.id === formData.inputRef?.nodeId)!)"
                    :key="opt.key"
                    :label="opt.label"
                    :value="opt.key"
                  />
                </el-select>
              </el-form-item>
              
              <div class="reference-tip">
                <el-icon><Link /></el-icon>
                <span>版本号将使用所选节点的输出结果</span>
              </div>
            </template>
          </template>
        </el-form>
      </div>
    </div>
    
    <template #footer>
      <div class="dialog-footer">
        <div class="footer-actions">
          <button type="button" class="dialog-cancel-btn" @click="visible = false">
            取消
          </button>
          <button type="button" class="dialog-confirm-btn" @click="saveConfig">
            <el-icon><Select /></el-icon>
            <span>保存配置</span>
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
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-md);
  max-height: 350px;
  overflow-y: auto;
  padding-right: var(--spacing-sm);
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
</style>
