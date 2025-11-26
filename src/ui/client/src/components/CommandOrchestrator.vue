<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Delete, Rank, VideoPlay, Clock, Plus, DocumentAdd, Folder } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'
import PackageJsonSelector from '@components/PackageJsonSelector.vue'
import type { CustomCommand } from '@components/CustomCommandManager.vue'
import type { PackageFile } from '@components/PackageJsonSelector.vue'

export interface CommandOrchestratorEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-orchestration', steps: OrchestrationStep[]): void
}

const props = defineProps<{
  visible: boolean
  editingOrchestration?: { id: string; name: string; description?: string; steps: OrchestrationStep[] }
}>()

const emit = defineEmits<CommandOrchestratorEmits>()

const configStore = useConfigStore()

// 编排步骤列表
const orchestrationSteps = ref<OrchestrationStep[]>([])
// 正在拖拽的步骤索引
const draggedIndex = ref<number | null>(null)
// 编排名称和描述
const orchestrationName = ref('')
const orchestrationDescription = ref('')
// 添加指令的弹窗
const showAddStepDialog = ref(false)
// 等待秒数输入
const waitSeconds = ref(5)
// 版本管理相关
const versionBump = ref<'patch' | 'minor' | 'major'>('patch')
const packageJsonPath = ref('')
const selectedPackageFile = ref<PackageFile | null>(null)

// 计算属性：获取所有可用的自定义命令
const availableCommands = computed(() => configStore.customCommands || [])

// 显示/隐藏弹窗
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// 加载编排数据的函数
function loadOrchestrationData(orchestration: any) {
  if (orchestration) {
    orchestrationName.value = orchestration.name
    orchestrationDescription.value = orchestration.description || ''
    // 深拷贝并确保每个步骤都有 enabled 字段（兼容旧数据）
    const steps = JSON.parse(JSON.stringify(orchestration.steps)) as OrchestrationStep[]
    steps.forEach((step) => {
      // 确保所有必要字段都有默认值
      if (step.enabled === undefined || step.enabled === null) {
        step.enabled = true; // 默认启用
      }
      if (step.useTerminal === undefined) {
        step.useTerminal = false; // 默认不使用终端
      }
    })
    orchestrationSteps.value = steps
  } else {
    // 清空表单
    orchestrationName.value = ''
    orchestrationDescription.value = ''
    orchestrationSteps.value = []
  }
}

// 监听 editingOrchestration 变化，加载编辑数据
watch(() => props.editingOrchestration, loadOrchestrationData, { immediate: true })

// 监听弹窗打开/关闭，重新加载原始数据
watch(() => props.visible, (isVisible) => {
  if (isVisible && props.editingOrchestration) {
    // 弹窗打开时，从原始数据重新加载（丢弃未保存的修改）
    loadOrchestrationData(props.editingOrchestration)
  }
})

// 生成唯一ID
function generateId() {
  return `step-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// 添加自定义命令步骤
function addCommandStep(command: CustomCommand) {
  const step: OrchestrationStep = {
    id: generateId(),
    type: 'command',
    commandId: command.id,
    commandName: command.name,
    enabled: true  // 默认启用
  }
  orchestrationSteps.value.push(step)
  ElMessage.success(`已添加命令: ${command.name}`)
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
    enabled: true  // 默认启用
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
  }
}

// 添加版本管理步骤
function addVersionStep() {
  const step: OrchestrationStep = {
    id: generateId(),
    type: 'version',
    versionBump: versionBump.value,
    packageJsonPath: packageJsonPath.value.trim() || undefined,
    enabled: true  // 默认启用
  }
  orchestrationSteps.value.push(step)
  ElMessage.success(`已添加版本管理步骤`)
  showAddStepDialog.value = false
  // 重置表单
  versionBump.value = 'patch'
  packageJsonPath.value = ''
  selectedPackageFile.value = null
}

// 获取步骤显示文本
function getStepLabel(step: OrchestrationStep): string {
  const terminalPrefix = step.useTerminal ? '[终端] ' : ''
  if (step.type === 'command') {
    return terminalPrefix + (step.commandName || '自定义命令')
  } else if (step.type === 'wait') {
    return `等待 ${step.waitSeconds} 秒`
  } else if (step.type === 'version') {
    const bumpText = step.versionBump === 'major' ? '主版本' : step.versionBump === 'minor' ? '次版本' : '补丁版本'
    return `版本号+1 (${bumpText})`
  }
  return '未知步骤'
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
      // 显示路径，将反斜杠转换为正斜杠
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

// 从编排列表移除步骤
function removeStep(index: number) {
  orchestrationSteps.value.splice(index, 1)
}

// 清空编排列表
function clearSteps() {
  orchestrationSteps.value = []
  orchestrationName.value = ''
  orchestrationDescription.value = ''
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
  
  if (props.editingOrchestration) {
    // 更新现有编排
    await configStore.updateOrchestration(props.editingOrchestration.id, orchestration)
  } else {
    // 保存新编排
    await configStore.saveOrchestration(orchestration)
  }
  
  // 清空表单并关闭
  clearSteps()
  dialogVisible.value = false
}

// 直接执行编排
function executeOrchestration() {
  if (orchestrationSteps.value.length === 0) {
    ElMessage.warning('请至少添加一个步骤')
    return
  }
  emit('execute-orchestration', [...orchestrationSteps.value])
  // 执行后清空列表
  clearSteps()
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
  
  // 如果拖拽到后面的位置，需要调整索引
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
  emit('execute-orchestration', [step])
}

// 更新步骤启用状态
function updateStepEnabled(step: OrchestrationStep, value: boolean) {
  step.enabled = value
}
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    :title="editingOrchestration ? '编辑编排' : $t('@CMD02:指令编排')"
    :close-on-click-modal="false"
    :append-to-body="true"
    custom-class="command-orchestrator-dialog"
    width="1200px"
  >
    <div class="orchestrator-container">
      <!-- 左侧：编排信息和步骤列表 -->
      <div class="orchestration-main">
        <!-- 编排名称和描述 -->
        <div class="orchestration-info">
          <el-input
            v-model="orchestrationName"
            placeholder="编排名称（必填）"
            size="large"
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
            <h3>
              <el-icon><VideoPlay /></el-icon>
              执行步骤
              <span class="step-count">({{ orchestrationSteps.length }})</span>
            </h3>
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
              :image-size="100"
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
                  <el-icon v-if="step.type === 'command'"><Rank /></el-icon>
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
    
    <!-- 底部按钮 -->
    <template #footer>
      <div class="dialog-footer">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button 
          type="success" 
          :icon="DocumentAdd"
          :disabled="orchestrationSteps.length === 0"
          @click="saveOrchestration"
        >
          保存编排
        </el-button>
        <el-button 
          type="primary" 
          :icon="VideoPlay"
          :disabled="orchestrationSteps.length === 0"
          @click="executeOrchestration"
        >
          直接执行
        </el-button>
      </div>
    </template>
  </CommonDialog>
  
  <!-- 添加步骤对话框 -->
  <CommonDialog
    v-model="showAddStepDialog"
    title="添加步骤"
    width="600px"
    :append-to-body="true"
  >
    <el-tabs>
      <!-- 自定义命令 -->
      <el-tab-pane label="自定义命令">
        <template #label>
          <span><el-icon><Rank /></el-icon> 自定义命令</span>
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
          <div class="form-item">
            <label>版本增量类型：</label>
            <el-radio-group v-model="versionBump">
              <el-radio value="patch">补丁版本 (x.x.+1)</el-radio>
              <el-radio value="minor">次版本 (x.+1.0)</el-radio>
              <el-radio value="major">主版本 (+1.0.0)</el-radio>
            </el-radio-group>
          </div>
          <div class="form-item">
            <label>package.json 文件（选填）：</label>
            <PackageJsonSelector
              v-model="packageJsonPath"
              placeholder="留空则使用当前目录的 package.json"
              clearable
              @change="handlePackageFileChange"
            />
          </div>
          <el-button type="primary" @click="addVersionStep">添加版本管理步骤</el-button>
          <el-alert 
            title="将会修改 package.json 中的 version 字段，并自动递增版本号"
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
.orchestrator-container {
  display: flex;
  flex-direction: column;
  min-height: 600px;
  max-height: 70vh;
  gap: 16px;
}

.orchestration-info {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--bg-panel);
  border-radius: 8px;
  border: 1px solid var(--border-component);
}

.orchestration-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.steps-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-component);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
  min-height: 0;
}

.steps-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, var(--bg-container), var(--bg-panel));
  border-bottom: 1px solid var(--border-component);
  
  h3 {
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

  &::-webkit-scrollbar-track {
    background-color: var(--bg-panel);
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
  background: var(--bg-container);
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

  &.step-type-system {
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

.action-buttons {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

/* dialog-footer 样式已移至 @/styles/common.scss */

// 添加步骤对话框样式
.add-step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 400px;
  overflow-y: auto;
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

.step-type-version {
  border-left: 3px solid #409eff;
}
</style>
