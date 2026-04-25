<script setup lang="ts">
import { computed } from "vue";
import { ElTooltip } from "element-plus";
import { Edit } from "@element-plus/icons-vue";
import { $t } from '@/lang/static';
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";

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
  // 如果有冲突文件，禁用
  if (gitStore.hasConflictedFiles) {
    return true;
  }
  
  // 如果没有本地变更，禁用
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
  
  if (!hasAnyChanges.value) {
    return $t('@2E184:没有需要提交的更改');
  }
  
  if (!props.hasUserCommitMessage) {
    return $t('@2E184:请输入提交信息');
  }
  
  return $t('@2E184:一键完成：暂存所有更改 → 提交');
});

// 一键提交处理函数
async function handleQuickCommit() {
  emit("beforeCommit");

  try {
    const commitResult = await gitStore.addAndCommit(
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
            <span class="one-commit-title">{{ $t('@2E184:一键提交') }}</span>
            <span v-if="from === 'form'" class="one-commit-desc">{{ $t('@2E184:暂存 + 提交') }}</span>
          </div>
        </div>
      </el-button>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
.one-commit-button {
  height: 100%;
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
      font-size: 14px;
    }
    .one-commit-text {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      .one-commit-title {
        font-size: 13px;
      }
      .one-commit-desc {
        font-size: 11px;
        opacity: 0.72;
        font-weight: 400;
        letter-spacing: 0.1px;
      }
    }
  }
}
</style>
