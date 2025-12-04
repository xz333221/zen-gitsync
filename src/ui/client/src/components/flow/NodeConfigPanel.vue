<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Clock, DocumentAdd } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import type { FlowNode } from './FlowOrchestrationWorkspace.vue'
import CommonDialog from '@components/CommonDialog.vue'
import PackageJsonSelector from '@components/PackageJsonSelector.vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import type { CustomCommand } from '@components/CustomCommandManager.vue'
import type { PackageFile } from '@components/PackageJsonSelector.vue'

const props = defineProps<{
  modelValue: boolean
  node: FlowNode | null
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
  
  // 通用
  enabled?: boolean
}>({})

// 可用的依赖列表
const availableDependencies = ref<string[]>([])

// 可用的自定义命令
const availableCommands = computed(() => configStore.customCommands || [])

// 监听节点变化，加载配置
watch(() => props.node, (node) => {
  if (!node) return
  
  const config = node.data.config
  
  if (node.type === 'command') {
    formData.value = {
      commandId: config?.commandId,
      commandName: config?.commandName,
      useTerminal: config?.useTerminal || false,
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'wait') {
    formData.value = {
      waitSeconds: config?.waitSeconds || 5,
      enabled: node.data.enabled ?? true
    }
  } else if (node.type === 'version') {
    formData.value = {
      versionTarget: config?.versionTarget || 'version',
      versionBump: config?.versionBump || 'patch',
      packageJsonPath: config?.packageJsonPath || '',
      dependencyName: config?.dependencyName || '',
      dependencyVersion: config?.dependencyVersion || '',
      dependencyType: config?.dependencyType || 'dependencies',
      dependencyVersionMode: config?.dependencyVersionBump ? 'bump' : 'manual',
      dependencyVersionBump: config?.dependencyVersionBump || 'patch',
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
      type: 'command',
      commandId: formData.value.commandId,
      commandName: formData.value.commandName || '',
      useTerminal: formData.value.useTerminal || false,
      enabled: formData.value.enabled ?? true
    }
  } else if (props.node.type === 'wait') {
    if (!formData.value.waitSeconds || formData.value.waitSeconds <= 0) {
      ElMessage.warning('等待时间必须大于0秒')
      return
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
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
      if (formData.value.dependencyVersionMode === 'manual' && !formData.value.dependencyVersion?.trim()) {
        ElMessage.warning('请输入依赖包版本号')
        return
      }
    }
    
    config = {
      id: props.node.data.config?.id || generateId(),
      type: 'version',
      versionTarget: formData.value.versionTarget || 'version',
      versionBump: formData.value.versionBump || 'patch',
      packageJsonPath: formData.value.packageJsonPath?.trim() || undefined,
      dependencyName: formData.value.versionTarget === 'dependency' ? formData.value.dependencyName?.trim() : undefined,
      dependencyVersion: formData.value.versionTarget === 'dependency' && formData.value.dependencyVersionMode === 'manual' ? formData.value.dependencyVersion?.trim() : undefined,
      dependencyVersionBump: formData.value.versionTarget === 'dependency' && formData.value.dependencyVersionMode === 'bump' ? formData.value.dependencyVersionBump : undefined,
      dependencyType: formData.value.versionTarget === 'dependency' ? formData.value.dependencyType : undefined,
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
    width="600px"
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
        </el-form>
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
                  <div class="command-name">{{ command.name }}</div>
                  <div v-if="command.description" class="command-desc">{{ command.description }}</div>
                  <code class="command-code">{{ command.command }}</code>
                </div>
                <el-icon v-if="formData.commandId === command.id" class="check-icon">
                  <svg-icon icon-class="custom-cmd" />
                </el-icon>
              </div>
            </div>
          </el-form-item>
          
          <el-form-item label="执行方式">
            <el-radio-group v-model="formData.useTerminal">
              <el-radio :value="false">普通执行</el-radio>
              <el-radio :value="true">终端执行</el-radio>
            </el-radio-group>
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
            
            <el-form-item label="版本号模式" required>
              <el-radio-group v-model="formData.dependencyVersionMode">
                <el-radio value="bump">自动递增</el-radio>
                <el-radio value="manual">手动输入</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.dependencyVersionMode === 'bump'" label="递增类型" required>
              <el-radio-group v-model="formData.dependencyVersionBump">
                <el-radio value="patch">补丁版本</el-radio>
                <el-radio value="minor">次版本</el-radio>
                <el-radio value="major">主版本</el-radio>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item v-if="formData.dependencyVersionMode === 'manual'" label="版本号" required>
              <el-input 
                v-model="formData.dependencyVersion" 
                placeholder="例如: 1.2.3"
              />
            </el-form-item>
          </template>
        </el-form>
      </div>
    </div>
    
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" @click="saveConfig">保存配置</el-button>
    </template>
  </CommonDialog>
</template>

<style scoped lang="scss">
.config-content {
  max-height: 60vh;
  overflow-y: auto;
}

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
  max-height: 300px;
  overflow-y: auto;
}

.command-item {
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-base);
  border-radius: var(--radius-md);
  border: 2px solid var(--border-component);
  cursor: pointer;
  transition: var(--transition-all);
  display: flex;
  justify-content: space-between;
  align-items: center;
  
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
    
    .command-name {
      font-weight: var(--font-weight-semibold);
      margin-bottom: var(--spacing-sm);
    }
    
    .command-desc {
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
      margin-bottom: var(--spacing-md);
    }
    
    .command-code {
      display: block;
      padding: var(--spacing-sm) var(--spacing-base);
      background: var(--bg-container);
      border-radius: var(--radius-base);
      font-size: var(--font-size-sm);
      color: var(--text-primary);
    }
  }
  
  .check-icon {
    color: var(--color-primary);
    font-size: 20px;
  }
}

.empty-tip {
  color: var(--text-tertiary);
  font-size: var(--font-size-base);
  padding: 20px;
  text-align: center;
}
</style>
