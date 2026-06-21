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

// 计算最终的禁用状态
const isDisabled = computed(() => {
  // 如果有冲突文件，禁用一键推送按钮
  if (gitStore.hasConflictedFiles) {
    return true;
  }

  // 选择模式：要求所选文件有可暂存内容
  if (gitStore.isSelectionMode) {
    return (
      !hasSelectedToStage.value
      || !props.hasUserCommitMessage
      || !gitStore.hasUpstream
    );
  }

  // 如果没有本地变更，也没有领先提交，禁用
  const noWorkToDo = !hasAnyChanges.value && gitStore.branchAhead === 0;

  return (
    noWorkToDo || !props.hasUserCommitMessage || !gitStore.hasUpstream
  );
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
    if (!gitStore.hasUpstream) {
      return $t('@2E184:当前分支没有上游分支');
    }
    return $t('@2E184:一键完成：仅暂存所选文件 → 提交 → 推送到远程仓库');
  }

  const hasCommitsToPush = gitStore.branchAhead > 0;

  if (!hasAnyChanges.value && !hasCommitsToPush) {
    return $t('@2E184:没有需要提交或推送的更改');
  }

  if (!props.hasUserCommitMessage) {
    return $t('@2E184:请输入提交信息');
  }

  if (!gitStore.hasUpstream) {
    return $t('@2E184:当前分支没有上游分支');
  }

  if (hasAnyChanges.value) {
    return $t('@2E184:一键完成：暂存所有更改 → 提交 → 推送到远程仓库');
  } else {
    return $t('@2E184:本地已提交，一键推送到远程仓库');
  }
});

// 按钮标题与副标题：随选择模式动态切换
const buttonTitle = computed(() => {
  return gitStore.isSelectionMode && hasSelectedToStage.value
    ? $t('@2E184:一键推送所选')
    : $t('@2E184:一键推送所有');
});

const buttonDesc = computed(() => {
  if (props.from !== 'form') return '';
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
  background: linear-gradient(135deg, #1e40af 0%, #1e3a8a 100%) !important;
  border: none !important;
  color: white !important;
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
      font-size: 14px;
    }
    .one-push-text {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 2px;
      .one-push-title {
        font-size: 13px;
      }
      .one-push-desc {
        font-size: 11px;
        opacity: 0.72;
        font-weight: 400;
        letter-spacing: 0.1px;
      }
    }
  }
}
</style>
