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
import { computed, ref } from 'vue'
import { Upload, ArrowDown } from '@element-plus/icons-vue'
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

// ── 多远程：下拉切换推送目标 ────────────────────────────────────────────
// 仅当仓库配置了多个远程时才出现下拉,单远程/无远程保持原有按钮外观不变。
// 主按钮逻辑完全不动(裸 push 走当前分支上游),多远程只是多给一个显式选择入口。
const sortedRemotes = computed(() => {
  // 上游排第一,其余按名称排序,让最常用的目标在触手可及的位置
  return [...gitStore.remotes].sort((a, b) => {
    if (a.isUpstream !== b.isUpstream) return a.isUpstream ? -1 : 1
    return a.name.localeCompare(b.name)
  })
})

async function handleDropdownCommand(command: string) {
  if (command === 'manage') {
    gitStore.isRemoteManagerVisible = true
    return
  }
  if (command === 'push-all') {
    await gitStore.pushAllRemotes()
    return
  }
  if (!command.startsWith('push:')) return

  // 指定远程推送:复用与主按钮完全相同的进度弹窗链路,只是多传一个 remote
  const remote = command.slice('push:'.length)
  emit('beforePush')
  try {
    progressModalVisible.value = true
    progressModalRef.value?.reset()
    const result = await gitStore.pushToRemoteWithProgress((data) => {
      progressModalRef.value?.handleProgress(data)
    }, remote)
    emit('afterPush', result)
  } catch (error) {
    console.error('推送失败:', error)
    emit('afterPush', false)
  }
}
</script>

<template>
  <div>
    <div class="push-button-group">
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

      <!-- 多远程下拉：仅在配置了多个远程时出现，单远程外观与历史完全一致 -->
      <el-dropdown
        v-if="gitStore.hasMultipleRemotes"
        trigger="click"
        placement="top-end"
        @command="handleDropdownCommand"
      >
        <el-button
          type="primary"
          :icon="ArrowDown"
          :style="buttonStyle"
          :class="['push-button__caret', `from-${from}`]"
          :aria-label="$t('@F4137:更多推送选项')"
        />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="r in sortedRemotes"
              :key="r.name"
              :command="`push:${r.name}`"
            >
              <span class="push-remote-item">
                <span>{{ $t('@F4137:推送到') }} {{ r.name }}</span>
                <el-tag v-if="r.isUpstream" size="small" type="success" effect="plain">
                  {{ $t('@F4137:上游') }}
                </el-tag>
              </span>
            </el-dropdown-item>
            <el-dropdown-item divided command="push-all">
              {{ $t('@F4137:推送到全部远程') }}
            </el-dropdown-item>
            <el-dropdown-item divided command="manage">
              {{ $t('@F4137:管理远程…') }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 推送进度弹窗 -->
    <PushProgressModal
      ref="progressModalRef"
      v-model="progressModalVisible"
      @complete="handleProgressComplete"
    />
  </div>
</template>

<style scoped lang="scss">
.push-button-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.push-remote-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.push-button {
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

/* 下拉触发器：与主按钮等高、紧贴其右侧 */
.push-button__caret {
  &.from-drawer,
  &.from-form {
    height: 32px;
    padding: 0 6px;
  }

  &.from-status {
    height: 36px;
    padding: 0 6px;
  }

  :deep(.el-icon) {
    font-size: 12px;
  }
}
</style>
