<script setup lang="ts">
import { $t } from '@/lang/static'
import { computed, ref } from 'vue'
import { Upload } from '@element-plus/icons-vue'
import { useGitStore } from '@stores/gitStore'
import PushProgressModal from '@components/PushProgressModal.vue'

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

// 进度弹窗
const progressModalVisible = ref(false)
const progressModalRef = ref<InstanceType<typeof PushProgressModal> | null>(null)

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
  // 如果有冲突文件，不能推送
  if (gitStore.hasConflictedFiles) {
    return false
  }
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
  if (gitStore.hasConflictedFiles) {
    return $t('@F4137:存在冲突文件，请先解决冲突')
  }
  if (!gitStore.hasUpstream) {
    return $t('@F4137:当前分支没有上游分支')
  }
  if (!needsPush.value) {
    return $t('@F4137:没有需要推送的提交')
  }
  if (hasStagedChanges.value) {
    return $t('@F4137:有未提交的暂存更改，请先提交')
  }
  return `${$t('@F4137:推送')}${gitStore.branchAhead}${$t('@F4137:个本地提交')}`
})

// 计算按钮样式
const buttonStyle = computed(() => {
  return canPush.value ? { backgroundColor: 'var(--color-success)', borderColor: 'var(--color-success)' } : {}
})

// 处理点击事件
async function handleClick() {
  emit('beforePush')
  emit('click')

  try {
    // 显示进度弹窗
    progressModalVisible.value = true
    
    // 重置进度状态
    if (progressModalRef.value) {
      progressModalRef.value.reset()
    }
    
    // 使用带进度的推送方法
    const result = await gitStore.pushToRemoteWithProgress((data) => {
      // 处理进度数据
      if (progressModalRef.value) {
        progressModalRef.value.handleProgress(data)
      }
    })
    
    if (result) {
      // pushToRemoteWithProgress已经刷新了分支状态，这里稍等一下确保状态传播
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    
    emit('afterPush', result)
  } catch (error) {
    console.error('推送失败:', error)
    emit('afterPush', false)
  }
}

// 处理进度完成
function handleProgressComplete(_success: boolean) {
  // 可以在这里添加额外的完成处理逻辑
}
</script>

<template>
  <div>
    <el-tooltip :content="tooltipText" placement="top">
      <el-button
        type="primary"
        :icon="Upload"
        @click="handleClick"
        :loading="gitStore.isPushing"
        :disabled="isDisabled"
        :style="buttonStyle"
        :class="['push-button', `from-${from}`]"
      >
        {{ $t('@F4137:推送') }}
        <span v-if="needsPush">({{ gitStore.branchAhead }})</span>
      </el-button>
    </el-tooltip>
    
    <!-- 推送进度弹窗 -->
    <PushProgressModal
      ref="progressModalRef"
      v-model="progressModalVisible"
      @complete="handleProgressComplete"
    />
  </div>
</template>

<style scoped lang="scss">
.push-button {
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
