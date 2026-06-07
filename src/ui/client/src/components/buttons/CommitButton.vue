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
  // 如果正在提交，禁用按钮
  if (gitStore.isCommiting) {
    return true
  }
  // MERGING 状态：只需要有提交信息即可提交
  if (gitStore.isMergeInProgress) {
    return !props.hasUserCommitMessage
  }
  return !hasStagedChanges.value || !props.hasUserCommitMessage
})

// 计算提示文本
const tooltipText = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return $t('@76A11:存在冲突文件，请先解决冲突')
  }
  if (gitStore.isMergeInProgress) {
    return props.hasUserCommitMessage
      ? $t('@76A11:提交并完成合并')
      : $t('@76A11:请输入提交信息')
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
      :loading="gitStore.isCommiting"
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
}
</style>
