<template>
  <div class="git-command-preview">
    <div class="preview-container">
      <div class="preview-title">{{ title }}</div>
      <div class="preview-content code-command">{{ displayCommand }}</div>
      <el-tooltip :content="copyButtonText" placement="bottom" effect="dark" :open-delay="300">
        <button class="modern-btn copy-command-btn" @click="copyCommand">
          <el-icon class="btn-icon">
            <CopyDocument />
          </el-icon>
        </button>
      </el-tooltip>
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
.modern-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

.git-command-preview {
  
  .preview-container {
    display: flex;
    align-items: center;
    gap: 8px;
    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
    border: 1px solid #dee2e6;
    border-radius: 8px;
    padding: 8px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
    margin-bottom: 8px;
    
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, #409eff, #66b1ff, #409eff);
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    &:hover {
      border-color: #409eff;
      box-shadow: 0 2px 8px rgba(64, 158, 255, 0.12);
      background: linear-gradient(135deg, #ffffff 0%, #f0f7ff 100%);
      
      &::before {
        opacity: 1;
      }
    }
    
    .preview-title {
      font-size: 12px;
      color: #495057;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
      min-width: fit-content;
      display: flex;
      align-items: center;
      gap: 4px;
      
      &::before {
        content: '⚡';
        font-size: 10px;
        opacity: 0.8;
      }
    }
    
    .preview-content {
      flex: 1;
      background: linear-gradient(135deg, #1e1e1e 0%, #2a2a2a 100%);
      color: #e8f4fd;
      border: 1px solid #404040;
      border-radius: 6px;
      padding: 6px 8px;
      margin: 0;
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.3;
      overflow-x: auto;
      white-space: nowrap;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
      position: relative;
      transition: all 0.3s ease;
      
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(135deg, rgba(64, 158, 255, 0.05) 0%, rgba(102, 177, 255, 0.05) 100%);
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }
      
      &:hover {
        border-color: #409eff;
        box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.3);
        
        &::before {
          opacity: 1;
        }
      }
      
      &.code-command {
        background: linear-gradient(135deg, #1e1e1e 0%, #2a2a2a 100%);
        color: #e8f4fd;
        border-color: #404040;
        font-weight: 500;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
      }
    }
    
    .copy-command-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      flex-shrink: 0;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(64, 158, 255, 0.2);
      background: linear-gradient(135deg, rgba(64, 158, 255, 0.1) 0%, rgba(102, 177, 255, 0.1) 100%);
      color: #409eff;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: inherit;
      backdrop-filter: blur(10px);
      position: relative;
      overflow: hidden;
      
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: -100%;
        width: 100%;
        height: 100%;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
        transition: left 0.5s ease;
      }
      
      &:hover {
        background: linear-gradient(135deg, rgba(64, 158, 255, 0.15) 0%, rgba(102, 177, 255, 0.15) 100%);
        color: #409eff;
        border-color: rgba(64, 158, 255, 0.4);
        transform: scale(1.05);
        box-shadow: 0 3px 8px rgba(64, 158, 255, 0.2);
        
        &::before {
          left: 100%;
        }
        
        .btn-icon {
          transform: scale(1.1);
        }
      }
      
      &:active {
        transform: scale(1.02);
        box-shadow: 0 2px 4px rgba(64, 158, 255, 0.15);
      }
      
      .btn-icon {
        font-size: 14px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        z-index: 1;
        position: relative;
      }
    }
  }
}

/* 深色主题支持 */
@media (prefers-color-scheme: dark) {
  .git-command-preview {
    .preview-container {
      background: linear-gradient(135deg, #2d3748 0%, #1a202c 100%);
      border-color: #4a5568;
      
      &:hover {
        background: linear-gradient(135deg, #2d3748 0%, #2c5282 100%);
        border-color: #409eff;
      }
      
      .preview-title {
        color: #e2e8f0;
      }
    }
  }
}

/* 滚动条样式 */
.preview-content::-webkit-scrollbar {
  height: 6px;
}

.preview-content::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

.preview-content::-webkit-scrollbar-thumb {
  background: rgba(64, 158, 255, 0.5);
  border-radius: 3px;
  transition: background 0.3s ease;
}

.preview-content::-webkit-scrollbar-thumb:hover {
  background: rgba(64, 158, 255, 0.7);
}

/* 动画关键帧 */
@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.copy-command-btn:active .btn-icon {
  animation: pulse 0.3s ease-in-out;
}

</style>
