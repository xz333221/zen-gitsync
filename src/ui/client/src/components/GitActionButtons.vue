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
import AiQuickPushButton from '@/components/buttons/AiQuickPushButton.vue'

interface Props {
  hasUserCommitMessage?: boolean
  finalCommitMessage?: string
  skipHooks?: boolean
  from?: 'form' | 'drawer'
  // AI 生成提交信息的进行中状态（由父组件持有，按钮只负责显示 loading）
  aiGenerating?: boolean
}

withDefaults(defineProps<Props>(), {
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false,
  from: 'form',
  aiGenerating: false
})

const emit = defineEmits<{
  afterCommit: [success: boolean]
  afterPush: [success: boolean]
  beforePush: []
  pushStart: []
  clearFields: []
  aiQuickPush: []
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

// AI 提交并推送：生成逻辑在父组件（CommitForm 持有提交表单状态），
// 这里只把点击透上去
function handleAiQuickPush() {
  emit('aiQuickPush')
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
        <AiQuickPushButton
          :from="from"
          :generating="aiGenerating"
          @trigger="handleAiQuickPush"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">

// 覆盖 element-plus 默认 .el-button + .el-button { margin-left: 12px }
// 那个兄弟选择器在每个按钮之间强加 12px,会覆盖我们的 flex gap,导致
// "暂存 → 提交"之间实际是 18px(12 + 6),而不是预期的 6px
:deep(.el-button + .el-button) {
  margin-left: 0;
}

:deep(.el-button) {
  border-radius: var(--radius-md);
  font-weight: 500;
  transition: var(--transition-ui-slow);
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
    outline: var(--focus-outline);
    outline-offset: 2px;
  }

  &.is-disabled {
    opacity: var(--disabled-opacity)!important;
  }
}

:deep(.el-button--primary) {
  background: var(--color-primary);
  border: none;
  color: white;

  &.is-disabled {
    background-color: var(--color-primary-light) !important;
    border-color: var(--color-primary-light) !important;
    opacity: var(--disabled-opacity)!important;
  }
}

:deep(.el-button--warning) {
  background: var(--color-warning);
  border: none;
  color: white;

  &.is-disabled {
    background-color: var(--color-warning) !important;
    border-color: var(--color-warning) !important;
    opacity: var(--disabled-opacity)!important;
  }
}

/* ── 动作区三档层级 ────────────────────────────────────────────────
   改前：5 个按钮全是实心色块（暂存/提交/推送 = 主色，一键提交/一键推送所有 =
   两种深蓝渐变），主次不分，扫视时不知道从哪个开始。
   改后（2026-10-04 再调一次口径：原稿写的"主色浅底 + 描边"与实现不符，
   QuickPushButton 实际是纯 --color-primary-dark 实心，下面的描述已按实现改）：
     一档 一键提交        —— 最重的一档，--color-primary-dark 实心（见 QuickCommitButton.vue）
     二档 一键推送所有    —— --color-primary 实心（见 QuickPushButton.vue）
     二档 AI 提交并推送   —— 同二档，靠 AI 图标区分（见 AiQuickPushButton.vue）。
                             原来这里是紫罗兰渐变，属 PRODUCT.md:34 明令禁的
                             "AI purple"，且紫色在仓库里已有 --color-think /
                             --color-info-light / --git-status-untracked 三重身份。
     三档 暂存 / 提交 / 推送 —— 中性描边，保留逐步显式控制
   改完后整个动作区只有两个色值：一档 primary-dark、二档 primary、三档中性描边。
   层级靠明度，不靠色相。只改视觉权重，不动任何按钮的功能与位置。 */
:deep(.left-actions .el-button) {
  background: var(--bg-container);
  border: 1px solid var(--border-color-medium);
  color: var(--text-secondary);
  box-shadow: none;
}

:deep(.left-actions .el-button:hover:not(.is-disabled)) {
  background: var(--soft-btn-bg-hover);
  border-color: var(--soft-btn-border-hover);
  /* 悬停只换底面与描边，文字色不动：
     主色正文在浅底上只有 ~3.3:1，切色会掉到 AA 以下 */
}

/* 三档按钮禁用时保持描边形态，避免退回实心主色块（.el-button--primary 的禁用规则） */
:deep(.left-actions .el-button--primary.is-disabled) {
  background-color: var(--bg-container) !important;
  border-color: var(--border-color-medium) !important;
  color: var(--text-disabled) !important;
  opacity: var(--disabled-opacity)!important;
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
