<script setup lang="ts">
import { computed } from 'vue'
import { Upload } from '@element-plus/icons-vue'
import { useGitStore } from '@stores/gitStore'

interface Props {
  from?: 'form' | 'drawer' | 'status'
}

withDefaults(defineProps<Props>(), {
  from: 'form'
})

const emit = defineEmits<{
  click: []
  beforePush: []
  afterPush: [success: boolean]
}>()

const gitStore = useGitStore()

// 计算是否需要推送
const needsPush = computed(() => {
  return gitStore.branchAhead > 0
})

// 计算是否有已暂存的更改
const hasStagedChanges = computed(() => {
  return gitStore.fileList.some(file => file.type === 'added')
})

// 计算是否可以推送
const canPush = computed(() => {
  // 1. 如果分支有上游并且领先提交，可以推送
  // 2. 如果有已暂存的更改但未提交，不能推送
  // 3. 如果有已提交未推送的更改，可以推送
  return gitStore.hasUpstream && needsPush.value && !hasStagedChanges.value
})

// 计算按钮禁用状态
const isDisabled = computed(() => {
  return !canPush.value
})

// 计算提示文本
const tooltipText = computed(() => {
  if (!gitStore.hasUpstream) {
    return '当前分支没有上游分支'
  }
  if (!needsPush.value) {
    return '没有需要推送的提交'
  }
  if (hasStagedChanges.value) {
    return '有未提交的暂存更改，请先提交'
  }
  return `推送${gitStore.branchAhead}个本地提交`
})

// 计算按钮样式
const buttonStyle = computed(() => {
  return canPush.value ? { backgroundColor: '#67c23a', borderColor: '#67c23a' } : {}
})

// 处理点击事件
async function handleClick() {
  emit('beforePush')
  emit('click')

  try {
    const result = await gitStore.pushToRemote()
    
    if (result) {
      // pushToRemote已经刷新了分支状态，这里稍等一下确保状态传播
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    
    emit('afterPush', result)
  } catch (error) {
    console.error('推送失败:', error)
    emit('afterPush', false)
  }
}
</script>

<template>
  <el-tooltip :content="tooltipText" placement="top" effect="light" popper-class="git-cmd-tooltip" :open-delay="200">
    <el-button
      type="primary"
      :icon="Upload"
      @click="handleClick"
      :loading="gitStore.isPushing"
      :disabled="isDisabled"
      :style="buttonStyle"
      :class="['push-button', `from-${from}`]"
    >
      推送
      <span v-if="needsPush">({{ gitStore.branchAhead }})</span>
    </el-button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.push-button {
  &.from-drawer {
    padding: 6px 12px;
    font-size: 12px;
    height: 32px;
  }
  
  &.from-status {
    padding: 8px 14px;
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
