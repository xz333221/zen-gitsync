<script setup lang="ts">
import { computed } from 'vue'
import { ElDialog } from 'element-plus'

// 定义弹窗尺寸枚举
type DialogSize = 'small' | 'medium' | 'large' | 'extra-large'
type DialogType = 'default' | 'flex' | 'full-height'

interface Props {
  // 基础属性
  modelValue: boolean
  title: string
  size?: DialogSize
  type?: DialogType
  
  // 高级属性
  width?: string
  height?: string
  top?: string
  
  // 功能属性
  closeOnClickModal?: boolean
  closeOnPressEscape?: boolean
  destroyOnClose?: boolean
  draggable?: boolean
  
  // 样式相关
  customClass?: string
  appendToBody?: boolean
  lockScroll?: boolean
  
  // 按钮配置
  showFooter?: boolean
  confirmText?: string
  cancelText?: string
  showCancel?: boolean
  confirmLoading?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'medium',
  type: 'default',
  top: '80px',
  closeOnClickModal: false,
  closeOnPressEscape: true,
  destroyOnClose: false,
  draggable: false,
  appendToBody: false,
  lockScroll: true,
  showFooter: false,
  confirmText: '确定',
  cancelText: '取消',
  showCancel: true,
  confirmLoading: false
})

// 定义事件
interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'close'): void
  (e: 'opened'): void
  (e: 'closed'): void
}

const emit = defineEmits<Emits>()

// 计算弹窗尺寸
const dialogWidth = computed(() => {
  if (props.width) return props.width
  
  switch (props.size) {
    case 'small':
      return '30%'
    case 'medium':
      return '50%'
    case 'large':
      return '80%'
    case 'extra-large':
      return '90%'
    default:
      return '50%'
  }
})

// 计算弹窗高度
// 移除 --dialog-height 相关计算，改为使用全局样式控制高度

// 计算CSS类
const dialogClass = computed(() => {
  const classes = []
  
  if (props.customClass) {
    classes.push(props.customClass)
  }
  
  if (props.type === 'flex') {
    classes.push('common-dialog--flex')
  }
  
  if (props.type === 'full-height') {
    classes.push('common-dialog--full-height')
  }
  
  return classes.join(' ')
})

// 事件处理
function handleClose() {
  emit('update:modelValue', false)
  emit('close')
}

function handleConfirm() {
  emit('confirm')
}

function handleCancel() {
  emit('cancel')
  handleClose()
}

function handleOpened() {
  emit('opened')
}

function handleClosed() {
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    :width="dialogWidth"
    :top="top"
    :close-on-click-modal="closeOnClickModal"
    :close-on-press-escape="closeOnPressEscape"
    :destroy-on-close="destroyOnClose"
    :draggable="draggable"
    :class="dialogClass"
    :append-to-body="appendToBody"
    :lock-scroll="lockScroll"
    @close="handleClose"
    @opened="handleOpened"
    @closed="handleClosed"
  >
    <!-- 主要内容区域 -->
    <slot />
    
    <!-- 底部按钮区域 -->
    <template #footer v-if="showFooter || $slots.footer">
      <slot name="footer">
        <div class="common-dialog__footer">
          <el-button v-if="showCancel" @click="handleCancel">
            {{ cancelText }}
          </el-button>
          <el-button 
            type="primary" 
            :loading="confirmLoading"
            @click="handleConfirm"
          >
            {{ confirmText }}
          </el-button>
        </div>
      </slot>
    </template>
  </el-dialog>
</template>

<style lang="scss">
// 添加全局样式支持
.file-diff-dialog.common-dialog--flex .el-dialog__body {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  /* 仅纵向滚动 */
  overflow-x: hidden !important;
  overflow-y: auto !important;
}

.stash-detail-dialog.common-dialog--flex .el-dialog__body {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
}

.commit-detail-dialog.common-dialog--flex .el-dialog__body {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
}
</style>

<style scoped lang="scss">
// flex布局弹窗
:deep(.common-dialog--flex) {
  .el-dialog {
    display: flex;
    flex-direction: column;
    /* 使用全局的 .el-dialog 高度策略，这里不再设置变量高度 */
    height: auto !important;
    max-height: 90vh; /* 防止超出屏幕 */
  }
  .el-dialog__header,
  .el-dialog__footer {
    flex: 0 0 auto;
  }
  
  .el-dialog__body {
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 16px;
    box-sizing: border-box;
    /* 仅纵向滚动 */
    overflow-x: hidden;
    overflow-y: auto;
    min-height: 0; /* 关键：允许flex子元素缩小 */
  }
}

// 全高度弹窗
:deep(.common-dialog--full-height) {
  .el-dialog {
    display: flex;
    flex-direction: column;
    height: auto;
  }
  .el-dialog__header,
  .el-dialog__footer {
    flex: 0 0 auto;
  }
  
  .el-dialog__body {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px;
    box-sizing: border-box;
    min-height: 0; /* 关键：允许flex子元素缩小 */
  }
}

/* 为自定义类名提供更高的优先级 */
:deep(.commit-detail-dialog.common-dialog--flex .el-dialog__body) {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* 文件差异弹窗样式 - 提高优先级 */
:deep(.file-diff-dialog.common-dialog--flex .el-dialog__body) {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

/* 储藏详情弹窗样式 - 提高优先级 */
:deep(.stash-detail-dialog.common-dialog--flex .el-dialog__body) {
  height: calc(100vh - 200px) !important;
  padding: 12px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

// 通用底部按钮样式
.common-dialog__footer {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  
  .el-button {
    min-width: 80px;
  }
}

/* 通用对话框的细节优化（仅在该组件内生效） */
:deep(.el-dialog) {
  border-radius: 12px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06);
  overflow: hidden;
}

:deep(.el-dialog__header) {
  padding: 14px 18px;
  border-bottom: 1px solid #eef0f3;
}

:deep(.el-dialog__title) {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

:deep(.el-dialog__headerbtn) {
  top: 14px;
  right: 14px;
}

:deep(.el-dialog__body) {
  padding: 16px 18px 18px 18px;
  background: linear-gradient(180deg, #ffffff 0%, #fafbfc 100%);
}

:deep(.el-dialog__footer) {
  padding: 12px 18px;
  border-top: 1px solid #eef0f3;
}
</style>
