<script setup lang="ts">
import { computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { RefreshLeft } from '@element-plus/icons-vue'
import IconButton from '@components/IconButton.vue'

interface Props {
  from?: 'form' | 'drawer' | 'status'
}

const props = withDefaults(defineProps<Props>(), {
  from: 'form'
})

const emit = defineEmits<{
  click: []
}>()

const gitStore = useGitStore()

// 计算已暂存文件数量
const stagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file =>
    ['staged', 'renamed', 'added'].includes(file.type)
  ).length
})

// 计算是否有已暂存的更改
const hasStagedChanges = computed(() => {
  return stagedFilesCount.value > 0
})

// 计算按钮禁用状态
const isDisabled = computed(() => {
  return !hasStagedChanges.value
})

// 计算提示文本
const tooltipText = computed(() => {
  if (!hasStagedChanges.value) {
    return '没有已暂存的更改'
  }
  return '取消暂存所有文件（git reset HEAD）'
})

// 处理点击事件
async function handleClick() {
  emit('click')
  try {
    const result = await gitStore.resetHead()
    if (result) {
      // 触发状态更新事件
      gitStore.fetchStatus()
    }
  } catch (error) {
    console.error('取消暂存失败:', error)
  }
}
</script>

<template>
  <div class="unstage-all-button" v-if="hasStagedChanges">
    <!-- 图标按钮模式 (from === 'status') -->
    <IconButton
      v-if="props.from === 'status'"
      :tooltip="tooltipText"
      size="large"
      :disabled="isDisabled"
      :loading="gitStore.isResetting"
      hover-color="var(--color-warning)"
      @click="handleClick"
    >
      <el-icon><RefreshLeft /></el-icon>
    </IconButton>
    
    <!-- 文字按钮模式 (from !== 'status') -->
    <el-tooltip v-else :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="warning"
        @click="handleClick"
        :loading="gitStore.isResetting"
        :disabled="isDisabled"
        :class="`from-${props.from}`"
      >
        取消暂存所有
        <span v-if="stagedFilesCount > 0">({{ stagedFilesCount }})</span>
      </el-button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
// 文字按钮模式的样式
.unstage-all-button {
  :deep(.el-button.from-drawer) {
    padding: 6px var(--spacing-md);
    font-size: var(--font-size-sm);
    height: 32px;
  }
  
  :deep(.el-button.from-form) {
    padding: 10px var(--spacing-lg);
    height: 40px;
  }
}
</style>
