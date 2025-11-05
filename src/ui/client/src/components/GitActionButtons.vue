<script setup lang="ts">
import StageButton from '@/components/buttons/StageButton.vue'
import CommitButton from '@/components/buttons/CommitButton.vue'
import PushButton from '@/components/buttons/PushButton.vue'
import QuickPushButton from '@/components/buttons/QuickPushButton.vue'

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
  clearFields: []
}>()

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

// 处理清空字段的事件
function handleClearFields() {
  emit('clearFields')
}
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
        <QuickPushButton 
          :from="from"
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          @before-push="handleBeforePush"
          @after-push="handleAfterPush"
          @clear-fields="handleClearFields"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.form-bottom-actions {
}

.form-bottom-actions:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
}

.actions-flex-container {
  display: flex;
  // gap: 16px;
  align-items: center;
  justify-content: space-between;
}

.button-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  align-items: stretch;
}

.right-actions {
  min-width: 160px;
  display: flex;
  align-items: stretch;
}

</style>
