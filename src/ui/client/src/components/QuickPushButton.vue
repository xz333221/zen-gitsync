<script setup lang="ts">
import { computed } from "vue";
import { ElTooltip } from "element-plus";
import { Position } from "@element-plus/icons-vue";
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";

const gitStore = useGitStore();
const configStore = useConfigStore();

// 定义组件props
interface Props {
  variant?: 'large' | 'small';
  hasUserCommitMessage?: boolean;
  finalCommitMessage?: string;
  skipHooks?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'large',
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false
});

// 定义事件
const emit = defineEmits<{
  beforePush: [];
  afterPush: [success: boolean];
  clearFields: [];
}>();

// 检查文件是否被锁定
function isFileLocked(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return configStore.lockedFiles.some((lockedFile: string) => {
    const normalizedLocked = lockedFile.replace(/\\/g, '/');
    return normalizedPath === normalizedLocked;
  });
}

// 计算是否有任何变更
const hasAnyChanges = computed(() => {
  return gitStore.fileList.some(file => !isFileLocked(file.path));
});

// 计算最终的禁用状态
const isDisabled = computed(() => {
  return !hasAnyChanges.value || 
         !props.hasUserCommitMessage || 
         !gitStore.hasUpstream;
});

// 计算最终的加载状态
const isLoading = computed(() => {
  return gitStore.isAddingFiles || 
         gitStore.isCommiting || 
         gitStore.isPushing;
});

// 计算提示文本
const tooltipText = computed(() => {
  if (!hasAnyChanges.value) {
    return '没有需要提交的更改';
  }
  if (!props.hasUserCommitMessage) {
    return '请输入提交信息';
  }
  if (!gitStore.hasUpstream) {
    return '当前分支没有上游分支';
  }
  return '一键完成：暂存所有更改 → 提交 → 推送到远程仓库';
});

// 一键推送处理函数
async function handleQuickPush() {
  emit('beforePush');
  
  try {
    const result = await gitStore.addCommitAndPush(props.finalCommitMessage, props.skipHooks);
    if (result) {
      emit('clearFields');
    }
    emit('afterPush', result);
  } catch (error) {
    console.error('一键推送失败:', error);
    emit('afterPush', false);
  }
}
</script>

<template>
  <el-tooltip
    :content="tooltipText"
    placement="top"
    :show-after="200"
  >
    <!-- 大按钮样式 -->
    <el-button
      v-if="variant === 'large'"
      type="success"
      @click="handleQuickPush"
      :loading="isLoading"
      :disabled="isDisabled"
      class="one-push-button"
    >
      <div class="one-push-content">
        <el-icon class="one-push-icon"><Position /></el-icon>
        <div class="one-push-text">
          <span class="one-push-title">一键推送所有</span>
          <span class="one-push-desc">暂存 + 提交 + 推送</span>
        </div>
      </div>
    </el-button>

    <!-- 小按钮样式 -->
    <el-button
      v-else
      type="success"
      :icon="Position"
      @click="handleQuickPush"
      :loading="isLoading"
      :disabled="isDisabled"
      :class="['action-button', 'one-click-push', { 'is-loading': isLoading }]"
    >
      一键推送所有
    </el-button>
  </el-tooltip>
</template>

<style scoped>
.one-push-button {
  height: 60px;
  width: 100%;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  background: linear-gradient(135deg, #67c23a 0%, #85ce61 100%);
  border: none;
  box-shadow: 0 4px 12px rgba(103, 194, 58, 0.4);
  transition: all 0.3s ease;
}

.one-push-button:hover {
  background: linear-gradient(135deg, #85ce61 0%, #67c23a 100%);
  box-shadow: 0 6px 16px rgba(103, 194, 58, 0.5);
  transform: translateY(-1px);
}

.one-push-content {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.one-push-icon {
  font-size: 20px;
  color: white;
}

.one-push-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.one-push-title {
  font-size: 16px;
  font-weight: 700;
  color: white;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  line-height: 1.2;
}

.one-push-desc {
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  line-height: 1.2;
  margin-top: 2px;
}
</style>
