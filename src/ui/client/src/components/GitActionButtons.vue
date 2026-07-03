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
import { ref } from 'vue'
import StageButton from '@/components/buttons/StageButton.vue'
import CommitButton from '@/components/buttons/CommitButton.vue'
import PushButton from '@/components/buttons/PushButton.vue'
import QuickPushButton from '@/components/buttons/QuickPushButton.vue'
import QuickCommitButton from '@/components/buttons/QuickCommitButton.vue'

interface Props {
  hasUserCommitMessage?: boolean
  finalCommitMessage?: string
  skipHooks?: boolean
  from?: 'form' | 'drawer'
}

withDefaults(defineProps<Props>(), {
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false,
  from: 'form'
})

const emit = defineEmits<{
  afterCommit: [success: boolean]
  afterPush: [success: boolean]
  beforePush: []
  pushStart: []
  clearFields: []
}>()

const quickPushRef = ref<InstanceType<typeof QuickPushButton> | null>(null)

// 处理提交后的事件
function handleAfterCommit(success: boolean) {
  emit('afterCommit', success)
}

// 处理推送后的事件  
function handleAfterPush(success: boolean) {
  emit('afterPush', success)
}

// 处理推送前的事件
function handleBeforePush() {
  emit('beforePush')
}

// 处理推送开始事件
function handlePushStart() {
  emit('pushStart')
}

// 处理清空字段的事件
function handleClearFields() {
  emit('clearFields')
}

async function triggerQuickPush() {
  return quickPushRef.value?.triggerQuickPush()
}

defineExpose({
  triggerQuickPush
})
</script>

<template>
  <div class="form-bottom-actions">
    <div class="actions-flex-container">
      <div class="left-actions">
        <div class="button-grid">
          <StageButton
            @click="() => {}"
            :from="from"
          />
          
          <CommitButton
            :has-user-commit-message="hasUserCommitMessage"
            :final-commit-message="finalCommitMessage"
            :skip-hooks="skipHooks"
            @before-commit="() => {}"
            @after-commit="handleAfterCommit"
            @click="() => {}"
            :from="from"
          />
          
          <PushButton
            @before-push="() => {}"
            @after-push="handleAfterPush"
            @click="() => {}"
            :from="from"
          />
        </div>
      </div>
      
      <div class="right-actions">
        <QuickCommitButton 
          :from="from"
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          @after-commit="handleAfterCommit"
          @clear-fields="handleClearFields"
        />
        <QuickPushButton 
          ref="quickPushRef"
          :from="from"
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          @before-push="handleBeforePush"
          @push-start="handlePushStart"
          @after-push="handleAfterPush"
          @clear-fields="handleClearFields"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">

:deep(.el-button) {
  border-radius: var(--radius-md);
  font-weight: 500;
  transition: all 0.3s ease;
  padding: 6px 10px;
  font-size: var(--font-size-sm);

  &:hover {
    transform: scale(1.02);
    box-shadow: var(--shadow-md);
  }

  &:active {
    transform: scale(0.98);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }

  &.is-disabled {
    opacity: 0.4 !important;
  }
}

:deep(.el-button--primary) {
  background: var(--color-primary);
  border: none;
  color: white;

  &.is-disabled {
    background-color: var(--color-primary-light) !important;
    border-color: var(--color-primary-light) !important;
    opacity: 0.5 !important;
  }
}

:deep(.el-button--warning) {
  background: var(--color-warning);
  border: none;
  color: white;

  &.is-disabled {
    background-color: var(--color-warning) !important;
    border-color: var(--color-warning) !important;
    opacity: 0.5 !important;
  }
}

/* .form-bottom-actions:hover {
  box-shadow: var(--shadow-lg);
} */

.actions-flex-container {
  display: flex;
  gap: 6px;
  align-items: center;
  /* 不要 space-between —— 那会让"基础三件套"和"组合快捷方式"两组之间
     出现比组内 gap 大很多的空隙,视觉上像是按钮之间多了一段空白。
     改用 flex-start + right-actions 用 margin-left: auto 把自己推右边,
     中间间距等于容器剩余空间,看起来更自然。 */
  justify-content: flex-start;
}

.left-actions {
  display: flex;
  align-self: center;
}

.button-grid {
  display: flex;
  gap: 6px;
}

.right-actions {
  display: flex;
  align-items: stretch;
  gap: 6px;
  height: 36px;
  margin-left: auto;
}

</style>
