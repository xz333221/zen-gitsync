<script setup lang="ts">
import { $t } from '@/lang/static'
import { useGitStore } from '@stores/gitStore'
import { computed } from 'vue'
import { DeleteFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import IconButton from '@components/IconButton.vue'

interface Props {
  variant?: 'icon' | 'text'
  size?: 'small' | 'medium' | 'large'
  // 传入时切换为"清除所选"模式：tooltip / 确认弹窗 / 行为都改为只重置 selectedFiles
  selectedFiles?: string[]
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon',
  size: 'large',
  selectedFiles: () => []
})

const gitStore = useGitStore()

// 是否处于"清除所选"模式（传入了非空的 selectedFiles）
const isSelectiveMode = computed(() => Array.isArray(props.selectedFiles) && props.selectedFiles.length > 0)
const selectedCount = computed(() => props.selectedFiles?.length ?? 0)

const shouldShowDiscard = computed(() => {
  // 任何文件变更（包括未跟踪）就显示
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

async function discardSelectedChanges() {
  const paths = props.selectedFiles ?? []
  if (paths.length === 0) return
  try {
    await ElMessageBox.confirm(
      $t('@76872:确定要清除所选的 {count} 个文件吗？', { count: paths.length }),
      $t('@76872:清除所选文件'),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
        confirmButtonClass: 'el-button--danger',
        dangerouslyUseHTMLString: true,
        type: 'warning'
      }
    )

    const result = await gitStore.discardSelectedFiles(paths)
    if (result) {
      gitStore.fetchStatus()
      gitStore.fetchLog()
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('清除所选文件失败:', error)
    }
  }
}
</script>

<template>
  <template v-if="shouldShowDiscard">
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="isSelectiveMode
        ? $t('@76872:清除所选 {count} 个文件', { count: selectedCount })
        : $t('@76872:清除所有本地更改')"
      :size="props.size"
      hover-color="#f56c6c"
      :disabled="gitStore.isResetting"
      @click="isSelectiveMode ? discardSelectedChanges() : discardAllChanges()"
    >
      <el-icon><DeleteFilled /></el-icon>
    </IconButton>

    <el-tooltip
      v-else
      :content="isSelectiveMode
        ? $t('@76872:对所选文件执行 git checkout / git clean')
        : 'git reset --hard && git clean -fd'"
      placement="top"
    >
      <el-button
        type="danger"
        :icon="DeleteFilled"
        @click="isSelectiveMode ? discardSelectedChanges() : discardAllChanges()"
        :loading="gitStore.isResetting"
        class="action-button danger-button"
      >
        {{
          isSelectiveMode
            ? $t('@76872:清除所选 {count} 个文件', { count: selectedCount })
            : $t('@76872:清除所有本地更改')
        }}
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
