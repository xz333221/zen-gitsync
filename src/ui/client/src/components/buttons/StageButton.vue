<script setup lang="ts">
import { computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'

interface Props {
  from?: 'form' | 'drawer' | 'status'
}

withDefaults(defineProps<Props>(), {
  from: 'form'
})

const emit = defineEmits<{
  click: []
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

// 检查是否有文件匹配锁定列表
function hasLockedFileMatches(): boolean {
  if (configStore.lockedFiles.length === 0) {
    return false
  }
  
  return gitStore.fileList.some(file => {
    if (!['modified', 'deleted', 'untracked'].includes(file.type)) {
      return false
    }
    return isFileLocked(file.path)
  })
}

// 计算未暂存文件数量（排除锁定文件）
const unstagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file =>
    ['modified', 'deleted', 'untracked'].includes(file.type) &&
    !isFileLocked(file.path)
  ).length
})

// 计算是否有未暂存的更改
const hasUnstagedChanges = computed(() => {
  return gitStore.fileList.some(file =>
    ['modified', 'deleted', 'untracked'].includes(file.type) &&
    !isFileLocked(file.path)
  )
})

// 计算按钮禁用状态
const isDisabled = computed(() => {
  return !hasUnstagedChanges.value
})

// 计算提示文本
const tooltipText = computed(() => {
  if (!hasUnstagedChanges.value) {
    return '没有需要暂存的更改'
  }
  
  const hasMatches = hasLockedFileMatches()
  if (hasMatches) {
    return `暂存${unstagedFilesCount.value}个未暂存文件（逐个添加）`
  } else {
    return `暂存所有更改（git add .）`
  }
})

// 处理点击事件
async function handleClick() {
  emit('click')
  try {
    let result
    const hasMatches = hasLockedFileMatches()
    
    if (hasMatches) {
      // 有锁定文件匹配，使用原有的逐个添加逻辑
      result = await gitStore.addToStage()
    } else {
      // 没有锁定文件匹配，直接使用 git add .
      result = await gitStore.addAllToStage()
    }
    
    if (result) {
      // 触发状态更新事件
      gitStore.fetchStatus()
    }
  } catch (error) {
    console.error('添加文件失败:', error)
  }
}
</script>

<template>
  <el-tooltip :content="tooltipText" placement="top">
    <el-button
      type="primary"
      @click="handleClick"
      :loading="gitStore.isAddingFiles"
      :disabled="isDisabled"
      :class="['stage-button', `from-${from}`]"
    >
      暂存更改
      <span v-if="unstagedFilesCount > 0">({{ unstagedFilesCount }})</span>
    </el-button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.stage-button {
  &.from-drawer {
    padding: 6px 12px;
    font-size: 12px;
    height: 32px;
  }
  
  &.from-status {
    padding: 8px;
    font-size: 13px;
    height: 36px;
  }
  
  &.from-form {
    padding: 10px 16px;
    font-size: 14px;
    height: 40px;
  }
}
</style>
