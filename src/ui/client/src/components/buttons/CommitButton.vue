<script setup lang="ts">
import { $t } from '@/lang/static'
import { computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { Check } from '@element-plus/icons-vue'

interface Props {
  from?: 'form' | 'drawer' | 'status'
  hasUserCommitMessage?: boolean
  finalCommitMessage?: string
  skipHooks?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  from: 'form',
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false
})

const emit = defineEmits<{
  click: []
  beforeCommit: []
  afterCommit: [success: boolean]
}>()

const gitStore = useGitStore()
const configStore = useConfigStore()

// 检查文件是否被锁定
function isFileLocked(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/')
  return configStore.lockedFiles.some((lockedFile: string) => {
    const normalizedLocked = lockedFile.replace(/\\/g, '/')
    return normalizedPath === normalizedLocked
  })
}

// 计算已暂存文件数量（排除锁定文件）
const stagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file =>
    file.type === 'added' &&
    !isFileLocked(file.path)
  ).length
})

// 计算是否有已暂存的更改
const hasStagedChanges = computed(() => {
  return stagedFilesCount.value > 0
})

// 计算按钮禁用状态
const isDisabled = computed(() => {
  // 如果有冲突文件，禁用提交按钮
  if (gitStore.hasConflictedFiles) {
    return true
  }
  return !hasStagedChanges.value || !props.hasUserCommitMessage
})

// 计算提示文本
const tooltipText = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return $t('@76A11:存在冲突文件，请先解决冲突')
  }
  if (!hasStagedChanges.value) {
    return $t('@76A11:没有已暂存的更改')
  }
  if (!props.hasUserCommitMessage) {
    return $t('@76A11:请输入提交信息')
  }
  return `${$t('@76A11:提交')}${stagedFilesCount.value}${$t('@76A11:个已暂存文件')}`
})

// 处理点击事件
async function handleClick() {
  if (!props.finalCommitMessage.trim()) {
    return
  }

  emit('beforeCommit')
  emit('click')

  try {
    const result = await gitStore.commitChanges(props.finalCommitMessage, props.skipHooks)
    
    if (result) {
      // 触发状态更新事件
      gitStore.fetchStatus()
      gitStore.fetchLog()
      // 手动更新分支状态（不需要等待，因为只是提交操作）
      gitStore.getBranchStatus(true)
    }
    
    emit('afterCommit', result)
  } catch (error) {
    console.error('提交失败:', error)
    emit('afterCommit', false)
  }
}
</script>

<template>
  <el-tooltip :content="tooltipText" placement="top">
    <el-button
      type="primary"
      @click="handleClick"
      :icon="Check"
      :loading="gitStore.isLoadingStatus"
      :disabled="isDisabled"
      :class="['commit-button', `from-${from}`]"
    >
      {{ $t('@76A11:提交') }}
      <span v-if="stagedFilesCount > 0">({{ stagedFilesCount }})</span>
    </el-button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.commit-button {
  &.from-drawer {
    padding: 6px var(--spacing-md);
    font-size: 12px;
    height: 32px;
  }
  
  &.from-status {
    padding: var(--spacing-base);
    font-size: 13px;
    height: 36px;
  }
  
  &.from-form {
    padding: 10px var(--spacing-lg);
    font-size: 14px;
    height: 40px;
  }
}
</style>
