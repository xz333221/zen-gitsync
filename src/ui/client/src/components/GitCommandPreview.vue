<template>
  <div class="git-command-preview">
    <div class="preview-container">
      <div class="preview-title">{{ title }}</div>
      <div class="preview-content code-command">{{ displayCommand }}</div>
      <button class="modern-btn copy-command-btn" @click="copyCommand">
        <el-icon class="btn-icon">
          <CopyDocument />
        </el-icon>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
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
  title: $t('@34292:Git命令预览：'),
  copyButtonText: $t('@34292:复制命令'),
  placeholder: '<命令内容>'
})

// 计算显示的命令内容
const displayCommand = computed(() => {
  return props.command || props.placeholder
})

// 复制命令到剪贴板
async function copyCommand() {
  if (!props.command) {
    ElMessage.warning($t('@34292:没有可复制的命令内容'))
    return
  }
  
  try {
    await navigator.clipboard.writeText(props.command)
    ElMessage.success($t('@34292:命令已复制到剪贴板'))
  } catch (error) {
    ElMessage.error(`${$t('@34292:复制失败: ')}${(error as Error).message}`)
  }
}
</script>

<style scoped lang="scss">
// .modern-btn {
//   display: flex;
//   align-items: center;
//   justify-content: center;
// }

.git-command-preview {
  
  .preview-container {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-input-hover);
    border: 1px solid #409eff;
    border-radius: 8px;
    padding: 8px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
    margin-bottom: 8px;
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.12);
    
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, #409eff, #66b1ff, #409eff);
      opacity: 1;
      transition: opacity 0.3s ease;
    }
    
    &:hover {
      border-color: #409eff;
      box-shadow: 0 2px 8px rgba(64, 158, 255, 0.12);
      background: var(--bg-input-hover);
      
      &::before {
        opacity: 1;
      }
    }
    
    .preview-title {
      font-size: 12px;
      color: var(--color-text-title);
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
      background: var(--bg-input-hover);
      color: var(--text-primary);
      border: 1px solid #409eff;
      border-radius: 6px;
      padding: 6px 8px;
      margin: 0;
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.3;
      overflow-x: auto;
      white-space: nowrap;
      position: relative;
      transition: all 0.3s ease;
      box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.2);
      
      &::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(135deg, rgba(64, 158, 255, 0.03) 0%, rgba(102, 177, 255, 0.03) 100%);
        opacity: 1;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }
      
      &:hover {
        border-color: #409eff;
        box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.2);
        background: var(--bg-input-hover);
        
        &::before {
          opacity: 1;
        }
      }
      
      &.code-command {
        background: var(--bg-input-hover);
        color: var(--text-primary);
        border-color: #409eff;
        font-weight: 500;
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
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: inherit;
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
        background: #f3f4f6;
        color: #409eff;
        border-color: #409eff;
        transform: scale(1.05);
        box-shadow: 0 3px 8px rgba(64, 158, 255, 0.15);
        
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

/* 白色主题专用样式 */

/* 滚动条样式 */
.preview-content::-webkit-scrollbar {
  height: 6px;
}

.preview-content::-webkit-scrollbar-track {
  background: #f3f4f6;
  border-radius: 3px;
}

.preview-content::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 3px;
  transition: background 0.3s ease;
}

.preview-content::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
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
