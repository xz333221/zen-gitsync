<script setup lang="ts">
import { computed, ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { VideoPlay, Monitor, Folder } from '@element-plus/icons-vue'
import { useConfigStore } from '@stores/configStore'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

const emit = defineEmits<{
  (e: 'delete', nodeId: string): void
  (e: 'execute-from-node', nodeId: string): void
  (e: 'execute-single-node', nodeId: string): void
}>()

const configStore = useConfigStore()

// 控制下拉菜单显示
const dropdownVisible = ref(false)

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

// 处理下拉菜单命令
function handleCommand(command: string) {
  if (command === 'executeFrom') {
    emit('execute-from-node', props.id)
  } else if (command === 'executeSingle') {
    emit('execute-single-node', props.id)
  }
}
</script>

<template>
  <el-dropdown
    trigger="contextmenu"
    @command="handleCommand"
    @visible-change="(val: boolean) => dropdownVisible = val"
    popper-class="flow-node-dropdown"
  >
    <div 
      class="command-node" 
      :class="{ 'disabled': !data.enabled }"
    >
      <!-- 删除按钮 -->
      <button 
        class="delete-btn" 
        @click.stop="emit('delete', id)" 
        title="删除节点"
      >
        ×
      </button>
    
    <!-- 输入连接点（左侧） -->
    <Handle 
      type="target" 
      :position="Position.Left" 
      class="flow-node-handle handle-left"
    />
    
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
    
    <!-- 禁用遮罩 -->
    <div v-if="!data.enabled" class="disabled-overlay">已禁用</div>
    
    <!-- 输出连接点（右侧） -->
    <Handle 
      type="source" 
      :position="Position.Right" 
      class="flow-node-handle handle-right"
    />
  </div>
  
  <template #dropdown>
    <el-dropdown-menu>
      <el-dropdown-item command="executeFrom">
        <el-icon><VideoPlay /></el-icon>
        从此处开始执行
      </el-dropdown-item>
      <el-dropdown-item command="executeSingle">
        <el-icon><VideoPlay /></el-icon>
        只执行此节点
      </el-dropdown-item>
    </el-dropdown-menu>
  </template>
</el-dropdown>
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
  
  .delete-btn {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--color-danger);
    color: white;
    border: 2px solid var(--bg-page);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    transition: var(--transition-all);
    z-index: 10;
    
    &:hover {
      transform: scale(1.1);
      background: var(--color-danger-dark);
    }
  }
  
  &:hover {
    box-shadow: var(--shadow-lg);
    
    .delete-btn {
      display: flex;
    }
  }
  
  &.disabled {
    opacity: 0.6;
    border-color: var(--border-component);
    
    .disabled-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: var(--font-size-sm);
      color: var(--text-tertiary);
      border-radius: var(--radius-md);
      z-index: 5;
    }
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

// CommandNode 只覆写颜色，其他尺寸/交互在公共样式中
.handle-left,
.handle-right {
  background: var(--color-primary) !important;
}

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}
</style>
