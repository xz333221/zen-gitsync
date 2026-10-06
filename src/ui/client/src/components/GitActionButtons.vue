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
  /* 这里原先有一条 &.is-disabled { opacity: var(--disabled-opacity) } —— 2026-10-06 撤掉。
     它给"所有"禁用按钮统一乘一层透明度，但动作区五颗的底色各不同（三颗实心色 +
     两颗中性描边），乘完各塌各的：三颗实心色落到 --color-primary-light 上再加 0.5
     透明度，实测三颗底色**逐位相同** #afd2fc、文字纯白 → 1.56:1。
     禁用态的"淡"改由色值本身表达，见文件末尾"动作区禁用态"那一段。 */
}

:deep(.el-button--primary) {
  background: var(--color-primary);
  border: none;
  color: white;
  /* 禁用态不在这里写：三档按钮各有自己的实心色（primary-dark / role-ai），
     禁用时统一走末尾那套中性底 —— 这样"禁用"这个状态只有一个出处，
     不会出现"某个按钮的禁用色忘了跟着改"。 */
}

:deep(.el-button--warning) {
  background: var(--color-warning);
  border: none;
  color: white;
}

/* ── 动作区三档层级 ────────────────────────────────────────────────
   改前：5 个按钮全是实心色块（暂存/提交/推送 = 主色，一键提交/一键推送所有 =
   两种深蓝渐变），主次不分，扫视时不知道从哪个开始。
   改后（原稿写的"主色浅底 + 描边"与实现不符，QuickPushButton 实际是纯
   --color-primary-dark 实心，下面按实现写）：
     一档 一键提交        —— 最重的一档，--color-primary-dark 实心（见 QuickCommitButton.vue）
     二档 一键推送所有    —— --color-primary 实心（见 QuickPushButton.vue）
     AI 档 AI 提交并推送   —— --role-ai-ink 实心紫（见 AiQuickPushButton.vue）
     三档 暂存 / 提交 / 推送 —— 中性描边，保留逐步显式控制
   2026-10-04 二次调整：AI 档原先被降级成"同二档、靠图标区分"，实测三颗按钮
   变成两档几乎同明度的蓝，横扫过去分不出层级。真正的禁令对象是**渐变**
   （135deg + 发光），不是色相 —— 紫色在仓库里本就是 --color-think 一族的状态色。
   于是动作区现在是三个角色三档：一档 primary-dark、二档 primary、AI 档 role-ai，
   三档描边中性。只改视觉权重，不动任何按钮的功能与位置。
   ⚠️ 2026-10-06 复核：**上面这条"二档 = --color-primary"与实现不一致** ——
   QuickPushButton.vue:287 写的是 `var(--color-primary-dark)`，跟一档 QuickCommitButton
   同色，所以可用态实际只分得出两档（深蓝 ×2 + 紫）。本次只改禁用态，没动它；
   要恢复三档需要先把这条口径和实现对齐（三档得选一个既非 primary-dark 又不与
   role-ai 抢色的档）。 */
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

/* ── 动作区禁用态：五颗按钮一套语言（2026-10-06） ──────────────────
   改前有**两套**，而且各自都不可读：
     · 右侧三档落到 `.el-button--primary.is-disabled` 的 --color-primary-light
       上，再叠一层 --disabled-opacity → 实测三颗底色**逐位相同** #afd2fc
       （= #60a5fa × 0.5 落白底）+ 文字纯白 → WCAG 对比度 **1.56:1**；
       整条按钮带里紫色像素 0 个（AI 档的身份色也一起没了）。
       "三档层级"在禁用态完全消失 —— 而禁用态本来也没有层级可表达。
     · 左侧"暂存/提交/推送"走中性描边 + --text-disabled，然后**又乘一次**
       0.5 → 文字 ≈ #dfe1e5（≈1.2:1），比右侧还看不见。
   改后：统一成一套中性，且**只淡一次**：
     底色 --bg-component-area  浅色 #f9f9f9 / 暗色 rgba(255,255,255,.06)
     描边 transparent          描边是"可点"的 affordance，禁用就去掉它
  ·  文字 --text-meta         浅色 #686a6f ≈ 4.99:1 / 暗色 #cbd0d6（可读）
   **不再叠 --disabled-opacity**：淡由色值本身表达。颜色淡一档已经够表达"关掉"，
   再乘一层透明度只会把文字推到 2:1 以下 —— 上一版左侧就是这么掉到 1.2:1 的。
   实测（1600×900 dev，禁用一个真跑起来的前端，逐颗读 computed style）：
     禁用 4 颗 = rgb(249,249,249) 底 + #686a6f 字 = **5.14:1**、opacity 1、图标不再是白；
     暗色档 rgba(255,255,255,.06) 底 = **7.22:1**；
     可用态没被串：一键提交/一键推送所有 #2563eb + 白字 5.17:1、AI 档 #6d28d9 + 白字 7.1:1。
   顺带把 `:hover` / `:active` 一起列进来：基类的 `&:hover { transform: scale(1.02);
   box-shadow }` 对禁用按钮本来是生效的，只是被 unified-dialogs.scss 里那条全局
   `.el-button.is-disabled:hover { box-shadow: none !important; transform: none !important }`
   顺带压住了（实测 hover 后 transform/box-shadow 都是 none）。这里再写一遍是为了让
   本组件的口径自洽、不依赖另一张表的存在与加载顺序，不是为了修一个当时就存在的 bug。 */
:deep(.el-button.is-disabled),
:deep(.el-button.is-disabled:hover),
:deep(.el-button.is-disabled:active) {
  background-color: var(--bg-component-area) !important;
  border-color: transparent !important;
  color: var(--text-meta) !important;
  opacity: 1 !important;
  box-shadow: none !important;
  transform: none !important;
  cursor: not-allowed;
}

/* 三档按钮把图标/文字**显式**染成了 #fff（EP 把 label 包在 span 里，父级 color
   不保证落到文字节点），AI 档那颗甚至是行内 style。禁用后底色是浅灰，
   白字/白图标就彻底看不见了，所以要把它们收回来跟着按钮的 color 走。
   选择器挂在 .is-disabled 下，可用态一个字都不动。 */
:deep(.el-button.is-disabled .one-commit-icon),
:deep(.el-button.is-disabled .one-commit-title),
:deep(.el-button.is-disabled .one-commit-desc),
:deep(.el-button.is-disabled .one-push-icon),
:deep(.el-button.is-disabled .one-push-title),
:deep(.el-button.is-disabled .one-push-desc),
:deep(.el-button.is-disabled .one-ai-push-icon),
:deep(.el-button.is-disabled .one-ai-push-title),
:deep(.el-button.is-disabled .one-ai-push-desc) {
  color: inherit !important;
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
