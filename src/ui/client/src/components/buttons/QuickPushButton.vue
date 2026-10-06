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
import { computed, ref } from "vue";
import { ElTooltip, ElMessage } from "element-plus";
import { Position } from "@element-plus/icons-vue";
import { $t } from '@/lang/static';
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
import { isFilePathLocked } from "@/utils/fileLock";
import PushProgressModal from "@components/PushProgressModal.vue";

const gitStore = useGitStore();
const configStore = useConfigStore();

// 进度弹窗
const progressModalVisible = ref(false);
const progressModalRef = ref<InstanceType<typeof PushProgressModal> | null>(null);

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
  beforePush: [];
  pushStart: [];
  afterPush: [success: boolean];
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

// 纯推送：本地没有待提交的改动，只有领先远程的提交。
// 这条路径根本不走暂存/提交（见 handleQuickPush 里的 hasLocalChanges），
// 所以不能拿「必须先填提交信息」去拦它 —— 否则最需要推送的场景反而点不动，
// 还弹一句和当前动作无关的「请输入提交信息」。
const isPushOnly = computed(() => {
  return !gitStore.isSelectionMode
    && !hasAnyChanges.value
    && gitStore.branchAhead > 0;
});

// 计算最终的禁用状态
const isDisabled = computed(() => {
  // 如果有冲突文件，禁用一键推送按钮
  if (gitStore.hasConflictedFiles) {
    return true;
  }

  if (!gitStore.hasUpstream) {
    return true;
  }

  // 选择模式：要求所选文件有可暂存内容
  if (gitStore.isSelectionMode) {
    return !hasSelectedToStage.value || !props.hasUserCommitMessage;
  }

  // 纯推送不需要提交信息（这条路径不提交任何东西）
  if (isPushOnly.value) {
    return false;
  }

  // 没有本地变更、也没有领先提交 → 无事可做
  return !hasAnyChanges.value || !props.hasUserCommitMessage;
});

// 计算最终的加载状态
const isLoading = computed(() => {
  return gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing;
});

// 计算提示文本
const tooltipText = computed(() => {
  if (gitStore.hasConflictedFiles) {
    return $t('@2E184:存在冲突文件，请先解决冲突');
  }

  if (!gitStore.hasUpstream) {
    return $t('@2E184:当前分支没有上游分支');
  }

  if (gitStore.isSelectionMode) {
    if (gitStore.selectedFiles.size === 0) {
      return $t('@2E184:请先勾选要推送的文件');
    }
    if (gitStore.selectedUnstagedPaths.length === 0) {
      return $t('@2E184:所选文件无需暂存或被锁定');
    }
    if (!props.hasUserCommitMessage) {
      return $t('@2E184:请输入提交信息');
    }
    return $t('@2E184:一键完成：仅暂存所选文件 → 提交 → 推送到远程仓库');
  }

  if (!hasAnyChanges.value && gitStore.branchAhead === 0) {
    return $t('@2E184:没有需要提交或推送的更改');
  }

  // 纯推送：这次点击只会推送，不会暂存也不会提交
  if (isPushOnly.value) {
    return $t('@2E184:本地已提交，一键推送到远程仓库');
  }

  if (!props.hasUserCommitMessage) {
    return $t('@2E184:请输入提交信息');
  }

  return $t('@2E184:一键完成：暂存所有更改 → 提交 → 推送到远程仓库');
});

// 按钮标题与副标题：随选择模式动态切换
const buttonTitle = computed(() => {
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:一键推送所选')
    : $t('@2E184:一键推送所有');
});

const buttonDesc = computed(() => {
  if (props.from !== 'form') return '';
  // 纯推送时副标题不能还写着「暂存 + 提交」——这次点击不会暂存也不会提交
  if (isPushOnly.value) {
    return $t('@2E184:推送到远程仓库');
  }
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:暂存所选 + 提交 + 推送')
    : $t('@2E184:暂存 + 提交 + 推送');
});

// 一键推送处理函数
async function handleQuickPush() {
  emit("beforePush");

  try {
    const isSelectedMode = gitStore.isSelectionMode && hasSelectedToStage.value;

    // 只有在有本地变更时才执行暂存和提交阶段
    const hasLocalChanges = isSelectedMode
      ? true  // 选择模式：必定要暂存并提交所选
      : hasAnyChanges.value;

    if (hasLocalChanges) {
      const commitResult = isSelectedMode
        ? await gitStore.stageSelectedAndCommit(
            props.finalCommitMessage,
            props.skipHooks
          )
        : await gitStore.addAndCommit(
            props.finalCommitMessage,
            props.skipHooks
          );

      if (!commitResult) {
        emit("afterPush", false);
        return;
      }
    }

    // 推送阶段显示进度
    emit("pushStart");
    progressModalVisible.value = true;

    // 如果开启"推送前拉取"，先拉取远程更新
    if (configStore.pullBeforePush) {
      progressModalRef.value?.setPulling(true);
      const pullResult = await gitStore.gitPull();
      progressModalRef.value?.setPulling(false);
      if (!pullResult.success) {
        ElMessage.error($t('@2E184:拉取远程更新失败，已停止推送'));
        progressModalVisible.value = false;
        // 刷新左侧 git 状态
        gitStore.fetchStatus();
        gitStore.getBranchStatus(true);
        emit("afterPush", false);
        return;
      }
    }

    if (progressModalRef.value) {
      progressModalRef.value.reset();
    }

    const pushResult = await gitStore.pushToRemoteWithProgress((data) => {
      if (progressModalRef.value) {
        progressModalRef.value.handleProgress(data);
      }
    });

    if (pushResult) {
      try {
        window.dispatchEvent(new CustomEvent('zen-gitsync:after-quick-push-success'));
      } catch {
        // ignore
      }
      emit("clearFields");
    }

    emit("afterPush", pushResult);
  } catch (error) {
    console.error("一键推送失败:", error);
    emit("afterPush", false);
  }
}

defineExpose({
  triggerQuickPush: handleQuickPush
});

// 处理进度完成
function handleProgressComplete(_success: boolean) {
  // 可以在这里添加额外的完成处理逻辑
}
</script>

<template>
  <div>
    <el-tooltip :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="primary"
        @click="handleQuickPush"
        :loading="isLoading"
        :disabled="isDisabled"
        :class="from"
        class="one-push-button"
      >
        <div class="one-push-content">
          <el-icon class="one-push-icon"><Position /></el-icon>
          <div class="one-push-text">
            <span class="one-push-title">{{ buttonTitle }}</span>
            <span v-if="from === 'form'" class="one-push-desc">{{ buttonDesc }}</span>
          </div>
        </div>
      </el-button>
    </el-tooltip>
    
    <!-- 推送进度弹窗 -->
    <PushProgressModal
      ref="progressModalRef"
      v-model="progressModalVisible"
      @complete="handleProgressComplete"
      @pull-requested="handleQuickPush"
    />
  </div>
</template>

<style scoped lang="scss">
.one-push-button {
  height: 100%;
  /* 二档动作：实心深蓝 + 白字。
     浅底 + 深字那版被反馈「不如白字」—— 浅蓝底上白字实际只有约 1.2:1 不可读，
     所以把底色做实（#2563eb，白字 5.2:1 过 AA），用「比一键提交更沉、更平」来分档：
     一键提交是亮蓝渐变，这颗是纯色深蓝。 */
  background: var(--color-primary-dark) !important;
  border: 1px solid var(--color-primary-dark) !important;
  color: #fff !important;
  &:hover:not(.is-disabled) {
    /* 略压暗一档，避免与 EP 默认 hover 底色打架 */
    background: color-mix(in srgb, var(--color-primary-dark) 88%, #000) !important;
    border-color: color-mix(in srgb, var(--color-primary-dark) 88%, #000) !important;
  }
  /* EP 把 label 包在 span 里，父级 color 不保证落到文字节点，显式声明 */
  .one-push-icon,
  .one-push-title,
  .one-push-desc {
    color: #fff;
  }
  /* 禁用态的身份层：本档身份的 wash 档底 + 实心身份色图标。
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
  .one-push-content {
    display: flex;
    align-items: center;
    gap: 6px;
    .one-push-icon {
      font-size: var(--font-size-base);
    }
    .one-push-text {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      .one-push-title {
        font-size: var(--font-size-mid);
      }
      .one-push-desc {
        font-size: var(--font-size-xs);
        /* 11px 小字在深蓝上要保住 4.5:1，透明度不能像浅底那样压到 0.72 */
        opacity: 0.9;
        font-weight: 400;
        letter-spacing: 0.1px;
      }
    }
  }
}
</style>
