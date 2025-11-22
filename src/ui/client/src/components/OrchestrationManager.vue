<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, VideoPlay, Clock, Rank, Monitor } from '@element-plus/icons-vue'
import { useConfigStore, type OrchestrationStep } from '@stores/configStore'
import CommonDialog from '@components/CommonDialog.vue'

export interface OrchestrationManagerEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'execute-orchestration', steps: OrchestrationStep[]): void
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

// 获取步骤显示文本
function getStepLabel(step: OrchestrationStep): string {
  if (step.type === 'command') {
    return step.commandName || '未知命令'
  } else if (step.type === 'wait') {
    return `等待 ${step.waitSeconds} 秒`
  } else if (step.type === 'system') {
    return step.systemCommandName || step.systemCommand || '系统命令'
  }
  return '未知步骤'
}

// 获取步骤类型图标
function getStepIcon(step: OrchestrationStep) {
  if (step.type === 'command') return Rank
  if (step.type === 'wait') return Clock
  if (step.type === 'system') return Monitor
  return Rank
}

// 执行编排
function executeOrchestration(orchestration: any) {
  emit('execute-orchestration', orchestration.steps)
  dialogVisible.value = false
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
          <div class="card-header">
            <div class="header-info">
              <h3 class="orchestration-name">{{ orchestration.name }}</h3>
              <p v-if="orchestration.description" class="orchestration-desc">
                {{ orchestration.description }}
              </p>
            </div>
            <div class="header-actions">
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
          
          <div class="card-body">
            <div class="steps-preview">
              <div class="steps-label">
                包含 {{ orchestration.steps.length }} 个步骤：
              </div>
              <div class="step-tags">
                <el-tag
                  v-for="(step, index) in orchestration.steps"
                  :key="step.id"
                  :type="step.type === 'command' ? 'primary' : step.type === 'wait' ? 'warning' : 'success'"
                  size="small"
                  class="step-tag"
                >
                  <el-icon :component="getStepIcon(step)" />
                  <span>{{ index + 1 }}. {{ getStepLabel(step) }}</span>
                </el-tag>
              </div>
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
  padding: 8px;
}

.orchestration-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.orchestration-card {
  border: 1px solid var(--border-component);
  border-radius: 8px;
  background: var(--bg-container);
  overflow: hidden;
  transition: all 0.2s ease;
  
  &:hover {
    border-color: #409eff;
    box-shadow: 0 2px 12px rgba(64, 158, 255, 0.1);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  background: linear-gradient(135deg, var(--bg-panel), var(--bg-container));
  border-bottom: 1px solid var(--border-component);
}

.header-info {
  flex: 1;
  min-width: 0;
}

.orchestration-name {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-title);
}

.orchestration-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  font-style: italic;
}

.header-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 16px;
}

.card-body {
  padding: 16px;
}

.steps-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.steps-label {
  font-size: 13px;
  color: var(--text-secondary);
  font-weight: 500;
}

.step-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.step-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  
  .el-icon {
    font-size: 14px;
  }
}
</style>
