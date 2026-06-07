<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<script setup lang="ts">
import { $t } from '@/lang/static'
import { computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { useConfigStore } from '@stores/configStore'
import { Plus } from '@element-plus/icons-vue'

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

// 是否处于"按勾选暂存"模式：选择模式开启 + 有至少一个可被暂存的勾选文件
const isSelectiveStage = computed(() =>
  gitStore.isSelectionMode && gitStore.hasSelectableFiles
)

// 勾选且可暂存的文件数量（显示在按钮上）
const selectedStageCount = computed(() => gitStore.selectedUnstagedPaths.length)

// 计算按钮禁用状态
const isDisabled = computed(() => {
  // 选择模式下：以"是否有可暂存的勾选文件"为准；无勾选且仍有未暂存变更时也允许兜底暂存
  if (gitStore.isSelectionMode) {
    return selectedStageCount.value === 0
  }
  return !hasUnstagedChanges.value
})

// 计算提示文本
const tooltipText = computed(() => {
  if (isSelectiveStage.value) {
    return `${$t('@29974:暂存所选 ')}${selectedStageCount.value}${$t('@29974: 个文件')}`
  }

  if (!hasUnstagedChanges.value) {
    return $t('@29974:没有需要暂存的更改')
  }

  const hasMatches = hasLockedFileMatches()
  if (hasMatches) {
    return `${$t('@29974:暂存')}${unstagedFilesCount.value}${$t('@29974:个未暂存文件（逐个添加）')}`
  } else {
    return `${$t('@29974:暂存所有更改（git add .）')}`
  }
})

// 处理点击事件
async function handleClick() {
  emit('click')
  try {
    // 选择模式 + 有可暂存勾选：只暂存勾选项（批量一次提交，避免 index.lock）
    if (isSelectiveStage.value) {
      await gitStore.stageFiles(gitStore.selectedUnstagedPaths)
      return
    }

    // 选择模式但没有可暂存的勾选：什么都不做（按钮已被禁用，兜底）
    if (gitStore.isSelectionMode) {
      return
    }

    const hasMatches = hasLockedFileMatches()
    if (hasMatches) {
      // 有锁定文件匹配，使用原有的逐个添加逻辑
      await gitStore.addToStage()
    } else {
      // 没有锁定文件匹配，直接使用 git add .
      await gitStore.addAllToStage()
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
      :icon="Plus"
      @click="handleClick"
      :loading="gitStore.isAddingFiles"
      :disabled="isDisabled"
      :class="['stage-button', `from-${from}`, { 'is-selective': isSelectiveStage }]"
    >
      {{
        isSelectiveStage
          ? $t('@29974:暂存所选')
          : $t('@29974:暂存')
      }}
      <span v-if="isSelectiveStage">({{ selectedStageCount }})</span>
      <span v-else-if="unstagedFilesCount > 0">({{ unstagedFilesCount }})</span>
    </el-button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.stage-button {
  &.from-drawer {
    padding: 6px var(--spacing-md);
    font-size: var(--font-size-sm);
    height: 32px;
  }

  &.from-status {
    padding: var(--spacing-base);
    font-size: var(--font-size-sm);
    height: 36px;
  }

  &.from-form {
    font-size: 13px;
    height: 32px;
  }

  // 选择模式下有可暂存勾选文件时，凸显"将只暂存勾选项"
  &.is-selective {
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.35);
  }
}
</style>
