<script setup lang="ts">
import { ref, computed, watch, shallowRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, VideoPlay, Clock, DocumentAdd, Plus, Folder } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'
import PackageJsonSelector from '@components/PackageJsonSelector.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import type { CustomCommand } from '@components/CustomCommandManager.vue'
import type { PackageFile } from '@components/PackageJsonSelector.vue'

export interface OrchestrationWorkspaceEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-orchestration', steps: OrchestrationStep[], startIndex?: number, isSingleExecution?: boolean): void
}

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<OrchestrationWorkspaceEmits>()

const configStore = useConfigStore()

// 显示/隐藏弹窗
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// 获取已保存的编排列表
const orchestrations = computed(() => configStore.orchestrations || [])

// 当前选中的编排ID（用于高亮）
const selectedOrchestrationId = ref<string | null>(null)

// 编排步骤列表
const orchestrationSteps = ref<OrchestrationStep[]>([])
// 正在拖拽的步骤索引
const draggedIndex = ref<number | null>(null)
// 编排名称和描述
const orchestrationName = ref('')
const orchestrationDescription = ref('')
// 当前编辑的编排ID（如果是编辑模式）
const editingOrchestrationId = ref<string | null>(null)
// 添加指令的弹窗
const showAddStepDialog = ref(false)
// 等待秒数输入
const waitSeconds = ref(5)
// 版本管理相关
const versionTarget = ref<'version' | 'dependency'>('version')  // 修改目标
const versionBump = ref<'patch' | 'minor' | 'major'>('patch')
const packageJsonPath = ref('')
const selectedPackageFile = ref<PackageFile | null>(null)
const dependencyName = ref('')  // 依赖包名称
const dependencyVersion = ref('')  // 依赖包版本
const dependencyType = ref<'dependencies' | 'devDependencies'>('dependencies')  // 依赖类型
const dependencyVersionMode = ref<'bump' | 'manual'>('bump')  // 版本号模式：bump=自动递增，manual=手动输入
const dependencyVersionBump = ref<'patch' | 'minor' | 'major'>('patch')  // 依赖版本递增类型
const availableDependencies = ref<string[]>([])  // 可选的依赖包列表

// 记录当前打开的 dropdown key（用于确保互斥）
const activeDropdownKey = ref<string | null>(null)

// 计算属性：获取所有可用的自定义命令
const availableCommands = computed(() => configStore.customCommands || [])

// 获取步骤的唯一标识
function getStepKey(orchestrationId: string, stepIndex: number): string {
  return `${orchestrationId}-${stepIndex}`
}

// 检查 dropdown 是否应该显示
function isDropdownActive(orchestrationId: string, stepIndex: number): boolean {
  return activeDropdownKey.value === getStepKey(orchestrationId, stepIndex)
}

// 打开指定的 dropdown（会自动关闭其他的）
function openDropdown(orchestrationId: string, stepIndex: number) {
  activeDropdownKey.value = getStepKey(orchestrationId, stepIndex)
}

// 关闭 dropdown
function closeDropdown(orchestrationId: string, stepIndex: number) {
  const key = getStepKey(orchestrationId, stepIndex)
  if (activeDropdownKey.value === key) {
    activeDropdownKey.value = null
  }
}

// 获取步骤显示文本
function getStepLabel(step: OrchestrationStep): string {
  const disabledPrefix = step.enabled === false ? '[已禁用] ' : ''
  const terminalPrefix = step.useTerminal ? '[终端] ' : ''
  if (step.type === 'command') {
    return disabledPrefix + terminalPrefix + (step.commandName || '未知命令')
  } else if (step.type === 'wait') {
    return disabledPrefix + `等待 ${step.waitSeconds} 秒`
  } else if (step.type === 'version') {
    if (step.versionTarget === 'dependency') {
      const depType = step.dependencyType === 'devDependencies' ? 'devDep' : 'dep'
      if (step.dependencyVersionBump) {
        // 自动递增模式
        const bumpText = step.dependencyVersionBump === 'major' ? '主版本' : step.dependencyVersionBump === 'minor' ? '次版本' : '补丁版本'
        return disabledPrefix + `修改依赖 [${depType}] ${step.dependencyName} 版本+1 (${bumpText})`
      } else {
        // 手动输入模式
        return disabledPrefix + `修改依赖 [${depType}] ${step.dependencyName} → ${step.dependencyVersion}`
      }
    } else {
      const bumpText = step.versionBump === 'major' ? '主版本' : step.versionBump === 'minor' ? '次版本' : '补丁版本'
      return disabledPrefix + `版本号+1 (${bumpText})`
    }
  }
  return '未知步骤'
}

// 自定义命令图标组件
const CustomCmdIcon = shallowRef({
  template: '<svg-icon icon-class="custom-cmd" />',
  components: { SvgIcon }
})

// 获取步骤类型图标
function getStepIcon(step: OrchestrationStep) {
  if (step.type === 'command') return CustomCmdIcon.value
  if (step.type === 'wait') return Clock
  if (step.type === 'version') return DocumentAdd
  return CustomCmdIcon.value
}

// 获取步骤详细信息
function getStepDetail(step: OrchestrationStep): string {
  if (step.type === 'command') {
    const cmd = configStore.customCommands.find(c => c.id === step.commandId)
    return cmd?.command || '命令已删除'
  } else if (step.type === 'wait') {
    return `暂停执行 ${step.waitSeconds} 秒`
  } else if (step.type === 'version') {
    if (step.packageJsonPath) {
      return step.packageJsonPath.replace(/\\/g, '/')
    }
    return '当前目录的 package.json'
  }
  return ''
}

// 获取步骤的执行目录
function getStepDirectory(step: OrchestrationStep): string {
  if (step.type === 'command') {
    const cmd = configStore.customCommands.find(c => c.id === step.commandId)
    return cmd?.directory || ''
  }
  return ''
}

// 生成唯一ID
function generateId() {
  return `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// 创建新编排
function createNewOrchestration() {
  selectedOrchestrationId.value = null
  editingOrchestrationId.value = null
  orchestrationName.value = ''
  orchestrationDescription.value = ''
  orchestrationSteps.value = []
}

// 加载编排到编辑器
function loadOrchestration(orchestration: any) {
  selectedOrchestrationId.value = orchestration.id
  editingOrchestrationId.value = orchestration.id
  orchestrationName.value = orchestration.name
  orchestrationDescription.value = orchestration.description || ''
  
  // 深拷贝并确保每个步骤都有 enabled 字段
  const steps = JSON.parse(JSON.stringify(orchestration.steps)) as OrchestrationStep[]
  steps.forEach((step) => {
    if (step.enabled === undefined || step.enabled === null) {
      step.enabled = true
    }
    if (step.useTerminal === undefined) {
      step.useTerminal = false
    }
  })
  orchestrationSteps.value = steps
}

// 执行编排
function executeOrchestration(orchestration: any, startIndex: number = 0) {
  emit('execute-orchestration', orchestration.steps, startIndex)
  // 不关闭弹窗，让用户可以继续查看或修改编排
}

// 从指定步骤开始执行
function executeFromStep(orchestration: any, stepIndex: number) {
  executeOrchestration(orchestration, stepIndex)
}

// 删除编排
async function deleteOrchestration(orchestration: any) {
  try {
    await ElMessageBox.confirm(
      `确定要删除编排 "${orchestration.name}" 吗？`,
      '确认删除',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    )
    
    await configStore.deleteOrchestration(orchestration.id)
    ElMessage.success('编排已删除')
    
    // 如果删除的是当前编辑的编排，清空编辑器
    if (editingOrchestrationId.value === orchestration.id) {
      createNewOrchestration()
    }
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(`删除编排失败: ${error.message || error}`)
    }
  }
}

// 添加自定义命令步骤
function addCommandStep(command: CustomCommand) {
  const step: OrchestrationStep = {
    id: generateId(),
    type: 'command',
    commandId: command.id,
    commandName: command.name,
    enabled: true
  }
  orchestrationSteps.value.push(step)
  ElMessage.success(`已添加命令: ${command.name}`)
  showAddStepDialog.value = false
}

// 添加等待步骤
function addWaitStep() {
  if (waitSeconds.value <= 0) {
    ElMessage.warning('等待时间必须大于0秒')
    return
  }
  const step: OrchestrationStep = {
    id: generateId(),
    type: 'wait',
    waitSeconds: waitSeconds.value,
    enabled: true
  }
  orchestrationSteps.value.push(step)
  ElMessage.success(`已添加等待步骤: ${waitSeconds.value}秒`)
  showAddStepDialog.value = false
}

// 处理package.json文件选择变化
function handlePackageFileChange(packageFile: PackageFile | null) {
  selectedPackageFile.value = packageFile
  if (packageFile) {
    packageJsonPath.value = packageFile.fullPath
    loadDependenciesFromPackageJson(packageFile.fullPath)
  } else {
    availableDependencies.value = []
  }
}

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
      if (dependencyType.value === 'dependencies' && result.dependencies) {
        deps.push(...Object.keys(result.dependencies))
      } else if (dependencyType.value === 'devDependencies' && result.devDependencies) {
        deps.push(...Object.keys(result.devDependencies))
      }
      availableDependencies.value = deps.sort()
    }
  } catch (error) {
    console.error('读取依赖列表失败:', error)
    availableDependencies.value = []
  }
}

// 监听依赖类型变化，重新加载依赖列表
watch(dependencyType, () => {
  if (packageJsonPath.value) {
    loadDependenciesFromPackageJson(packageJsonPath.value)
  }
})

// 添加版本管理步骤
function addVersionStep() {
  // 验证：如果选择修改依赖
  if (versionTarget.value === 'dependency') {
    if (!dependencyName.value.trim()) {
      ElMessage.warning('请选择依赖包名称')
      return
    }
    // 如果是手动输入模式，需要验证版本号
    if (dependencyVersionMode.value === 'manual' && !dependencyVersion.value.trim()) {
      ElMessage.warning('请输入依赖包版本号')
      return
    }
  }
  
  const step: OrchestrationStep = {
    id: generateId(),
    type: 'version',
    versionTarget: versionTarget.value,
    versionBump: versionBump.value,
    packageJsonPath: packageJsonPath.value.trim() || undefined,
    dependencyName: versionTarget.value === 'dependency' ? dependencyName.value.trim() : undefined,
    dependencyVersion: versionTarget.value === 'dependency' && dependencyVersionMode.value === 'manual' ? dependencyVersion.value.trim() : undefined,
    dependencyVersionBump: versionTarget.value === 'dependency' && dependencyVersionMode.value === 'bump' ? dependencyVersionBump.value : undefined,
    dependencyType: versionTarget.value === 'dependency' ? dependencyType.value : undefined,
    enabled: true
  }
  orchestrationSteps.value.push(step)
  ElMessage.success(`已添加版本管理步骤`)
  showAddStepDialog.value = false
  // 重置表单
  versionTarget.value = 'version'
  versionBump.value = 'patch'
  packageJsonPath.value = ''
  selectedPackageFile.value = null
  dependencyName.value = ''
  dependencyVersion.value = ''
  dependencyType.value = 'dependencies'
  dependencyVersionMode.value = 'bump'
  dependencyVersionBump.value = 'patch'
  availableDependencies.value = []
}

// 从编排列表移除步骤
function removeStep(index: number) {
  orchestrationSteps.value.splice(index, 1)
}

// 清空编排列表
function clearSteps() {
  orchestrationSteps.value = []
}

// 保存编排
async function saveOrchestration() {
  if (!orchestrationName.value.trim()) {
    ElMessage.warning('请输入编排名称')
    return
  }
  if (orchestrationSteps.value.length === 0) {
    ElMessage.warning('请至少添加一个步骤')
    return
  }
  
  const orchestration = {
    name: orchestrationName.value.trim(),
    description: orchestrationDescription.value.trim(),
    steps: orchestrationSteps.value
  }
  
  if (editingOrchestrationId.value) {
    // 更新现有编排
    await configStore.updateOrchestration(editingOrchestrationId.value, orchestration)
    ElMessage.success('编排已更新')
  } else {
    // 保存新编排
    const newOrch = await configStore.saveOrchestration(orchestration) as any
    ElMessage.success('编排已保存')
    // 保存后自动选中新编排
    if (newOrch && typeof newOrch === 'object' && 'id' in newOrch) {
      selectedOrchestrationId.value = newOrch.id
      editingOrchestrationId.value = newOrch.id
    }
  }
}

// 直接执行当前编排
function executeCurrentOrchestration() {
  if (orchestrationSteps.value.length === 0) {
    ElMessage.warning('请至少添加一个步骤')
    return
  }
  emit('execute-orchestration', [...orchestrationSteps.value])
  // 不关闭弹窗，让用户可以继续查看或修改编排
}

// 拖拽开始
function onDragStart(index: number) {
  draggedIndex.value = index
}

// 拖拽结束
function onDragEnd() {
  draggedIndex.value = null
}

// 拖拽经过
function onDragOver(event: DragEvent) {
  event.preventDefault()
}

// 放置
function onDrop(targetIndex: number) {
  if (draggedIndex.value === null || draggedIndex.value === targetIndex) {
    return
  }
  
  const draggedStep = orchestrationSteps.value[draggedIndex.value]
  orchestrationSteps.value.splice(draggedIndex.value, 1)
  
  const insertIndex = draggedIndex.value < targetIndex ? targetIndex - 1 : targetIndex
  orchestrationSteps.value.splice(insertIndex, 0, draggedStep)
  
  draggedIndex.value = null
}

// 步骤上移
function moveUp(index: number) {
  if (index === 0) return
  const temp = orchestrationSteps.value[index]
  orchestrationSteps.value[index] = orchestrationSteps.value[index - 1]
  orchestrationSteps.value[index - 1] = temp
}

// 步骤下移
function moveDown(index: number) {
  if (index === orchestrationSteps.value.length - 1) return
  const temp = orchestrationSteps.value[index]
  orchestrationSteps.value[index] = orchestrationSteps.value[index + 1]
  orchestrationSteps.value[index + 1] = temp
}

// 执行单个步骤
function executeSingleStep(step: OrchestrationStep) {
  emit('execute-orchestration', [step], 0, true)  // 第三个参数true表示单个执行
  // 不关闭弹窗，让用户可以继续查看或修改编排
}

// 更新步骤启用状态
function updateStepEnabled(step: OrchestrationStep, value: boolean) {
  step.enabled = value
}
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    title="编排工作台"
    :close-on-click-modal="false"
    :append-to-body="true"
    custom-class="orchestration-workspace-dialog"
    width="1400px"
  >
    <div class="workspace-container">
      <!-- 左侧：编排列表 -->
      <div class="left-panel">
        <div class="panel-header">
          <h3>已保存的编排</h3>
          <el-button 
            type="primary" 
            size="small"
            :icon="Plus"
            @click="createNewOrchestration"
          >
            新建
          </el-button>
        </div>
        
        <div class="orchestration-list">
          <el-empty 
            v-if="orchestrations.length === 0" 
            description="暂无编排" 
            :image-size="100"
          />
          
          <div
            v-for="orchestration in orchestrations"
            :key="orchestration.id"
            class="orchestration-item"
            :class="{ 'active': selectedOrchestrationId === orchestration.id }"
            @click="loadOrchestration(orchestration)"
          >
            <div class="item-content">
              <div class="item-header">
                <h4>{{ orchestration.name }}</h4>
                <div class="item-actions">
                  <el-button 
                    type="primary" 
                    :icon="VideoPlay"
                    size="small"
                    circle
                    title="执行"
                    @click.stop="executeOrchestration(orchestration)"
                  />
                  <el-button 
                    type="danger" 
                    :icon="Delete"
                    size="small"
                    circle
                    title="删除"
                    @click.stop="deleteOrchestration(orchestration)"
                  />
                </div>
              </div>
              <div class="step-preview">
                <el-dropdown
                  v-for="(step, index) in orchestration.steps"
                  :key="step.id"
                  trigger="contextmenu"
                  :hide-on-click="true"
                  @command="() => { executeFromStep(orchestration, index); closeDropdown(orchestration.id, index) }"
                  @visible-change="(visible: boolean) => visible ? openDropdown(orchestration.id, index) : closeDropdown(orchestration.id, index)"
                >
                  <el-tag
                    :type="step.type === 'command' ? 'primary' : step.type === 'wait' ? 'warning' : 'success'"
                    size="small"
                    class="step-tag"
                  >
                    <!-- <el-icon :component="getStepIcon(step)" /> -->
                    <span>{{ index + 1 }}. {{ getStepLabel(step) }}</span>
                  </el-tag>
                  <template #dropdown>
                    <el-dropdown-menu v-if="isDropdownActive(orchestration.id, index)">
                      <el-dropdown-item command="execute">
                        <el-icon><VideoPlay /></el-icon>
                        从此处开始执行
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <!-- 右侧：编排编辑器 -->
      <div class="right-panel">
        <div class="panel-header">
          <h3>{{ editingOrchestrationId ? '编辑编排' : '新建编排' }}</h3>
          <div class="header-actions">
            <el-button 
              type="success" 
              size="small"
              :icon="DocumentAdd"
              :disabled="orchestrationSteps.length === 0"
              @click="saveOrchestration"
            >
              保存
            </el-button>
            <el-button 
              type="primary" 
              size="small"
              :icon="VideoPlay"
              :disabled="orchestrationSteps.length === 0"
              @click="executeCurrentOrchestration"
            >
              执行
            </el-button>
          </div>
        </div>
        
        <!-- 编排信息 -->
        <div class="orchestration-info">
          <el-input
            v-model="orchestrationName"
            placeholder="编排名称（必填）"
            size="default"
            clearable
          />
          <el-input
            v-model="orchestrationDescription"
            placeholder="编排描述（选填）"
            type="textarea"
            :rows="2"
            clearable
          />
        </div>
        
        <!-- 步骤列表 -->
        <div class="steps-section">
          <div class="steps-header">
            <h4>
              <el-icon><VideoPlay /></el-icon>
              执行步骤
              <span class="step-count">({{ orchestrationSteps.length }})</span>
            </h4>
            <div class="header-actions">
              <el-button 
                type="primary"
                size="small"
                :icon="Plus"
                @click="showAddStepDialog = true"
              >
                添加步骤
              </el-button>
              <el-button 
                v-if="orchestrationSteps.length > 0"
                type="danger" 
                size="small" 
                text
                @click="clearSteps"
              >
                清空
              </el-button>
            </div>
          </div>
          
          <div class="steps-scroll">
            <el-empty 
              v-if="orchestrationSteps.length === 0" 
              description="请添加执行步骤" 
              :image-size="80"
            />
            <div v-else class="step-list">
              <div
                v-for="(step, index) in orchestrationSteps"
                :key="step.id"
                class="step-item"
                :class="`step-type-${step.type}`"
                draggable="true"
                @dragstart="onDragStart(index)"
                @dragend="onDragEnd"
                @dragover="onDragOver"
                @drop="onDrop(index)"
              >
                <div class="order-number">{{ index + 1 }}</div>
                <div class="step-icon">
                  <el-icon v-if="step.type === 'command'"><svg-icon icon-class="custom-cmd" /></el-icon>
                  <el-icon v-else-if="step.type === 'wait'"><Clock /></el-icon>
                  <el-icon v-else-if="step.type === 'version'"><DocumentAdd /></el-icon>
                </div>
                <div class="step-info">
                  <div class="step-name">{{ getStepLabel(step) }}</div>
                  <div class="step-detail">{{ getStepDetail(step) }}</div>
                  <div v-if="getStepDirectory(step)" class="step-dir">
                    <el-icon><Folder /></el-icon>
                    <span>{{ getStepDirectory(step) }}</span>
                  </div>
                </div>
                <div class="step-options">
                  <div class="option-item">
                    <span class="option-label">启用</span>
                    <el-switch 
                      :model-value="step.enabled ?? true"
                      @update:model-value="(val: boolean) => updateStepEnabled(step, val)"
                      size="small"
                    />
                  </div>
                  <el-checkbox 
                    v-if="step.type === 'command'"
                    v-model="step.useTerminal" 
                    label="终端执行"
                    size="small"
                  />
                </div>
                <div class="action-buttons">
                  <el-button 
                    type="success" 
                    size="small" 
                    :icon="VideoPlay"
                    text
                    @click="executeSingleStep(step)"
                  >
                    执行
                  </el-button>
                  <el-button 
                    type="info" 
                    size="small" 
                    text
                    :disabled="index === 0"
                    @click="moveUp(index)"
                  >
                    ↑
                  </el-button>
                  <el-button 
                    type="info" 
                    size="small" 
                    text
                    :disabled="index === orchestrationSteps.length - 1"
                    @click="moveDown(index)"
                  >
                    ↓
                  </el-button>
                  <el-button 
                    type="danger" 
                    size="small" 
                    :icon="Delete"
                    text
                    @click="removeStep(index)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </CommonDialog>
  
  <!-- 添加步骤对话框 -->
  <CommonDialog
    v-model="showAddStepDialog"
    title="添加步骤"
    width="600px"
    :append-to-body="true"
    custom-class="add-step-dialog"
  >
    <el-tabs class="fixed-tab-dialog">
      <!-- 自定义命令 -->
      <el-tab-pane label="自定义命令">
        <template #label>
          <span><el-icon><svg-icon icon-class="custom-cmd" /></el-icon> 自定义命令</span>
        </template>
        <el-empty 
          v-if="availableCommands.length === 0" 
          description="暂无可用命令，请先创建命令" 
          :image-size="80"
        />
        <div v-else class="add-step-list">
          <div
            v-for="command in availableCommands"
            :key="command.id"
            class="add-step-item"
            @click="addCommandStep(command)"
          >
            <div class="step-info">
              <div class="step-name">{{ command.name }}</div>
              <div v-if="command.description" class="step-desc">{{ command.description }}</div>
              <code class="step-code">{{ command.command }}</code>
              <div v-if="command.directory" class="step-directory">
                <el-icon><Folder /></el-icon>
                <span>{{ command.directory }}</span>
              </div>
            </div>
            <el-button type="primary" size="small" text>添加</el-button>
          </div>
        </div>
      </el-tab-pane>
      
      <!-- 等待步骤 -->
      <el-tab-pane label="等待">
        <template #label>
          <span><el-icon><Clock /></el-icon> 等待</span>
        </template>
        <div class="wait-step-form">
          <el-input-number v-model="waitSeconds" :min="1" :max="3600" :step="1" />
          <span>秒</span>
          <el-button type="primary" @click="addWaitStep">添加等待步骤</el-button>
        </div>
      </el-tab-pane>
      
      <!-- 版本管理 -->
      <el-tab-pane label="版本管理">
        <template #label>
          <span><el-icon><DocumentAdd /></el-icon> 版本管理</span>
        </template>
        <div class="version-step-form">
          <!-- package.json 文件选择器（移到最上边） -->
          <div class="form-item">
            <label>package.json 文件（选填）：</label>
            <PackageJsonSelector
              v-model="packageJsonPath"
              placeholder="留空则使用当前目录的 package.json"
              clearable
              @change="handlePackageFileChange"
            />
          </div>
          
          <!-- 修改目标选择 -->
          <div class="form-item">
            <label>修改目标：</label>
            <el-radio-group v-model="versionTarget">
              <el-radio value="version">version 字段</el-radio>
              <el-radio value="dependency">dependencies 中的依赖</el-radio>
            </el-radio-group>
          </div>
          
          <!-- 根据选择显示不同的选项 -->
          <div v-if="versionTarget === 'version'" class="form-item">
            <label>版本增量类型：</label>
            <el-radio-group v-model="versionBump">
              <el-radio value="patch">补丁版本 (x.x.+1)</el-radio>
              <el-radio value="minor">次版本 (x.+1.0)</el-radio>
              <el-radio value="major">主版本 (+1.0.0)</el-radio>
            </el-radio-group>
          </div>
          
          <!-- 修改依赖的选项 -->
          <template v-else-if="versionTarget === 'dependency'">
            <div class="form-item">
              <label>依赖类型：</label>
              <el-radio-group v-model="dependencyType">
                <el-radio value="dependencies">dependencies</el-radio>
                <el-radio value="devDependencies">devDependencies</el-radio>
              </el-radio-group>
            </div>
            
            <div class="form-item">
              <label>依赖包名称：</label>
              <el-select 
                v-model="dependencyName" 
                placeholder="请先选择 package.json，然后选择依赖包"
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
            </div>
            
            <div class="form-item">
              <label>版本号模式：</label>
              <el-radio-group v-model="dependencyVersionMode">
                <el-radio value="bump">自动递增 +1</el-radio>
                <el-radio value="manual">手动输入</el-radio>
              </el-radio-group>
            </div>
            
            <!-- 自动递增模式 -->
            <div v-if="dependencyVersionMode === 'bump'" class="form-item">
              <label>版本增量类型：</label>
              <el-radio-group v-model="dependencyVersionBump">
                <el-radio value="patch">补丁版本 (x.x.+1)</el-radio>
                <el-radio value="minor">次版本 (x.+1.0)</el-radio>
                <el-radio value="major">主版本 (+1.0.0)</el-radio>
              </el-radio-group>
            </div>
            
            <!-- 手动输入模式 -->
            <div v-else-if="dependencyVersionMode === 'manual'" class="form-item">
              <label>新版本号：</label>
              <el-input 
                v-model="dependencyVersion" 
                placeholder="例如：^3.5.0、~2.8.0、latest" 
                clearable
              />
            </div>
          </template>
          
          <el-button type="primary" @click="addVersionStep">添加版本管理步骤</el-button>
          
          <el-alert 
            v-if="versionTarget === 'version'"
            title="将会修改 package.json 中的 version 字段，并自动递增版本号"
            type="info"
            :closable="false"
            style="margin-top: 16px"
          />
          <el-alert 
            v-else-if="versionTarget === 'dependency'"
            title="将会修改 package.json 中指定依赖的版本号"
            type="info"
            :closable="false"
            style="margin-top: 16px"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </CommonDialog>
</template>

<style scoped lang="scss">
.workspace-container {
  display: flex;
  gap: 16px;
  height: 70vh;
  min-height: 600px;
}

// 左侧面板
.left-panel {
  width: 380px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-component);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}

// 右侧面板
.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-component);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
  min-width: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, var(--bg-container), var(--bg-panel));
  border-bottom: 1px solid var(--border-component);
  flex-shrink: 0;
  
  h3, h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-title);
    display: flex;
    align-items: center;
    gap: 8px;

    .el-icon {
      font-size: 16px;
      color: #409eff;
    }
  }
}

.header-actions {
  display: flex;
  gap: 8px;
}

// 编排列表
.orchestration-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  
  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background-color: #c0c4cc;
    border-radius: 3px;
  }
}

.orchestration-item {
  margin-bottom: 8px;
  border: 1px solid var(--border-component);
  border-radius: 6px;
  background: var(--bg-container);
  cursor: pointer;
  transition: all 0.2s ease;
  
  &:hover {
    border-color: #409eff;
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
  }
  
  &.active {
    border-color: #409eff;
    background: rgba(64, 158, 255, 0.05);
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
  }
}

.item-content {
  padding: 12px;
}

.item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-title);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.item-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.step-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.step-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: context-menu;
  font-size: 12px;
  
  .el-icon {
    font-size: 12px;
  }
}

// 编排信息
.orchestration-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  flex-shrink: 0;
}

// 步骤区域
.steps-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  margin: 0 16px 16px 16px;
  border: 1px solid var(--border-component);
  border-radius: 8px;
  background: var(--bg-container);
  overflow: hidden;
  min-height: 0;
}

.steps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, var(--bg-panel), var(--bg-container));
  border-bottom: 1px solid var(--border-component);
  flex-shrink: 0;
  
  h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-title);
    display: flex;
    align-items: center;
    gap: 8px;

    .el-icon {
      font-size: 14px;
      color: #409eff;
    }
  }
}

.step-count {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: normal;
}

.steps-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  min-height: 0;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background-color: #c0c4cc;
    border-radius: 3px;
  }
}

.step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-component);
  border-radius: 6px;
  background: var(--bg-panel);
  transition: all 0.2s ease;
  cursor: move;

  &:hover {
    border-color: #67c23a;
    background: rgba(103, 194, 58, 0.05);
  }

  &.step-type-command {
    border-left: 3px solid #409eff;
  }

  &.step-type-wait {
    border-left: 3px solid #e6a23c;
  }

  &.step-type-version {
    border-left: 3px solid #67c23a;
  }
}

.order-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 600;
  color: white;
  background: linear-gradient(135deg, #409eff, #79bbff);
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(64, 158, 255, 0.3);
}

.step-icon {
  flex-shrink: 0;
  font-size: 20px;
  color: #409eff;
}

.step-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-title);
}

.step-detail {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  background: var(--bg-code);
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  word-break: break-all;
  max-width: 100%;
}

.step-dir {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #67c23a;
  margin-top: 6px;
  font-family: var(--font-mono);

  .el-icon {
    font-size: 12px;
  }
}

.step-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  margin-right: 12px;

  .option-item {
    display: flex;
    align-items: center;
    gap: 8px;

    .option-label {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
    }
  }
}

.action-buttons {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

// 添加步骤对话框样式
.add-step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}

.add-step-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border: 1px solid var(--border-component);
  border-radius: 6px;
  background: var(--bg-container);
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    border-color: #409eff;
    background: rgba(64, 158, 255, 0.05);
    transform: translateX(4px);
  }

  .step-desc {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 2px;
    font-style: italic;
  }

  .step-code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-code);
    padding: 2px 6px;
    border-radius: 3px;
    margin-top: 4px;
    display: inline-block;
  }

  .step-directory {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: #67c23a;
    margin-top: 4px;

    .el-icon {
      font-size: 12px;
    }

    span {
      font-family: var(--font-mono);
    }
  }
}

.wait-step-form {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px;

  span {
    font-size: 14px;
    color: var(--text-title);
  }
}

.version-step-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;

  .form-item {
    display: flex;
    flex-direction: column;
    gap: 8px;

    label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-title);
    }
  }
}

// 固定tab在顶部的样式
.fixed-tab-dialog {
  display: flex;
  flex-direction: column;
  overflow: hidden;

  :deep(.el-tabs__header) {
    flex-shrink: 0; // 防止tab栏被压缩
    margin-bottom: 0;
    position: sticky;
    top: 0;
    background: var(--bg-container);
    z-index: 10;
    padding-bottom: 8px;
  }

  :deep(.el-tabs__content) {
    flex: 1;
    overflow-y: auto;
    padding-top: 8px;
  }

  :deep(.el-tab-pane) {
    height: 100%;
  }
}
</style>
