<script setup lang="ts">
import { ref, computed, reactive } from 'vue';
import { ElDialog, ElProgress, ElIcon } from 'element-plus';
import { Check, Close, Loading, CircleCheck } from '@element-plus/icons-vue';
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
    title=""
    width="550px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="status !== 'progress'"
    :append-to-body="true"
    :lock-scroll="false"
    destroy-on-close
    class="push-progress-dialog"
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

      <!-- 多阶段进度 -->
      <div class="stages-section">
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
              <div v-else class="icon-wait">{{ index + 1 }}</div>
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

.push-progress-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px 0;
  max-height: 70vh;
  overflow-y: auto;
  
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
  padding: 8px 0;
}

.status-icon {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  position: relative;
  transition: all 0.3s ease;
  
  &::before {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    padding: 2px;
    background: linear-gradient(135deg, currentColor, transparent);
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask-composite: exclude;
    opacity: 0.3;
  }
  
  &.progress {
    background: linear-gradient(135deg, rgba(64, 158, 255, 0.15), rgba(64, 158, 255, 0.05));
    color: #409eff;
    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.2);
  }
  
  &.success {
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.15), rgba(103, 194, 58, 0.05));
    color: #67c23a;
    box-shadow: 0 4px 12px rgba(103, 194, 58, 0.25);
    animation: success-pulse 0.6s ease;
  }
  
  &.error {
    background: linear-gradient(135deg, rgba(245, 108, 108, 0.15), rgba(245, 108, 108, 0.05));
    color: #f56c6c;
    box-shadow: 0 4px 12px rgba(245, 108, 108, 0.2);
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

@keyframes success-pulse {
  0%, 100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.1);
  }
}

.status-text {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.stages-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 0;
}

.stage-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bg-panel);
  border: 2px solid transparent;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: transparent;
    transition: all 0.3s ease;
  }
  
  &.active {
    border-color: rgba(64, 158, 255, 0.3);
    background: linear-gradient(135deg, rgba(64, 158, 255, 0.08), rgba(64, 158, 255, 0.02));
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
    
    &::before {
      background: linear-gradient(90deg, transparent, #409eff, transparent);
      animation: shimmer 2s infinite;
    }
  }
  
  &.finished {
    border-color: rgba(103, 194, 58, 0.3);
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.08), rgba(103, 194, 58, 0.02));
    box-shadow: 0 2px 8px rgba(103, 194, 58, 0.1);
    
    &::before {
      background: linear-gradient(90deg, #67c23a, #67c23a);
    }
  }
  
  &.error {
    border-color: rgba(245, 108, 108, 0.3);
    background: linear-gradient(135deg, rgba(245, 108, 108, 0.08), rgba(245, 108, 108, 0.02));
    box-shadow: 0 2px 8px rgba(245, 108, 108, 0.1);
  }
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stage-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 18px;
  font-weight: 600;
  transition: all 0.3s ease;
  
  .icon-finish {
    color: #67c23a;
    background: rgba(103, 194, 58, 0.12);
    padding: 6px;
    border-radius: 50%;
  }
  
  .icon-error {
    color: #f56c6c;
    background: rgba(245, 108, 108, 0.12);
    padding: 6px;
    border-radius: 50%;
  }
  
  .icon-process {
    color: #409eff;
    background: rgba(64, 158, 255, 0.12);
    padding: 6px;
    border-radius: 50%;
  }
  
  .icon-wait {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--border-color);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    opacity: 0.6;
  }
}

.stage-info {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.stage-label {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-primary);
  letter-spacing: 0.3px;
}

.stage-percent {
  font-size: 14px;
  font-weight: 700;
  color: #409eff;
  min-width: 45px;
  text-align: right;
  font-family: 'Consolas', 'Monaco', monospace;
  letter-spacing: 0.5px;
  
  .finished & {
    color: #67c23a;
  }
}

.stage-progress {
  padding-left: 44px;
  
  :deep(.el-progress-bar__outer) {
    background-color: rgba(0, 0, 0, 0.1);
  }
  
  :deep(.el-progress-bar__inner) {
    background: linear-gradient(90deg, #409eff, #66b1ff);
    box-shadow: 0 0 8px rgba(64, 158, 255, 0.3);
    transition: all 0.3s ease;
  }
  
  .finished & :deep(.el-progress-bar__inner) {
    background: linear-gradient(90deg, #67c23a, #85ce61);
    box-shadow: 0 0 8px rgba(103, 194, 58, 0.3);
  }
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
  margin-top: 4px;
}

.messages-title {
  font-weight: 600;
  color: var(--text-secondary);
  font-size: 13px;
  letter-spacing: 0.3px;
  opacity: 0.85;
}

.progress-messages {
  max-height: 140px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 12px 14px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
  
  &::-webkit-scrollbar {
    width: 6px;
  }
  
  &::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.1);
    border-radius: 3px;
  }
  
  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
    
    &:hover {
      background: rgba(255, 255, 255, 0.3);
    }
  }
}

.message-item {
  color: rgba(255, 255, 255, 0.85);
  padding: 2px 0;
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
</style>
