<script setup lang="ts">
import { $t } from '@/lang/static'
import { useGitStore } from '@stores/gitStore'
import { computed } from 'vue'
import { Delete } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import IconButton from '@components/IconButton.vue'

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
      `${$t('@76872:确定要重置当前分支 "')}${gitStore.currentBranch}${$t('@76872:" 到远程状态吗？这将丢失所有未推送的提交和本地更改。')}`,
      $t('@76872:重置到远程分支'),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
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
    :tooltip="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:重置到远程')"
    size="large"
    hover-color="#f56c6c"
    :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles || gitStore.isResetting"
    @click="resetToRemote"
  >
    <el-icon><Delete /></el-icon>
  </IconButton>

  <el-tooltip
    v-else
    :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git reset --hard origin/branch'"
    placement="top"
  >
    <el-button
      type="danger"
      :icon="Delete"
      @click="resetToRemote"
      :loading="gitStore.isResetting"
      :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles"
      class="action-button danger-button"
    >
      {{ $t('@76872:重置到远程') }}
    </el-button>
  </el-tooltip>
  </template>
</template>
