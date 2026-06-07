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
import { useGitStore } from '@stores/gitStore'
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import IconButton from '@components/IconButton.vue'
import SvgIcon from '@components/SvgIcon/index.vue'

interface Props {
  variant?: 'icon' | 'text'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

const shouldShowReset = computed(() => {
  // 工作区无任何变更时不显示；如果本地有未推送提交（ahead）也允许显示
  return gitStore.fileList.length > 0 || gitStore.branchAhead > 0
})

async function resetToRemote() {
  try {
    await ElMessageBox.confirm(
      $t('@76872:确定要重置当前分支吗？', { branch: gitStore.currentBranch || 'unknown' }),
      $t('@76872:重置到远程') + (gitStore.currentBranch ? ` origin/${gitStore.currentBranch}` : ''),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
        confirmButtonClass: 'el-button--danger',
        dangerouslyUseHTMLString: true,
        type: 'warning'
      }
    )

    const result = await gitStore.resetToRemote(gitStore.currentBranch)
    if (result) {
      gitStore.fetchStatus()
      gitStore.fetchLog()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('重置到远程失败:', error)
    }
  }
}
</script>

<template>
  <template v-if="shouldShowReset">
  <IconButton
    v-if="props.variant === 'icon'"
    icon-class="git-reset"
    :tooltip="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:重置到远程')"
    size="medium"
    hover-color="#f56c6c"
    :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles || gitStore.isResetting"
    @click="resetToRemote"
  />

  <el-tooltip
    v-else
    :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git reset --hard origin/branch'"
    placement="top"
  >
    <el-button
      type="danger"
      @click="resetToRemote"
      :loading="gitStore.isResetting"
      :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles"
      class="action-button danger-button"
    >
      <svg-icon icon-class="git-reset" class-name="git-reset-icon" />
      {{ $t('@76872:重置到远程') }}
    </el-button>
  </el-tooltip>
  </template>
</template>

<style scoped lang="scss">
:deep(.git-reset-icon) {
  width: 1em;
  height: 1em;
  vertical-align: middle;
  margin-right: 4px;
}
</style>
