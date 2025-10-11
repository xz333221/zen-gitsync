<script setup lang="ts">
import { computed } from 'vue'
import { Lock, Unlock, RefreshRight, Close } from '@element-plus/icons-vue'

interface Props {
  filePath: string
  fileType: string
  isLocked?: boolean
  isLocking?: boolean
  showLockButton?: boolean // 是否显示锁定按钮，默认true
}

const props = withDefaults(defineProps<Props>(), {
  isLocked: false,
  isLocking: false,
  showLockButton: true
})

const emit = defineEmits<{
  toggleLock: [filePath: string]
  stage: [filePath: string]
  unstage: [filePath: string]
  revert: [filePath: string]
}>()

// 根据文件类型获取操作按钮配置
const actionButtons = computed(() => {
  switch (props.fileType) {
    case 'added':
      return [
        {
          type: 'unstage',
          tooltip: '取消暂存',
          buttonType: 'warning',
          icon: '-',
          handler: () => emit('unstage', props.filePath)
        }
      ]
    case 'modified':
    case 'deleted':
      return [
        {
          type: 'stage',
          tooltip: '添加到暂存区',
          buttonType: 'success',
          icon: '+',
          handler: () => emit('stage', props.filePath)
        },
        {
          type: 'revert',
          tooltip: '撤回修改',
          buttonType: 'danger',
          icon: RefreshRight,
          handler: () => emit('revert', props.filePath)
        }
      ]
    case 'untracked':
      return [
        {
          type: 'stage',
          tooltip: '添加到暂存区',
          buttonType: 'success',
          icon: '+',
          handler: () => emit('stage', props.filePath)
        },
        {
          type: 'delete',
          tooltip: '删除文件',
          buttonType: 'danger',
          icon: Close,
          handler: () => emit('revert', props.filePath)
        }
      ]
    default:
      return []
  }
})

// 处理锁定切换
function handleToggleLock(event: Event) {
  event.stopPropagation()
  emit('toggleLock', props.filePath)
}

// 处理操作按钮点击
function handleActionClick(handler: () => void, event: Event) {
  event.stopPropagation()
  handler()
}
</script>

<template>
  <div class="file-action-buttons">
    <!-- 锁定/解锁按钮 -->
    <el-tooltip 
      v-if="showLockButton"
      :content="isLocking ? '处理中...' : (isLocked ? '解锁文件' : '锁定文件')" 
      placement="top" 
      :hide-after="1000" 
      :show-after="200"
    >
      <el-button
        :type="isLocked ? 'danger' : 'info'"
        size="small"
        text
        :loading="isLocking"
        :disabled="isLocking"
        @click="handleToggleLock"
        class="file-action-btn"
      >
        <el-icon v-if="!isLocking" size="16">
          <component :is="isLocked ? Lock : Unlock" />
        </el-icon>
      </el-button>
    </el-tooltip>
    
    <!-- 动态操作按钮（文件被锁定时隐藏） -->
    <template v-if="!isLocked" v-for="action in actionButtons" :key="action.type">
      <el-tooltip :content="action.tooltip" placement="top" :hide-after="1000" :show-after="200">
        <el-button
          :type="action.buttonType"
          size="small"
          text
          @click="(e: Event) => handleActionClick(action.handler, e)"
          class="file-action-btn"
        >
          <el-icon v-if="typeof action.icon !== 'string'" size="16">
            <component :is="action.icon" />
          </el-icon>
          <span v-else style="font-size: 16px; font-weight: bold;">{{ action.icon }}</span>
        </el-button>
      </el-tooltip>
    </template>
  </div>
</template>

<style scoped lang="scss">
.file-action-buttons {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
}

.file-action-btn {
  padding: 4px;
  min-width: 24px;
  height: 24px;
}
</style>

<style lang="scss">
// 全局样式：让按钮在hover时显示
.file-item,
.file-group-item {
  .file-action-buttons {
    display: none;
  }
  
  &:hover .file-action-buttons {
    display: flex;
  }
}
</style>
