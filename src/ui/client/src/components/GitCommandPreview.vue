<template>
  <div class="git-command-preview">
    <div class="preview-header">
      <div class="preview-title">{{ title }}</div>
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
    <pre class="preview-content code-command">{{ displayCommand }}</pre>
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
  
  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    
    .preview-title {
      font-size: 14px;
      color: #606266;
      font-weight: 500;
    }
    
    .copy-command-btn {
      padding: 4px 8px;
      min-height: 24px;
      
      .el-icon {
        font-size: 14px;
      }
    }
  }
  
  .preview-content {
    background-color: #f5f7fa;
    border: 1px solid #e4e7ed;
    border-radius: 4px;
    padding: 12px;
    margin: 0;
    font-family: 'Courier New', 'Monaco', 'Menlo', monospace;
    font-size: 13px;
    color: #2c3e50;
    line-height: 1.4;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    
    &.code-command {
      background-color: #282c34;
      color: #abb2bf;
      border-color: #3c4043;
    }
  }
}

// 支持暗色主题
@media (prefers-color-scheme: dark) {
  .git-command-preview {
    .preview-title {
      color: #c0c4cc;
    }
    
    .preview-content {
      background-color: #1e1e1e;
      border-color: #414243;
      color: #d4d4d4;
      
      &.code-command {
        background-color: #0d1117;
        color: #c9d1d9;
        border-color: #30363d;
      }
    }
  }
}
</style>
