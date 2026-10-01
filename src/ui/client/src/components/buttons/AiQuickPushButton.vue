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
import SvgIcon from "@components/SvgIcon/index.vue";
import { $t } from '@/lang/static';
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
import { isFilePathLocked } from "@/utils/fileLock";

const gitStore = useGitStore();
const configStore = useConfigStore();

interface Props {
  from?: "form" | "drawer";
  /** AI 生成提交信息阶段（由父组件持有），与 git 操作状态一起决定 loading */
  generating?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  from: "form",
  generating: false,
});

const emit = defineEmits<{
  trigger: [];
}>();

const hasAnyChanges = computed(() => {
  return gitStore.fileList.some((file) => !isFilePathLocked(file.path, configStore.lockedFiles));
});

const hasSelectedToStage = computed(() => {
  return gitStore.isSelectionMode && gitStore.selectedFiles.size > 0
    && gitStore.selectedUnstagedPaths.length > 0;
});

// 纯推送：本地已提交、只差推送。这条路径不生成提交信息（见 CommitForm.handleAiQuickPush），
// 副标题要跟着说实话，否则一片「AI 生成信息 + 推送」会让人以为会新生成一条提交。
const isPushOnly = computed(() => {
  return !gitStore.isSelectionMode
    && !hasAnyChanges.value
    && gitStore.branchAhead > 0;
});

// 与 QuickPushButton 的关键差异：**不要求 hasUserCommitMessage**——
// 提交信息由 AI 现场生成，用户不必先手写一条才能点。
const isDisabled = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return true;
  }

  if (!gitStore.hasUpstream) {
    return true;
  }

  if (gitStore.isSelectionMode) {
    return !hasSelectedToStage.value;
  }

  // 没有本地变更、也没有领先提交 → 既没得提交也没得推
  return !hasAnyChanges.value && gitStore.branchAhead === 0;
});

const isLoading = computed(() => {
  return props.generating
    || gitStore.isAddingFiles
    || gitStore.isCommiting
    || gitStore.isPushing;
});

const tooltipText = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return $t('@2E184:存在冲突文件，请先解决冲突');
  }

  if (!gitStore.hasUpstream) {
    return $t('@2E184:当前分支没有上游分支');
  }

  if (props.generating) {
    return $t('@2E184:AI 正在生成提交信息…');
  }

  if (gitStore.isSelectionMode) {
    if (!hasSelectedToStage.value) {
      return $t('@2E184:请先勾选要推送的文件');
    }
    return $t('@2E184:一键完成：AI 生成提交信息 → 仅暂存所选文件 → 提交 → 推送');
  }

  if (!hasAnyChanges.value && gitStore.branchAhead === 0) {
    return $t('@2E184:没有需要提交或推送的更改');
  }

  if (!hasAnyChanges.value) {
    return $t('@2E184:本地已提交，AI 将直接推送到远程仓库');
  }

  return $t('@2E184:一键完成：AI 生成提交信息 → 暂存所有更改 → 提交 → 推送');
});

const buttonTitle = computed(() => {
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:AI 提交并推送所选')
    : $t('@2E184:AI 提交并推送');
});

const buttonDesc = computed(() => {
  if (props.from !== 'form') return '';
  if (isPushOnly.value) {
    return $t('@2E184:本地已提交，直接推送');
  }
  return $t('@2E184:AI 生成信息 + 推送');
});

function handleClick() {
  if (isDisabled.value || isLoading.value) return;
  emit("trigger");
}
</script>

<template>
  <div class="one-ai-push">
    <el-tooltip :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="primary"
        @click="handleClick"
        :loading="isLoading"
        :disabled="isDisabled"
        :class="from"
        class="one-ai-push-button"
      >
        <div class="one-ai-push-content">
          <svg-icon
            class="one-ai-push-icon"
            icon-class="ai-commit"
            :style="{ color: '#fff' }"
          />
          <div class="one-ai-push-text">
            <span class="one-ai-push-title">{{ buttonTitle }}</span>
            <span v-if="from === 'form'" class="one-ai-push-desc">{{ buttonDesc }}</span>
          </div>
        </div>
      </el-button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
.one-ai-push-button {
  height: 100%;
  /* AI 档：紫罗兰渐变。选紫不选蓝是为了让"AI 代写"和两颗蓝色按钮
     一眼分开——紫色在本仓库已经是 AI 的语言（--color-think / ai-commit
     图标 / Git 视图未跟踪文件）。渐变两端对白字都过 AA：
     #7c3aed 5.7:1、#6d28d9 7.1:1（11px 的小字也够）。 */
  background: linear-gradient(
    135deg,
    #7c3aed 0%,
    #6d28d9 100%
  ) !important;
  border: none !important;
  color: #fff !important;
  &:hover:not(.is-disabled) {
    background: linear-gradient(
      135deg,
      #6d28d9 0%,
      #5b21b6 100%
    ) !important;
  }
  /* EP 把 label 包在 span 里，父级 color 不保证落到文字节点，显式声明 */
  .one-ai-push-icon,
  .one-ai-push-title,
  .one-ai-push-desc {
    color: #fff;
  }
  &.form {
    width: 100%;
    padding: 4px 12px;
  }
  &.drawer {
    width: auto;
    height: 32px;
  }
  .one-ai-push-icon {
    font-size: var(--font-size-base);
  }
  .one-ai-push-content {
    display: flex;
    align-items: center;
    gap: 6px;
    .one-ai-push-text {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      .one-ai-push-title {
        font-size: var(--font-size-mid);
      }
      .one-ai-push-desc {
        font-size: var(--font-size-xs);
        /* 11px 小字压在紫底上要保住 4.5:1，透明度不能压得太狠 */
        opacity: 0.9;
        font-weight: 400;
        letter-spacing: 0.1px;
      }
    }
  }
}
</style>
