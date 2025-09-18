<template>
  <div class="git-command-preview">
    <div class="preview-container">
      <div class="preview-title">{{ title }}</div>
      <div class="preview-content code-command">{{ displayCommand }}</div>
      <el-button
        type="primary"
        :icon="CopyDocument"
        size="small"
        @click="copyCommand"
        :title="copyButtonText"
        class="copy-command-btn"
      >
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'

export interface GitCommandPreviewProps {
  command: string
  title?: string
  copyButtonText?: string
  placeholder?: string
}

const props = withDefaults(defineProps<GitCommandPreviewProps>(), {
  title: 'Git命令预览：',
  copyButtonText: '复制命令',
  placeholder: '<命令内容>'
})

// 计算显示的命令内容
const displayCommand = computed(() => {
  return props.command || props.placeholder
})

// 复制命令到剪贴板
async function copyCommand() {
  if (!props.command) {
    ElMessage.warning('没有可复制的命令内容')
    return
  }
  
  try {
    await navigator.clipboard.writeText(props.command)
    ElMessage.success('命令已复制到剪贴板')
  } catch (error) {
    ElMessage.error(`复制失败: ${(error as Error).message}`)
  }
}
</script>

<style scoped lang="scss">
.git-command-preview {
  margin-top: 12px;
  
  .preview-container {
    display: flex;
    align-items: center;
    gap: 12px;
    background-color: #f5f7fa;
    border: 1px solid #e4e7ed;
    border-radius: 6px;
    padding: 12px 16px;
    transition: all 0.2s ease;
    
    &:hover {
      border-color: #c0c4cc;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    }
    
    .preview-title {
      font-size: 14px;
      color: #606266;
      font-weight: 500;
      white-space: nowrap;
      flex-shrink: 0;
      min-width: fit-content;
    }
    
    .preview-content {
      flex: 1;
      background-color: #1a1a1a;
      color: #ffffff;
      border: 1px solid #3c4043;
      border-radius: 4px;
      padding: 8px 12px;
      margin: 0;
      font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.4;
      overflow-x: auto;
      white-space: nowrap;
      text-shadow: 0 0 1px rgba(255, 255, 255, 0.3);
      
      &.code-command {
        background-color: #1a1a1a;
        color: #ffffff;
        border-color: #3c4043;
        font-weight: 500;
        text-shadow: 0 0 1px rgba(255, 255, 255, 0.3);
      }
    }
    
    .copy-command-btn {
      padding: 6px 12px;
      min-height: 32px;
      flex-shrink: 0;
      border-radius: 4px;
      
      .el-icon {
        font-size: 14px;
      }
      
      &:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(64, 158, 255, 0.3);
      }
    }
  }
}




</style>
