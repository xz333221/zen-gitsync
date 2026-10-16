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
import QuickActionsDropdown from '@/components/buttons/QuickActionsDropdown.vue'
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

const quickActionsRef = ref<InstanceType<typeof QuickActionsDropdown> | null>(null)

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
  return quickActionsRef.value?.triggerQuickPush()
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
        <!-- 「一键提交 / 一键推送所有」合并进这一颗下拉（2026-10-16 走查 P2-1），
             动作逻辑与禁用口径在 QuickActionsDropdown 内部的原按钮引擎里，
             不在本层复制；triggerQuickPush 的 expose 链保持原样
             （Enter 键 / AI 提交流程都经它） -->
        <QuickActionsDropdown
          ref="quickActionsRef"
          :from="from"
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          @after-commit="handleAfterCommit"
          @after-push="handleAfterPush"
          @before-push="handleBeforePush"
          @push-start="handlePushStart"
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

/* ── 动作区层级（2026-10-16 走查 P2-1 重构后）───────────────────────
   历史：2026-10-04 定了"三档"（一键提交 primary-dark / 一键推送所有 primary /
   AI 紫），2026-10-06 复核发现前两颗实现同色，实际只分得出"深蓝 ×2 + 紫"；
   加上更早的暂存/提交/推送中性档，一行 6 颗、5 种权重，主次扫不出来（走查实测）。
   现结构（只改视觉权重与组织，功能一个不少）：
     [暂存][提交][推送]        —— 中性描边，逐步显式控制（本文件 .left-actions）
     [提交并推送 ▾]           —— 动作区唯一实心蓝（--color-primary-dark），
                                下拉内收编原「一键提交 / 一键推送所有」
                                （见 QuickActionsDropdown.vue）
     [AI 提交并推送]          —— 降级为紫描边（--role-ai-ink），保留色相身份、
                                不与实心蓝抢主位（见 AiQuickPushButton.vue）
   禁用层（下一段）对这三档的承接关系不变。 */
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

/* ── 动作区禁用态 ──────────────────────────────────────────────────
   2026-10-06 第一版（治"读不出来"）：原先有**两套**、各自都不可读 ——
     · 右侧三档落到 `.el-button--primary.is-disabled` 的 --color-primary-light
       上，再叠一层 --disabled-opacity → 实测三颗底色**逐位相同** #afd2fc
       （= #60a5fa × 0.5 落白底）+ 文字纯白 → WCAG 对比度 **1.56:1**；
       整条按钮带里紫色像素 0 个。
     · 左侧"暂存/提交/推送"走中性描边 + --text-disabled，**又乘一次** 0.5
       → 文字 ≈ #dfe1e5（≈1.2:1），比右侧还看不见。
   第一版把它们统一成一套中性灰，可读性达标了，但用户当天反馈
   **「禁用状态全灰色有点丑」** —— 因为为了治"淡蓝 + 白字"把三档的身份色也一起抹了，
   一行六个灰块、按钮带失去身份。这正是本仓库早就写过的那条：
   **色相是身份，要压的是浓度不是色相**（见 docs/ui-audit/README.md 第二轮）。

   现行口径（两层）：
     ① 表单层（本文件）：禁用 = 去掉"可点"的 affordance + 可读但更淡的文字
        描边 transparent（描边本身是"可点"的信号）
        文字 见 ② 的 --action-disabled-fg（按底分档，两档都 ≥4.5:1）
        **不叠 --disabled-opacity**：淡由色值表达，再乘一层透明度只会把文字
        推到 2:1 以下（第一版之前的左侧就是这么掉到 1.2:1 的）
        顺带把 `:hover` / `:active` 也列进选择器：基类的 `&:hover { transform:
        scale(1.02); box-shadow }` 对禁用按钮本来是生效的，只是被 unified-dialogs.scss
        里那条全局 `.el-button.is-disabled:hover { box-shadow/transform: none !important }`
        顺带压住了（实测 hover 后两者都是 none）。这里再写一遍是为了让本组件的口径自洽、
        不依赖另一张表的存在与加载顺序，不是为了修一个当时就存在的 bug。
     ② 身份层（各档自己声明，见三个 button 组件）：
        --action-disabled-bg   该档身份色的 **wash 档**（一档/二档 --tint-primary-12、
                               AI 档 --role-ai-wash）；没声明 → 落中性 --bg-component-area
                               （左侧"暂存/提交/推送"本来就是中性描边，不参与身份色）
        --action-disabled-fg   **字色按底分档**：wash 底比中性底深，同一个灰在两种底上
                               过不了同一条线 —— 12% 主色 wash 上 #686a6f 只有 3.99:1
                               （实测），所以身份档的字用 --text-secondary（≈4.7:1），
                               中性档继续用更淡的 --text-meta（≈5.1:1，"更淡"正好当 off 信号）
        --action-disabled-icon 该档实心身份色 —— **图标留色、文字压灰**：
                               图标是小色块（见 lessons review-hide-vs-read），
                               彩色小色块别跟彩色文字一起清掉
   ⚠️ wash 的浓度上限是被字色对比度卡住的：14% 主色 wash + --text-meta = 3.99:1（不过 AA）。
   想再加浓必须先换更深的字色，别只调 wash。 */
:deep(.el-button.is-disabled),
:deep(.el-button.is-disabled:hover),
:deep(.el-button.is-disabled:active) {
  /* 各档的身份色 wash；没声明就走中性底（左侧三颗） */
  background-color: var(--action-disabled-bg, var(--bg-component-area)) !important;
  border-color: transparent !important;
  color: var(--action-disabled-fg, var(--text-meta)) !important;
  opacity: 1 !important;
  box-shadow: none !important;
  transform: none !important;
  cursor: not-allowed;
}

/* 图标：跟着各档自己的身份色（--action-disabled-icon），文字另走上面的 --text-meta */
:deep(.el-button.is-disabled .one-commit-icon),
:deep(.el-button.is-disabled .one-push-icon),
:deep(.el-button.is-disabled .one-ai-push-icon) {
  color: var(--action-disabled-icon, var(--text-meta)) !important;
}

/* 三档按钮把标题/副标题**显式**染成了 #fff（EP 把 label 包在 span 里，父级 color
   不保证落到文字节点），AI 档那颗图标甚至是行内 style。禁用后底色是浅的，
   白字/白图标就彻底看不见了，所以要把它们收回来 —— 标题/副标题跟随按钮的
   --text-meta（可读），图标由上一条单独接管身份色。可用态一个字都不动。 */
:deep(.el-button.is-disabled .one-commit-title),
:deep(.el-button.is-disabled .one-commit-desc),
:deep(.el-button.is-disabled .one-push-title),
:deep(.el-button.is-disabled .one-push-desc),
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
