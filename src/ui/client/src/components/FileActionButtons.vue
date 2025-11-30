<script setup lang="ts">
import { $t } from '@/lang/static'
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
  manageLockedFiles: []
}>()

// 根据文件类型获取操作按钮配置
const actionButtons = computed(() => {
  switch (props.fileType) {
    case 'added':
      return [
        {
          type: 'unstage',
          tooltip: $t('@0883F:取消暂存'),
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
          tooltip: $t('@0883F:添加到暂存区'),
          buttonType: 'success',
          icon: '+',
          handler: () => emit('stage', props.filePath)
        },
        {
          type: 'revert',
          tooltip: $t('@0883F:撤回修改'),
          buttonType: 'danger',
          icon: RefreshRight,
          handler: () => emit('revert', props.filePath)
        }
      ]
    case 'untracked':
      return [
        {
          type: 'stage',
          tooltip: $t('@0883F:添加到暂存区'),
          buttonType: 'success',
          icon: '+',
          handler: () => emit('stage', props.filePath)
        },
        {
          type: 'delete',
          tooltip: $t('@0883F:删除文件'),
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

// 处理管理锁定文件
function handleManageLockedFiles(event: Event) {
  event.stopPropagation()
  emit('manageLockedFiles')
}
</script>

<template>
  <div class="file-action-buttons">
    <!-- 锁定/解锁按钮 -->
    <el-tooltip 
      v-if="showLockButton"
      :content="isLocking ? $t('@0883F:处理中...') : (isLocked ? $t('@0883F:解锁文件') : $t('@0883F:锁定文件'))" 
      placement="top" 
       
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
    
    <!-- 管理锁定文件按钮（只在文件被锁定时显示） -->
    <el-tooltip 
      v-if="isLocked"
      :content="$t('@13D1C:管理锁定文件')" 
      placement="top" 
      :show-after="200"
    >
      <el-button
        type="warning"
        size="small"
        text
        @click="handleManageLockedFiles"
        class="file-action-btn"
      >
        <el-icon size="16">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor" d="M600.704 64a32 32 0 0 1 30.464 22.208l35.2 109.376c14.784 7.232 28.928 15.36 42.432 24.512l112.384-24.192a32 32 0 0 1 34.432 15.36L944.32 364.8a32 32 0 0 1-4.032 37.504l-77.12 85.12a357.12 357.12 0 0 1 0 49.024l77.12 85.248a32 32 0 0 1 4.032 37.504l-88.704 153.6a32 32 0 0 1-34.432 15.296L708.8 803.904c-13.44 9.088-27.648 17.28-42.368 24.512l-35.264 109.376A32 32 0 0 1 600.704 960H423.296a32 32 0 0 1-30.464-22.208L357.696 828.48a351.616 351.616 0 0 1-42.56-24.64l-112.32 24.256a32 32 0 0 1-34.432-15.36L79.68 659.2a32 32 0 0 1 4.032-37.504l77.12-85.248a357.12 357.12 0 0 1 0-48.896l-77.12-85.248A32 32 0 0 1 79.68 364.8l88.704-153.6a32 32 0 0 1 34.432-15.296L315.2 220.096c13.568-9.152 27.776-17.408 42.56-24.64l35.2-109.312A32 32 0 0 1 423.232 64H600.64zm-23.424 64H446.72l-36.352 113.088-24.512 11.968a294.113 294.113 0 0 0-34.816 20.096l-22.656 15.36-116.224-25.088-65.28 113.152 79.68 88.192-1.92 27.136a293.12 293.12 0 0 0 0 40.192l1.92 27.136-79.808 88.192 65.344 113.152 116.224-25.024 22.656 15.296a294.113 294.113 0 0 0 34.816 20.096l24.512 11.968L446.72 896h130.688l36.48-113.152 24.448-11.904a288.282 288.282 0 0 0 34.752-20.096l22.592-15.296 116.288 25.024 65.28-113.152-79.744-88.192 1.92-27.136a293.12 293.12 0 0 0 0-40.256l-1.92-27.136 79.808-88.128-65.344-113.152-116.288 24.96-22.592-15.232a287.616 287.616 0 0 0-34.752-20.096l-24.448-11.904L577.344 128zM512 320a192 192 0 1 1 0 384 192 192 0 0 1 0-384zm0 64a128 128 0 1 0 0 256 128 128 0 0 0 0-256z"/>
          </svg>
        </el-icon>
      </el-button>
    </el-tooltip>
    
    <!-- 动态操作按钮（文件被锁定时隐藏） -->
    <template v-if="!isLocked" v-for="action in actionButtons" :key="action.type">
      <el-tooltip :content="action.tooltip" placement="top"  :show-after="200">
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
  padding: var(--spacing-sm);
  min-width: 24px;
  height: 24px;
}
</style>
