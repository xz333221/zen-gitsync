<template>
  <div class="git-command-preview">
    <div class="preview-container">
      <div class="preview-title">{{ title }}</div>
      <div class="preview-content code-command">{{ displayCommand }}</div>
      <IconButton
        :tooltip="copyButtonText"
        size="small"
        custom-class="copy-command-btn"
        @click="copyCommand"
      >
        <el-icon><CopyDocument /></el-icon>
      </IconButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument } from '@element-plus/icons-vue'
import IconButton from '@components/IconButton.vue'

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
.git-command-preview {
  margin-bottom: var(--spacing-base);
}

.preview-container {
  display: flex;
  align-items: center;
  gap: 0;
  background: var(--bg-console);
  border: 1px solid var(--border-console);
  border-radius: var(--radius-lg);
  overflow: hidden;
  transition: border-color 0.2s ease;

  &:hover {
    border-color: var(--border-console-hover);
  }
}

.preview-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px 7px 14px;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  color: var(--text-console-muted);
  white-space: nowrap;
  flex-shrink: 0;
  border-right: 1px solid var(--border-console);
  background: var(--bg-console-cmd);

  /* 绿色 $ 提示符 */
  &::before {
    content: '$';
    color: var(--text-console-prompt);
    font-weight: 700;
    font-size: 13px;
  }
}

.preview-content {
  flex: 1;
  padding: 7px var(--spacing-base);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-console);
  white-space: nowrap;
  overflow-x: auto;
  background: transparent;
  line-height: 1.4;

  &::-webkit-scrollbar { height: 3px; }
  &::-webkit-scrollbar-track { background: transparent; }
  &::-webkit-scrollbar-thumb {
    background: var(--console-scrollbar);
    border-radius: 2px;
  }
}

::deep(.copy-command-btn) {
  flex-shrink: 0;
  margin-right: 6px;
  color: var(--text-console-muted) !important;

  &:hover {
    color: var(--text-console) !important;
    background: var(--bg-console-soft) !important;
  }
}
</style>
