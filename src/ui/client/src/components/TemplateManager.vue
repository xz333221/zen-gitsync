<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Edit } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'

export interface TemplateManagerProps {
  visible: boolean
  type: 'description' | 'scope' | 'message'
  title: string
  placeholder?: string
  editPlaceholder?: string
  emptyDescription?: string
  showDefaultSection?: boolean
  showHelpText?: boolean
}

export interface TemplateManagerEmits {
  (e: 'update:visible', value: boolean): void
  (e: 'use-template', template: string): void
  (e: 'set-default', template: string): void
}

const props = withDefaults(defineProps<TemplateManagerProps>(), {
  placeholder: '输入新模板内容',
  editPlaceholder: '编辑模板内容',
  emptyDescription: '暂无保存的模板',
  showDefaultSection: false,
  showHelpText: false
})

const emit = defineEmits<TemplateManagerEmits>()

const configStore = useConfigStore()

// 组件内部状态
const newTemplate = ref('')
const isEditing = ref(false)
const originalTemplate = ref('')
const editingIndex = ref(-1)
const isSaving = ref(false)
const isSavingDefault = ref(false)

// 计算属性：获取当前类型的模板列表
const templates = computed(() => {
  switch (props.type) {
    case 'description':
      return configStore.descriptionTemplates || []
    case 'scope':
      return configStore.scopeTemplates || []
    case 'message':
      return configStore.messageTemplates || []
    default:
      return []
  }
})

// 计算属性：获取当前默认提交信息（只在message类型时使用）
const defaultCommitMessage = computed(() => {
  return props.type === 'message' ? configStore.defaultCommitMessage : ''
})

// 计算属性：当前输入框的placeholder
const currentPlaceholder = computed(() => {
  return isEditing.value ? props.editPlaceholder : props.placeholder
})

// 计算属性：按钮文本
const buttonText = computed(() => {
  return isEditing.value ? '更新模板' : '添加模板'
})

// 显示/隐藏弹窗
const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value)
})

// 监听弹窗关闭，重置状态
watch(dialogVisible, (newVal) => {
  if (!newVal) {
    resetForm()
  }
})

// 重置表单
function resetForm() {
  newTemplate.value = ''
  isEditing.value = false
  originalTemplate.value = ''
  editingIndex.value = -1
}

// 保存模板
async function saveTemplate() {
  if (!newTemplate.value.trim()) {
    ElMessage.warning('模板内容不能为空')
    return
  }

  try {
    isSaving.value = true
    if (isEditing.value) {
      // 更新模板
      const success = await configStore.updateTemplate(originalTemplate.value, newTemplate.value, props.type)
      if (success) {
        resetForm()
      }
    } else {
      // 新增模板
      const success = await configStore.saveTemplate(newTemplate.value, props.type)
      if (success) {
        newTemplate.value = ''
      }
    }
  } catch (error) {
    ElMessage.error(`模板保存失败: ${(error as Error).message}`)
  } finally {
    isSaving.value = false
  }
}

// 使用模板
function useTemplate(template: string) {
  emit('use-template', template)
  // 对于非message类型，使用后关闭弹窗
  if (props.type !== 'message') {
    dialogVisible.value = false
  }
}

// 开始编辑模板
function startEditTemplate(template: string, index: number) {
  isEditing.value = true
  originalTemplate.value = template
  newTemplate.value = template
  editingIndex.value = index
}

// 取消编辑
function cancelEdit() {
  resetForm()
}

// 删除模板
async function deleteTemplate(template: string) {
  try {
    const success = await configStore.deleteTemplate(template, props.type)
    if (success) {
      // 成功提示已在 store 中统一处理
    }
  } catch (error) {
    ElMessage.error(`模板删除失败: ${(error as Error).message}`)
  }
}

// 设为默认（仅message类型使用）
async function setAsDefault() {
  if (props.type !== 'message' || !newTemplate.value.trim()) {
    return
  }

  try {
    isSavingDefault.value = true
    const success = await configStore.saveDefaultMessage(newTemplate.value)
    if (success) {
      emit('set-default', newTemplate.value)
    }
  } catch (error) {
    ElMessage.error(`设置默认提交信息失败: ${(error as Error).message}`)
  } finally {
    isSavingDefault.value = false
  }
}

// 暴露方法给父组件
defineExpose({
  resetForm
})
</script>

<template>
  <el-dialog 
    v-model="dialogVisible"
    :title="title"
    width="80vw"
    top="70px"
    style="height: calc(100vh - 140px);"
    :close-on-click-modal="false"
    :class="type === 'message' ? 'message-template-dialog' : 'template-dialog'"
  >
    <div class="template-container" :class="{ 'message-template-container': type === 'message' }">
      <div class="template-form">
        <el-input 
          v-model="newTemplate" 
          :placeholder="currentPlaceholder"
          class="template-input" 
          clearable 
          @keyup.enter="saveTemplate"
        />
        <div class="template-form-buttons">
          <el-button v-if="isEditing" @click="cancelEdit">取消</el-button>
          <el-button 
            type="primary" 
            @click="saveTemplate" 
            :disabled="!newTemplate.trim() || isSaving"
            :loading="isSaving"
          >
            {{ buttonText }}
          </el-button>
          <!-- 默认提交信息设置的特殊按钮 -->
          <el-button 
            v-if="type === 'message'" 
            type="success" 
            @click="setAsDefault" 
            :disabled="!newTemplate.trim() || isSavingDefault"
            :loading="isSavingDefault"
            plain
          >
            设为默认提交信息
          </el-button>
        </div>
      </div>

      <!-- 普通模板布局：固定标题，仅列表滚动 -->
      <div v-if="type !== 'message'" class="template-list">
        <h3>已保存{{ type === 'description' ? '模板' : '作用域' }}</h3>
        <el-empty v-if="templates.length === 0" :description="emptyDescription" />
        <div v-else class="template-list-scroll">
          <el-card v-for="(template, index) in templates" :key="index" class="template-item">
            <el-row justify="space-between" align="middle" style="width: 100%">
              <div class="template-content">{{ template }}</div>
              <div class="template-actions">
                <el-button type="primary" size="small" @click="useTemplate(template)">使用</el-button>
                <el-button 
                  type="warning" 
                  size="small" 
                  :icon="Edit"
                  @click="startEditTemplate(template, index)"
                >
                  编辑
                </el-button>
                <el-button type="danger" size="small" @click="deleteTemplate(template)">删除</el-button>
              </div>
            </el-row>
          </el-card>
        </div>
      </div>

      <!-- 提交信息模板的特殊布局 -->
      <div v-else class="templates-container">
        <div class="message-templates-list">
          <h3>已保存模板</h3>
          <div class="templates-scroll-area">
            <el-empty v-if="templates.length === 0" :description="emptyDescription" />
            <el-card v-for="(template, index) in templates" :key="index" class="template-item">
              <el-row justify="space-between" align="middle" style="width: 100%">
                <div class="template-content">{{ template }}</div>
                <div class="template-actions">
                  <el-button type="primary" size="small" @click="useTemplate(template)">使用</el-button>
                  <el-button 
                    type="warning" 
                    size="small" 
                    :icon="Edit"
                    @click="startEditTemplate(template, index)"
                  >
                    编辑
                  </el-button>
                  <el-button type="danger" size="small" @click="deleteTemplate(template)">删除</el-button>
                </div>
              </el-row>
            </el-card>
          </div>
        </div>
        
        <!-- 默认提交信息部分 -->
        <div v-if="showDefaultSection" class="current-default-message">
          <h3>当前默认提交信息</h3>
          <el-card class="default-message-card" v-if="defaultCommitMessage">
            <div class="default-message-content">{{ defaultCommitMessage }}</div>
          </el-card>
          <el-empty v-else description="尚未设置默认提交信息" :image-size="100" />
          
          <div v-if="showHelpText" class="message-help-text">
            <h4>关于默认提交信息</h4>
            <p>默认提交信息将在未输入提交信息时自动使用。</p>
            <p>你可以通过点击左侧模板的<el-tag size="small" type="primary">使用</el-tag>按钮先选择喜欢的模板，然后点击上方<el-tag size="small" type="success">设为默认提交信息</el-tag>按钮保存。</p>
          </div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.template-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
}

.template-form {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.template-input {
  font-size: 14px;
  flex: 1;
  height: 34px;
}

.template-form-buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-start;
  flex-wrap: nowrap;
}

.template-list {
  display: flex;
  flex-direction: column;
  /* 占据对话框内容剩余空间，避免标题跟随滚动 */
  flex: 1;
  overflow: hidden;
}

.template-list h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
  font-weight: 600;
  
}

/* 仅列表滚动区域 */
.template-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding-right: 8px;
}

.template-list-scroll::-webkit-scrollbar {
  width: 6px;
}

.template-list-scroll::-webkit-scrollbar-thumb {
  background-color: #c0c4cc;
  border-radius: 3px;
}

.template-list-scroll::-webkit-scrollbar-track {
  background-color: var(--bg-panel);
}

.template-item {
  margin-bottom: 8px;
  border-radius: 6px;
  transition: background-color 0.2s ease, border-color 0.2s ease;
}

/* Remove shadows, use lightweight border style */
:deep(.template-item.el-card) {
  box-shadow: none !important;
  border: 1px solid #eceff5;
}

.template-item:hover {
  background-color: #fafcff;
}

.template-content {
  flex: 1;
  font-size: 14px;
  color: var(--text-secondary);
  word-break: break-all;
  margin-right: 12px;
}

.template-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

/* 提交信息模板特殊样式 */
.message-template-container {
  flex-direction: column;
}

.templates-container {
  display: flex;
  gap: 20px;
  flex: 1;
  overflow: hidden;
}

.message-templates-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.templates-scroll-area {
  flex: 1;
  overflow-y: auto;
  padding-right: 8px;
  max-height: calc(100vh - 360px);
}

.current-default-message {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.current-default-message h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  
}

.default-message-card {
  border-radius: 6px;
}

.default-message-content {
  font-size: 14px;
  color: var(--text-secondary);
  word-break: break-all;
}

.message-help-text {
  padding: 16px;
  border-radius: 6px;
  border-left: 4px solid #409eff;
}

.message-help-text h4 {
  margin: 0 0 8px 0;
  font-size: 14px;
  
}

.message-help-text p {
  margin: 0 0 8px 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.message-help-text p:last-child {
  margin-bottom: 0;
}

/* 滚动条样式 */
.templates-scroll-area::-webkit-scrollbar {
  width: 6px;
}

.templates-scroll-area::-webkit-scrollbar-thumb {
  background-color: #c0c4cc;
  border-radius: 3px;
}

.templates-scroll-area::-webkit-scrollbar-track {
  background-color: var(--bg-panel);
}


.template-input {
  height: 36px;
}

.template-form-buttons .el-button {
  min-width: 92px;
}

/* 标题在滚动时保持可见 */
.template-list {
  position: relative;
}

.template-list h3 {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 0 10px 0;
  border-bottom: 1px solid var(--bg-icon);
}

/* 卡片列表的细节优化 */
:deep(.template-item .el-card__body) {
  padding: 8px 10px;
}

/* Disable transform/shadow hover effects for a flatter look */

.template-item:hover {
  transform: none;
  box-shadow: none !important;
}

.template-actions .el-button {
  min-width: 66px;
}

/* message 模式下左侧标题 sticky 与滚动体验优化 */
.message-templates-list {
  position: relative;
}

.message-templates-list h3 {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 0 10px 0;
  border-bottom: 1px solid var(--bg-icon);
}

.templates-scroll-area {
  padding-top: 4px;
}
</style>
