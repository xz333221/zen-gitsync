<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, VideoPlay, Clock, Rank, DocumentAdd } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'

export interface OrchestrationManagerEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-orchestration', steps: OrchestrationStep[], startIndex?: number): void
  (e: 'edit-orchestration', orchestration: any): void
}

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<OrchestrationManagerEmits>()

const configStore = useConfigStore()

// 显示/隐藏弹窗
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// 获取已保存的编排列表
const orchestrations = computed(() => configStore.orchestrations || [])

// 记录当前打开的 dropdown key（用于确保互斥）
const activeDropdownKey = ref<string | null>(null)

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
    const bumpText = step.versionBump === 'major' ? '主版本' : step.versionBump === 'minor' ? '次版本' : '补丁版本'
    return disabledPrefix + `版本号+1 (${bumpText})`
  }
  return '未知步骤'
}

// 获取步骤类型图标
function getStepIcon(step: OrchestrationStep) {
  if (step.type === 'command') return Rank
  if (step.type === 'wait') return Clock
  if (step.type === 'version') return DocumentAdd
  return Rank
}

// 执行编排
function executeOrchestration(orchestration: any, startIndex: number = 0) {
  emit('execute-orchestration', orchestration.steps, startIndex)
  dialogVisible.value = false
}

// 从指定步骤开始执行
function executeFromStep(orchestration: any, stepIndex: number) {
  executeOrchestration(orchestration, stepIndex)
}

// 编辑编排
function editOrchestration(orchestration: any) {
  emit('edit-orchestration', orchestration)
  dialogVisible.value = false
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
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(`删除编排失败: ${error.message || error}`)
    }
  }
}
</script>

<template>
  <CommonDialog
    v-model="dialogVisible"
    title="编排管理"
    :close-on-click-modal="false"
    :append-to-body="true"
    custom-class="orchestration-manager-dialog"
    width="900px"
  >
    <div class="manager-container">
      <el-empty 
        v-if="orchestrations.length === 0" 
        description="暂无已保存的编排" 
        :image-size="150"
      >
        <el-button type="primary" @click="dialogVisible = false">
          创建编排
        </el-button>
      </el-empty>
      
      <div v-else class="orchestration-list">
        <div
          v-for="orchestration in orchestrations"
          :key="orchestration.id"
          class="orchestration-card"
        >
          <div class="card-content">
            <div class="content-left">
              <h3 class="orchestration-name">{{ orchestration.name }}</h3>
              <div class="step-tags">
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
                    <el-icon :component="getStepIcon(step)" />
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
            <div class="content-right">
              <el-button 
                type="primary" 
                :icon="VideoPlay"
                size="small"
                @click="executeOrchestration(orchestration)"
              >
                执行
              </el-button>
              <el-button 
                type="info" 
                :icon="Edit"
                size="small"
                text
                @click="editOrchestration(orchestration)"
              >
                编辑
              </el-button>
              <el-button 
                type="danger" 
                :icon="Delete"
                size="small"
                text
                @click="deleteOrchestration(orchestration)"
              >
                删除
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </CommonDialog>
</template>

<style scoped lang="scss">
.manager-container {
  min-height: 400px;
  max-height: 70vh;
  overflow-y: auto;
  padding: 4px;
}

.orchestration-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.orchestration-card {
  border: 1px solid var(--border-component);
  border-radius: 6px;
  background: var(--bg-container);
  overflow: hidden;
  transition: all 0.2s ease;
  
  &:hover {
    border-color: #409eff;
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
  }
}

.card-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  gap: 12px;
}

.content-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.orchestration-name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-title);
}

.content-right {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.step-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.step-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: context-menu;
  
  .el-icon {
    font-size: 13px;
  }
}
</style>
