<script setup lang="ts">
import { ref, computed } from 'vue';
import { ElDialog, ElProgress, ElIcon } from 'element-plus';
import { Check, Close, Loading } from '@element-plus/icons-vue';

interface Props {
  modelValue: boolean;
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'complete', success: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

// 进度数据
const percent = ref(0);
const status = ref<'progress' | 'success' | 'error'>('progress');
const messages = ref<string[]>([]);
const errorMessage = ref('');

// 缓存消息容器引用
const messagesContainerRef = ref<HTMLElement | null>(null);

// 计算属性
const visible = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});

const statusText = computed(() => {
  switch (status.value) {
    case 'progress':
      return '正在推送...';
    case 'success':
      return '推送成功';
    case 'error':
      return '推送失败';
    default:
      return '';
  }
});

const statusColor = computed(() => {
  switch (status.value) {
    case 'success':
      return '#67c23a';
    case 'error':
      return '#f56c6c';
    default:
      return '#409eff';
  }
});

// 处理进度数据
function handleProgress(data: any) {
  switch (data.type) {
    case 'progress':
      if (data.message) {
        messages.value.push(data.message);
        // 使用nextTick确保DOM更新后再滚动
        setTimeout(() => {
          if (messagesContainerRef.value) {
            messagesContainerRef.value.scrollTop = messagesContainerRef.value.scrollHeight;
          }
        }, 0);
      }
      break;
      
    case 'percent':
      if (typeof data.value === 'number') {
        percent.value = Math.min(100, Math.max(0, data.value));
      }
      break;
      
    case 'complete':
      if (data.success) {
        status.value = 'success';
        percent.value = 100;
        
        // 2秒后自动关闭
        setTimeout(() => {
          visible.value = false;
          emit('complete', true);
        }, 2000);
      } else {
        status.value = 'error';
        errorMessage.value = data.error || '未知错误';
        // 失败时立即触发complete，但不关闭弹窗
        emit('complete', false);
      }
      break;
  }
}

// 重置状态
function reset() {
  percent.value = 0;
  status.value = 'progress';
  messages.value = [];
  errorMessage.value = '';
}

// 暴露方法给父组件
defineExpose({
  handleProgress,
  reset
});
</script>

<template>
  <ElDialog
    v-model="visible"
    title=""
    width="600px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="status !== 'progress'"
    :append-to-body="true"
    :lock-scroll="false"
    destroy-on-close
  >
    <div class="push-progress-container">
      <!-- 状态图标和文字 -->
      <div class="status-section">
        <div class="status-icon" :class="status">
          <el-icon v-if="status === 'progress'" class="rotating">
            <Loading />
          </el-icon>
          <el-icon v-else-if="status === 'success'">
            <Check />
          </el-icon>
          <el-icon v-else>
            <Close />
          </el-icon>
        </div>
        <div class="status-text" :style="{ color: statusColor }">
          {{ statusText }}
        </div>
      </div>

      <!-- 进度圆环 -->
      <div class="progress-section">
        <el-progress
          type="circle"
          :percentage="percent"
          :width="120"
          :stroke-width="8"
          :color="statusColor"
          :status="status === 'error' ? 'exception' : status === 'success' ? 'success' : undefined"
        >
          <template #default="{ percentage }">
            <span class="percentage-value">{{ percentage }}%</span>
          </template>
        </el-progress>
      </div>

      <!-- 错误信息 -->
      <div v-if="status === 'error' && errorMessage" class="error-section">
        <div class="error-title">错误详情：</div>
        <div class="error-content">{{ errorMessage }}</div>
      </div>

      <!-- 进度消息 -->
      <div v-if="messages.length > 0" class="messages-section">
        <div class="messages-title">详细信息：</div>
        <div ref="messagesContainerRef" class="progress-messages">
          <div
            v-for="(msg, index) in messages"
            :key="index"
            class="message-item"
          >
            {{ msg }}
          </div>
        </div>
      </div>
    </div>
  </ElDialog>
</template>

<style scoped lang="scss">
// 禁用Dialog的过渡效果，避免闪烁
:deep(.el-overlay-dialog) {
  will-change: auto !important;
}

:deep(.el-dialog) {
  will-change: auto !important;
}

.push-progress-container {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 20px 0;
  
  // 优化渲染性能
  * {
    will-change: auto;
  }
}

.status-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.status-icon {
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  
  &.progress {
    background: rgba(64, 158, 255, 0.1);
    color: #409eff;
  }
  
  &.success {
    background: rgba(103, 194, 58, 0.1);
    color: #67c23a;
  }
  
  &.error {
    background: rgba(245, 108, 108, 0.1);
    color: #f56c6c;
  }
}

.rotating {
  animation: rotate 1s linear infinite;
  // 使用GPU加速，优化性能
  transform: translateZ(0);
  backface-visibility: hidden;
}

@keyframes rotate {
  from {
    transform: rotate(0deg) translateZ(0);
  }
  to {
    transform: rotate(360deg) translateZ(0);
  }
}

.status-text {
  font-size: 18px;
  font-weight: 600;
}

.progress-section {
  display: flex;
  justify-content: center;
  padding: 20px 0;
}

.percentage-value {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
}

.error-section {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  border-radius: 8px;
  padding: 16px;
}

.error-title {
  font-weight: 600;
  color: #f56c6c;
  margin-bottom: 8px;
}

.error-content {
  color: #c45656;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.messages-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.messages-title {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 14px;
}

.progress-messages {
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-panel);
  border-radius: 8px;
  padding: 12px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
}

.message-item {
  color: var(--text-primary);
  padding: 2px 0;
  
  &:not(:last-child) {
    border-bottom: 1px solid var(--border-color-light);
    padding-bottom: 4px;
    margin-bottom: 4px;
  }
}

/* 深色主题适配 */
[data-theme="dark"] {
  .error-section {
    background: rgba(245, 108, 108, 0.1);
    border-color: rgba(245, 108, 108, 0.3);
  }
  
  .error-content {
    color: #f89898;
  }
}
</style>
