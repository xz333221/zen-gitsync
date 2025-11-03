<script setup lang="ts">
import { computed, ref } from "vue";
import { ElTooltip } from "element-plus";
import { Position } from "@element-plus/icons-vue";
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
  return (
    !hasAnyChanges.value || !props.hasUserCommitMessage || !gitStore.hasUpstream
  );
});

// 计算最终的加载状态
const isLoading = computed(() => {
  return gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing;
});

// 计算提示文本
const tooltipText = computed(() => {
  if (!hasAnyChanges.value) {
    return "没有需要提交的更改";
  }
  if (!props.hasUserCommitMessage) {
    return "请输入提交信息";
  }
  if (!gitStore.hasUpstream) {
    return "当前分支没有上游分支";
  }
  return "一键完成：暂存所有更改 → 提交 → 推送到远程仓库";
});

// 一键推送处理函数
async function handleQuickPush() {
  emit("beforePush");

  try {
    // 暂存和提交阶段不显示进度
    const commitResult = await gitStore.addAndCommit(
      props.finalCommitMessage,
      props.skipHooks
    );
    
    if (!commitResult) {
      emit("afterPush", false);
      return;
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
      emit("clearFields");
    }
    
    emit("afterPush", pushResult);
  } catch (error) {
    console.error("一键推送失败:", error);
    emit("afterPush", false);
  }
}

// 处理进度完成
function handleProgressComplete(_success: boolean) {
  // 可以在这里添加额外的完成处理逻辑
}
</script>

<template>
  <div>
    <el-tooltip :content="tooltipText" placement="top" :show-after="200">
      <el-button
        type="success"
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
            <span v-if="from === 'form'" class="one-push-desc"
              >{{ $t('@2E184:暂存 + 提交 + 推送') }}</span
            >
          </div>
        </div>
      </el-button>
    </el-tooltip>
    
    <!-- 推送进度弹窗 -->
    <PushProgressModal
      ref="progressModalRef"
      v-model="progressModalVisible"
      @complete="handleProgressComplete"
    />
  </div>
</template>

<style scoped lang="scss">
.one-push-button {
  height: 100%;
  &.form {
    width: 100%;
  }
  &.drawer {
    width: auto;
    height: 32px;
  }
  .one-push-content {
    display: flex;
    align-items: center;
    .one-push-text {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding-left: 10px;
      .one-push-desc{
        font-size: 12px;
        padding-top: 4px;
      }
    }
  }
}
</style>
