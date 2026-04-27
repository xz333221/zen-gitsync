<script setup lang="ts">
import { computed, ref } from "vue";
import { ElTooltip } from "element-plus";
import { Position } from "@element-plus/icons-vue";
import { $t } from '@/lang/static';
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
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
  afterPush: [success: boolean];
  clearFields: [];
}>();

// 检查文件是否被锁定
function isFileLocked(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return configStore.lockedFiles.some((lockedFile: string) => {
    const normalizedLocked = lockedFile.replace(/\\/g, "/");
    return normalizedPath === normalizedLocked;
  });
}

// 计算是否有任何变更
const hasAnyChanges = computed(() => {
  return gitStore.fileList.some((file) => !isFileLocked(file.path));
});

// 计算最终的禁用状态
const isDisabled = computed(() => {
  // 如果有冲突文件，禁用一键推送按钮
  if (gitStore.hasConflictedFiles) {
    return true;
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

// 一键推送处理函数
async function handleQuickPush() {
  emit("beforePush");

  try {
    // 只有在有本地变更时才执行暂存和提交阶段
    if (hasAnyChanges.value) {
      const commitResult = await gitStore.addAndCommit(
        props.finalCommitMessage,
        props.skipHooks
      );
      
      if (!commitResult) {
        emit("afterPush", false);
        return;
      }
    }
    
    // 推送阶段显示进度
    progressModalVisible.value = true;
    
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
            <span class="one-push-title">{{ $t('@2E184:一键推送所有') }}</span>
            <span v-if="from === 'form'" class="one-push-desc">{{ $t('@2E184:暂存 + 提交 + 推送') }}</span>
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
      gap: 1px;
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
