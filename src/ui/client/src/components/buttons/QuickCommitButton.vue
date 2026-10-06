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
import { computed } from "vue";
import { ElTooltip } from "element-plus";
import { Edit } from "@element-plus/icons-vue";
import { $t } from '@/lang/static';
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
import { isFilePathLocked } from "@/utils/fileLock";

const gitStore = useGitStore();
const configStore = useConfigStore();

// 定义组件props
interface Props {
  from?: "form" | "drawer";
  hasUserCommitMessage?: boolean;
  finalCommitMessage?: string;
  skipHooks?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  from: "form",
  hasUserCommitMessage: false,
  finalCommitMessage: "",
  skipHooks: false,
});

// 定义事件
const emit = defineEmits<{
  beforeCommit: [];
  afterCommit: [success: boolean];
  clearFields: [];
}>();

// 计算是否有任何变更
const hasAnyChanges = computed(() => {
  return gitStore.fileList.some((file) => !isFilePathLocked(file.path, configStore.lockedFiles));
});

// 选择模式下是否有可暂存/提交的勾选文件
const hasSelectedToStage = computed(() => {
  return gitStore.isSelectionMode && gitStore.selectedFiles.size > 0
    && gitStore.selectedUnstagedPaths.length > 0
});

// 计算最终的禁用状态
const isDisabled = computed(() => {
  // 如果有冲突文件，禁用
  if (gitStore.hasConflictedFiles) {
    return true;
  }

  // 选择模式开启时：要求至少有一个可暂存的勾选文件
  if (gitStore.isSelectionMode) {
    return !hasSelectedToStage.value || !props.hasUserCommitMessage;
  }

  // 否则按"全部变更"判断
  return (
    !hasAnyChanges.value || !props.hasUserCommitMessage
  );
});

// 计算最终的加载状态
const isLoading = computed(() => {
  return gitStore.isAddingFiles || gitStore.isCommiting;
});

// 计算提示文本
const tooltipText = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return $t('@2E184:存在冲突文件，请先解决冲突');
  }

  if (gitStore.isSelectionMode) {
    if (gitStore.selectedFiles.size === 0) {
      return $t('@2E184:请先勾选要提交的文件');
    }
    if (gitStore.selectedUnstagedPaths.length === 0) {
      return $t('@2E184:所选文件无需暂存或被锁定');
    }
    if (!props.hasUserCommitMessage) {
      return $t('@2E184:请输入提交信息');
    }
    return $t('@2E184:一键完成：仅暂存所选文件 → 提交');
  }

  if (!hasAnyChanges.value) {
    return $t('@2E184:没有需要提交的更改');
  }

  if (!props.hasUserCommitMessage) {
    return $t('@2E184:请输入提交信息');
  }

  return $t('@2E184:一键完成：暂存所有更改 → 提交');
});

// 按钮标题与副标题：随选择模式动态切换
const buttonTitle = computed(() => {
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:一键提交所选')
    : $t('@2E184:一键提交');
});

const buttonDesc = computed(() => {
  if (props.from !== 'form') return '';
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:暂存所选 + 提交')
    : $t('@2E184:暂存 + 提交');
});

// 一键提交处理函数
async function handleQuickCommit() {
  emit("beforeCommit");

  try {
    const commitResult = await gitStore.stageSelectedAndCommit(
      props.finalCommitMessage,
      props.skipHooks
    );

    if (commitResult) {
      emit("clearFields");
    }

    emit("afterCommit", commitResult);
  } catch (error) {
    console.error("一键提交失败:", error);
    emit("afterCommit", false);
  }
}

defineExpose({
  triggerQuickCommit: handleQuickCommit
});
</script>

<template>
  <div>
    <el-tooltip :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="primary"
        @click="handleQuickCommit"
        :loading="isLoading"
        :disabled="isDisabled"
        :class="from"
        class="one-commit-button"
      >
        <div class="one-commit-content">
          <el-icon class="one-commit-icon"><Edit /></el-icon>
          <div class="one-commit-text">
            <span class="one-commit-title">{{ buttonTitle }}</span>
            <span v-if="from === 'form'" class="one-commit-desc">{{ buttonDesc }}</span>
          </div>
        </div>
      </el-button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
.one-commit-button {
  height: 100%;
  /* 一档动作：实心主色（产品核心动作，全场唯一最重的一档）。
     2026-10-04 从「主色渐变」改成纯色：渐变属于 PRODUCT.md:37 禁的装饰性效果，
     而"要最重"这件事靠一个更深的 --color-primary-dark 就够了，不需要靠渐变。
     白字在 --color-primary-dark 上 ≥ 5.2:1（AA 要 4.5:1），保持不变。
     二档（一键推送所有 / AI 提交并推送）用纯 --color-primary，
     于是主次变成"深蓝 vs 中蓝"，全按钮区只有一个色相。 */
  background: var(--color-primary-dark) !important;
  border: none !important;
  color: white !important;
  /* EP 把 label 包在 span 里，父级 color 不保证落到文字节点，显式声明 */
  .one-commit-icon,
  .one-commit-title,
  .one-commit-desc {
    color: #fff;
  }
  /* 禁用态的身份层：底色用**本档身份的 wash 档**（不是中性灰，也不是实心色），
     图标保留实心身份色 —— 一行按钮禁用时仍看得出"哪颗是哪档"。
     表单层（去描边 / 灰字 / 不叠 opacity）在 GitActionButtons.vue 里统一写。 */
  &.is-disabled {
    --action-disabled-bg: var(--tint-primary-12);
    --action-disabled-fg: var(--text-secondary);
    --action-disabled-icon: var(--color-primary);
  }
  &.form {
    width: 100%;
    padding: 4px 12px;
  }
  &.drawer {
    width: auto;
    height: 32px;
  }
  .one-commit-content {
    display: flex;
    align-items: center;
    gap: 6px;
    .one-commit-icon {
      font-size: var(--font-size-base);
    }
    .one-commit-text {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      .one-commit-title {
        font-size: var(--font-size-mid);
      }
      .one-commit-desc {
        font-size: var(--font-size-xs);
        /* 11px 小字压在深蓝端要保住 4.5:1，0.72 会掉到约 3.9:1 */
        opacity: 0.9;
        font-weight: 400;
        letter-spacing: 0.1px;
      }
    }
  }
}
</style>
