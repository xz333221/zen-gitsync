<script setup lang="ts">
import { computed, ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { VideoPlay, Close } from '@element-plus/icons-vue'
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

// 控制下拉菜单显示
const dropdownVisible = ref(false)

// 获取版本管理信息
const versionInfo = computed(() => {
  if (!props.data.config) return null
  return {
    target: props.data.config.versionTarget,
    dependency: props.data.config.dependencyName
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
      class="version-node" 
      :class="{ 'disabled': !data.enabled, 'selected': data.selected }"
    >
      <!-- 删除按钮 -->
      <button 
        class="delete-btn" 
        @click.stop="emit('delete', id)" 
        title="删除节点"
      >
        <el-icon><Close /></el-icon>
      </button>
    
    <!-- 输入连接点（左侧） -->
    <Handle 
      type="target" 
      :position="Position.Left" 
      class="flow-node-handle handle-left"
    />
    
    <div class="node-header">
      <div class="flow-node-icon">📦</div>
      <div class="node-type">版本管理</div>
    </div>
    
    <div class="node-content">
      <div class="node-label">{{ data.label }}</div>
      <div v-if="versionInfo?.target === 'dependency'" class="node-badge">
        依赖: {{ versionInfo.dependency }}
      </div>
      <div v-if="!data.config" class="node-warning">未配置</div>
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
.version-node {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  border: 2px solid var(--color-success);
  box-shadow: var(--shadow-md);
  min-width: 200px;
  max-width: 250px;
  position: relative;
  transition: var(--transition-all);
  
  // 选中状态
  &.selected {
    border-color: #389e0d;
    box-shadow: 0 0 0 3px rgba(82, 196, 26, 0.2), var(--shadow-lg);
    transform: translateY(-1px);
  }
  
  .delete-btn {
    position: absolute;
    top: -10px;
    right: -10px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #ff4d4f;
    color: white;
    border: 2px solid var(--bg-page);
    cursor: pointer;
    display: none;
    align-items: center;
    justify-content: center;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 10;
    padding: 0;
    box-shadow: 0 2px 8px rgba(255, 77, 79, 0.3);
    
    .el-icon {
      font-size: 14px;
    }
    
    &:hover {
      transform: scale(1.15) rotate(90deg);
      background: #ff7875;
      box-shadow: 0 4px 12px rgba(255, 77, 79, 0.4);
    }
    
    &:active {
      transform: scale(1.05) rotate(90deg);
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
  
  .flow-node-icon {
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
  
  .node-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(104, 189, 255, 0.15);
    color: var(--color-info);
    margin-top: 6px;
    max-width: 100%;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

.handle-left,
.handle-right {
  background: var(--color-success) !important;
}

.handle-left {
  left: -6px !important;
}

.handle-right {
  right: -6px !important;
}
</style>
