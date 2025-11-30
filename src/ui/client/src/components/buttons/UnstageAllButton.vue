<script setup lang="ts">
import { computed } from 'vue'
import { useGitStore } from '@stores/gitStore'
import { RefreshLeft } from '@element-plus/icons-vue'

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
    <el-tooltip :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="warning"
        @click="handleClick"
        :loading="gitStore.isResetting"
        :disabled="isDisabled"
        :circle="props.from === 'status'"
        :size="props.from === 'status' ? 'small' : 'default'"
        :class="props.from === 'status' ? '' : `from-${props.from}`"
      >
        <el-icon v-if="props.from === 'status'"><RefreshLeft /></el-icon>
        <template v-else>
          取消暂存所有
          <span v-if="stagedFilesCount > 0">({{ stagedFilesCount }})</span>
        </template>
      </el-button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
.unstage-all-button {
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
