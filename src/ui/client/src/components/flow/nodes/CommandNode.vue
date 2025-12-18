<script setup lang="ts">
import { computed } from 'vue'
import { Monitor, Folder } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

const configStore = useConfigStore()

// 获取命令详细信息
const commandDetail = computed(() => {
  if (!props.data.config || !props.data.config.commandId) return null
  const cmd = configStore.customCommands.find(c => c.id === props.data.config!.commandId)
  return cmd || null
})

// 获取命令信息
const commandInfo = computed(() => {
  if (!props.data.config) return null
  return {
    name: props.data.config.commandName || '未配置',
    terminal: props.data.config.useTerminal || false,
    command: commandDetail.value?.command || '',
    directory: commandDetail.value?.directory || ''
  }
})

</script>

<template>
  <div
    class="command-node"
    :class="{ 'disabled': !data.enabled, 'selected': data.selected }"
  >
    <div class="node-header">
      <div class="flow-node-icon">📋</div>
      <div class="node-type">命令节点</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div class="node-badges">
        <div v-if="commandInfo?.terminal" class="node-badge terminal">
          <el-icon><Monitor /></el-icon>
          <span>终端</span>
        </div>
      </div>
      <div v-if="!data.config" class="node-warning">未配置</div>
      
      <!-- 显示命令详细信息 -->
      <div v-if="commandInfo?.command" class="command-details">
        <div class="command-code">
          <code>{{ commandInfo.command }}</code>
        </div>
        <div v-if="commandInfo.directory" class="command-dir">
          <el-icon><Folder /></el-icon>
          <span>{{ commandInfo.directory }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.command-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--color-primary);
  box-shadow: var(--shadow-md);
  min-width: 220px;
  max-width: 320px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: var(--color-primary-dark);
    box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.2), var(--shadow-lg);
    transform: translateY(-1px);
  }
  
  &.disabled {
    opacity: 0.6;
    border-color: var(--border-component);
  }
}

.node-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-base);
  
  .node-icon {
    font-size: 20px;
  }
  
  .node-type {
    font-size: var(--font-size-sm);
    color: var(--text-tertiary);
    font-weight: var(--font-weight-medium);
  }
}

.node-content {
  font-size: 13px;
  color: var(--text-primary);
  
  .node-label {
    font-weight: 600;
    margin-bottom: 4px;
    word-break: break-word;
  }
  
  .node-badges {
    display: flex;
    gap: 4px;
    margin-top: 4px;
  }
  
  .node-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 500;
    
    &.terminal {
      background: var(--color-warning);
      color: white;
      
      .el-icon {
        font-size: 12px;
      }
    }
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
  
  .command-details {
    margin-top: 8px;
    font-size: 11px;
    
    .command-code {
      background: rgba(0, 0, 0, 0.05);
      border-radius: 4px;
      padding: 4px 6px;
      margin-bottom: 4px;
      max-width: 100%;
      overflow: hidden;
      
      code {
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 10px;
        color: var(--text-secondary);
        word-break: break-all;
        white-space: pre-wrap;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
    
    .command-dir {
      display: flex;
      align-items: center;
      gap: 4px;
      color: var(--text-tertiary);
      
      .el-icon {
        font-size: 12px;
        flex-shrink: 0;
      }
      
      span {
        font-size: 10px;
        word-break: break-all;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }
}

</style>
