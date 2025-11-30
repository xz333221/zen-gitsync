<script setup lang="ts">
import { ref, computed, reactive } from 'vue';
import { ElDialog, ElProgress, ElIcon } from 'element-plus';
import { Close, Loading, CircleCheck } from '@element-plus/icons-vue';
import { useConfigStore } from '@stores/configStore';

interface Props {
  modelValue: boolean;
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void;
  (e: 'complete', success: boolean): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

// 从configStore获取配置
const configStore = useConfigStore();

// 阶段定义
interface Stage {
  name: string;
  label: string;
  status: 'wait' | 'process' | 'finish' | 'error';
  percent: number;
}

// 进度数据
const status = ref<'progress' | 'success' | 'error'>('progress');
const messages = ref<string[]>([]);
const errorMessage = ref('');

// 推送阶段
const stages = reactive<Stage[]>([
  { name: 'counting', label: '计数对象', status: 'wait', percent: 0 },
  { name: 'compressing', label: '压缩对象', status: 'wait', percent: 0 },
  { name: 'writing', label: '写入对象', status: 'wait', percent: 0 },
  { name: 'resolving', label: '解析增量', status: 'wait', percent: 0 }
]);

// 当前激活的步骤索引
const activeStep = ref(0);

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
      
    case 'stage-progress':
      if (data.stage && typeof data.percent === 'number') {
        const stageIndex = stages.findIndex(s => s.name === data.stage);
        if (stageIndex !== -1) {
          // 更新对应阶段的进度
          stages[stageIndex].percent = data.percent;
          stages[stageIndex].status = data.percent === 100 ? 'finish' : 'process';
          
          // 更新激活步骤
          activeStep.value = stageIndex;
          
          // 完成当前阶段时，将下一阶段设为等待状态
          if (data.percent === 100 && stageIndex < stages.length - 1) {
            stages[stageIndex + 1].status = 'wait';
          }
        }
      }
      break;
      
    case 'complete':
      if (data.success) {
        status.value = 'success';
        // 标记所有阶段为完成
        stages.forEach(stage => {
          if (stage.status === 'process' || stage.status === 'wait') {
            stage.status = 'finish';
            stage.percent = 100;
          }
        });
        // 清除激活状态，避免已完成阶段继续显示动画
        activeStep.value = -1;
        
        // 根据配置决定是否自动关闭
        if (configStore.autoClosePushModal) {
          setTimeout(() => {
            visible.value = false;
            emit('complete', true);
          }, 2000);
        } else {
          // 不自动关闭，但仍然触发complete事件
          emit('complete', true);
        }
      } else {
        status.value = 'error';
        errorMessage.value = data.error || '未知错误';
        // 标记当前阶段为错误
        if (activeStep.value < stages.length) {
          stages[activeStep.value].status = 'error';
        }
        // 清除激活状态
        activeStep.value = -1;
        // 失败时立即触发complete，但不关闭弹窗
        emit('complete', false);
      }
      break;
  }
}

// 重置状态
function reset() {
  status.value = 'progress';
  messages.value = [];
  errorMessage.value = '';
  activeStep.value = 0;
  stages.forEach(stage => {
    stage.status = 'wait';
    stage.percent = 0;
  });
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
    :title="statusText"
    width="650px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="status !== 'progress'"
    :append-to-body="true"
    :lock-scroll="false"
    destroy-on-close
    :class="['push-progress-dialog', `status-${status}`]"
  >
    <div class="push-progress-container">
      <!-- 推送阶段（2x2网格） -->
      <div 
        class="stages-section"
        :class="{ 'is-loading': status === 'progress', 'is-success': status === 'success' }"
      >
        <div
          v-for="(stage, index) in stages"
          :key="stage.name"
          class="stage-item"
          :class="{
            active: activeStep === index,
            finished: stage.status === 'finish',
            error: stage.status === 'error'
          }"
        >
          <div class="stage-header">
            <div class="stage-icon">
              <el-icon v-if="stage.status === 'finish'" class="icon-finish">
                <CircleCheck />
              </el-icon>
              <el-icon v-else-if="stage.status === 'error'" class="icon-error">
                <Close />
              </el-icon>
              <el-icon v-else-if="stage.status === 'process'" class="icon-process rotating">
                <Loading />
              </el-icon>
              <el-icon v-else class="icon-wait">
                <Loading />
              </el-icon>
            </div>
            <div class="stage-info">
              <div class="stage-label">{{ stage.label }}</div>
              <div v-if="stage.status === 'process' || stage.status === 'finish'" class="stage-percent">
                {{ stage.percent }}%
              </div>
            </div>
          </div>
          <div v-if="stage.status === 'process' || stage.status === 'finish'" class="stage-progress">
            <el-progress
              :percentage="stage.percent"
              :stroke-width="6"
              :show-text="false"
              :color="stage.status === 'finish' ? '#67c23a' : '#409eff'"
            />
          </div>
        </div>
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
  border-radius: 12px !important;
  overflow: hidden;
}

// 弹窗标题颜色
.push-progress-dialog {
  :deep(.el-dialog__header) {
    padding: var(--spacing-lg) var(--spacing-xl);
  }
  
  :deep(.el-dialog__title) {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
}

// 根据状态设置标题颜色
.status-progress {
  :deep(.el-dialog__title) {
    color: #409eff;
  }
}

.status-success {
  :deep(.el-dialog__title) {
    color: #67c23a;
  }
}

.status-error {
  :deep(.el-dialog__title) {
    color: #f56c6c;
  }
}

.push-progress-container {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  padding: var(--spacing-md);
  
  // 优化渲染性能
  * {
    will-change: auto;
  }
}

@keyframes success-pulse {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.05);
  }
}

@keyframes loading-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(64, 158, 255, 0.15);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(64, 158, 255, 0);
  }
}

@keyframes border-light-run {
  0% {
    top: 0;
    left: 0;
    width: 60px;
    height: 2px;
  }
  24.99% {
    top: 0;
    left: 100%;
    width: 60px;
    height: 2px;
  }
  25% {
    top: 0;
    left: 100%;
    width: 2px;
    height: 60px;
  }
  49.99% {
    top: 100%;
    left: 100%;
    width: 2px;
    height: 60px;
  }
  50% {
    top: 100%;
    left: 100%;
    width: 60px;
    height: 2px;
  }
  74.99% {
    top: 100%;
    left: 0;
    width: 60px;
    height: 2px;
  }
  75% {
    top: 100%;
    left: 0;
    width: 2px;
    height: 60px;
  }
  99.99% {
    top: 0;
    left: 0;
    width: 2px;
    height: 60px;
  }
  100% {
    top: 0;
    left: 0;
    width: 60px;
    height: 2px;
  }
}

.stages-section {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-radius: 10px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.05);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
  
  &.is-loading {
    border-color: rgba(64, 158, 255, 0.15);
    
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 60px;
      height: 2px;
      background: linear-gradient(90deg, 
        transparent 0%,
        rgba(64, 158, 255, 0.4) 30%,
        rgba(64, 158, 255, 0.8) 50%,
        rgba(64, 158, 255, 0.4) 70%,
        transparent 100%
      );
      box-shadow: 0 0 10px rgba(64, 158, 255, 0.5);
      animation: border-light-run 4s linear infinite;
    }
  }
  
  &.is-success {
    border-color: rgba(103, 194, 58, 0.2);
  }
}

[data-theme="dark"]{
  .stages-section {
    opacity: 0.8;
  }
}
.stage-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  padding: 10px var(--spacing-md);
  border-radius: var(--radius-lg);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  
  &.active {
    background: rgba(64, 158, 255, 0.05);
    border-color: rgba(64, 158, 255, 0.15);
    transform: scale(1.01);
  }
  
  &.finished {
    background: rgba(103, 194, 58, 0.05);
    border-color: rgba(103, 194, 58, 0.15);
  }
  
  &.error {
    background: rgba(245, 108, 108, 0.05);
    border-color: rgba(245, 108, 108, 0.15);
  }
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stage-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 14px;
  font-weight: 600;
  transition: all 0.3s ease;
  
  .icon-finish {
    color: #67c23a;
    font-size: 16px;
  }
  
  .icon-error {
    color: #f56c6c;
    font-size: 16px;
  }
  
  .icon-process {
    color: #409eff;
    font-size: 16px;
    animation: rotate 1s linear infinite;
  }
  
  .icon-wait {
    color: rgba(128, 128, 128, 1);
    font-size: 16px;
    animation: rotate 2s linear infinite;
  }
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.stage-info {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stage-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: 0.2px;
}

.stage-percent {
  font-size: 13px;
  font-weight: 700;
  color: #409eff;
  min-width: 42px;
  text-align: right;
  font-family: 'Consolas', 'Monaco', monospace;
  letter-spacing: 0.5px;
  
  .finished & {
    color: #67c23a;
  }
}

.stage-progress {
  padding-left: 34px;
  
  :deep(.el-progress-bar__outer) {
    background-color: rgba(0, 0, 0, 0.08);
  }
  
  :deep(.el-progress-bar__inner) {
    background: linear-gradient(90deg, #409eff, #66b1ff);
    transition: all 0.3s ease;
  }
  
  .finished & :deep(.el-progress-bar__inner) {
    background: linear-gradient(90deg, #67c23a, #85ce61);
  }
}

.error-section {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
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
  gap: var(--spacing-base);
}

.messages-title {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 13px;
  letter-spacing: 0.3px;
  opacity: 0.85;
}

.progress-messages {
  max-height: 160px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: var(--radius-lg);
  padding: 10px var(--spacing-md);
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
  
  &::-webkit-scrollbar {
    width: 5px;
  }
  
  &::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.1);
    border-radius: var(--radius-sm);
  }
  
  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: var(--radius-sm);
    
    &:hover {
      background: rgba(255, 255, 255, 0.3);
    }
  }
}

.message-item {
  color: rgba(255, 255, 255, 0.85);
  padding: var(--spacing-xs) 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.9;
  transition: opacity 0.2s ease;
  
  &:hover {
    opacity: 1;
  }
  
  &:not(:last-child) {
    margin-bottom: 3px;
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

/* 浅色主题适配 */
:root:not([data-theme="dark"]) {
  .progress-messages {
    background: rgba(0, 0, 0, 0.06);
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.08);
  }
  
  .message-item {
    color: rgba(0, 0, 0, 0.75);
    
    &:hover {
      color: rgba(0, 0, 0, 0.9);
    }
  }
  
  .messages-title {
    color: rgba(0, 0, 0, 0.65);
  }
  
  .progress-messages::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.05);
  }
  
  .progress-messages::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.2);
    
    &:hover {
      background: rgba(0, 0, 0, 0.3);
    }
  }
}
</style>
