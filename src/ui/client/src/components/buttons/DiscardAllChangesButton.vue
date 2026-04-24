<script setup lang="ts">
import { $t } from '@/lang/static'
import { useGitStore } from '@stores/gitStore'
import { computed } from 'vue'
import { DeleteFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import IconButton from '@components/IconButton.vue'

interface Props {
  variant?: 'icon' | 'text'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const gitStore = useGitStore()

const shouldShowDiscard = computed(() => {
  // 如果有任何文件变更（包括未跟踪），就显示
  return gitStore.fileList.length > 0
})

async function discardAllChanges() {
  try {
    await ElMessageBox.confirm(
      $t('@76872:确定要清除本地所有更改吗？'),
      $t('@76872:清除所有本地更改'),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
        confirmButtonClass: 'el-button--danger',
        dangerouslyUseHTMLString: true,
        type: 'warning'
      }
    )

    const result = await gitStore.discardAllChanges()
    if (result) {
      gitStore.fetchStatus()
      gitStore.fetchLog()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('清除本地更改失败:', error)
    }
  }
}
</script>

<template>
  <template v-if="shouldShowDiscard">
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="$t('@76872:清除所有本地更改')"
      size="large"
      hover-color="#f56c6c"
      :disabled="gitStore.isResetting"
      @click="discardAllChanges"
    >
      <el-icon><DeleteFilled /></el-icon>
    </IconButton>

    <el-tooltip
      v-else
      :content="'git reset --hard && git clean -fd'"
      placement="top"
    >
      <el-button
        type="danger"
        :icon="DeleteFilled"
        @click="discardAllChanges"
        :loading="gitStore.isResetting"
        class="action-button danger-button"
      >
        {{ $t('@76872:清除所有本地更改') }}
      </el-button>
    </el-tooltip>
  </template>
</template>

<style scoped lang="scss">
.danger-button {
  background-color: var(--el-color-danger);
  border-color: var(--el-color-danger);
  
  &:hover {
    background-color: var(--el-color-danger-light-3);
    border-color: var(--el-color-danger-light-3);
  }
}
</style>
