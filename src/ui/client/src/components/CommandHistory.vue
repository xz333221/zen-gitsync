<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, CopyDocument, ArrowDown, ArrowUp, Clock } from '@element-plus/icons-vue';
import { useGitStore } from '../stores/gitStore';

// 获取Git Store以访问Socket实例
const gitStore = useGitStore();

// Define the structure of a command history item
interface CommandHistoryItem {
  command: string;
  stdout: string;
  stderr: string;
  error: string | null;
  executionTime: number;
  timestamp: string;
  success: boolean;
  isStdoutTruncated: boolean;
  isStderrTruncated: boolean;
}

const commandHistory = ref<CommandHistoryItem[]>([]);
const isLoading = ref(false);
const isClearingHistory = ref(false);
const isCopyingHistory = ref(false);
const hasSocketConnection = ref(false);
const expandedItems = ref<Set<number>>(new Set());
// 添加新变量来跟踪复制命令列表的加载状态
const isCopyingCommands = ref(false);
// 弹窗显示状态
const dialogVisible = ref(false);

// 打开命令历史弹窗
function openCommandHistory() {
  dialogVisible.value = true;
  // 如果还没有加载过历史记录，则加载
  if (commandHistory.value.length === 0) {
    loadHistory();
  }
}

// 加载命令历史 - 仅用于初始加载或手动刷新
async function loadHistory() {
  try {
    isLoading.value = true;
    
    if (gitStore.socket && gitStore.socket.connected) {
      // 通过WebSocket请求完整历史
      gitStore.socket.emit('request_full_history');
    } else {
      // 作为后备，使用HTTP接口获取
      const response = await fetch('/api/command-history');
      const result = await response.json();
      
      if (result.success) {
        commandHistory.value = result.history;
      } else {
        ElMessage.error(`加载命令历史失败: ${result.error}`);
      }
    }
  } catch (error) {
    ElMessage.error(`加载命令历史失败: ${(error as Error).message}`);
  } finally {
    isLoading.value = false;
  }
}

// 复制所有命令历史
async function copyAllHistory() {
  if (commandHistory.value.length === 0) {
    ElMessage.warning('没有可复制的命令历史');
    return;
  }
  
  try {
    isCopyingHistory.value = true;
    
    // 格式化所有命令历史为文本
    const historyText = commandHistory.value.map(item => {
      // 基本格式：命令 + 时间 + 耗时 + 状态
      let text = `# ${formatTimestamp(item.timestamp)} (耗时: ${formatExecutionTime(item.executionTime)}) - ${item.success ? '成功' : '失败'}\n`;
      text += `${item.command}\n`;
      
      // 添加输出（如果需要）
      if (item.stdout) {
        text += `\n# 输出:\n${item.stdout}\n`;
      }
      
      // 添加stderr输出（根据命令类型决定标签）
      if (item.stderr) {
        const stderrLabel = isStderrNormalOutput(item.command) ? '输出信息' : '错误输出';
        text += `\n# ${stderrLabel}:\n${item.stderr}\n`;
      }
      
      if (item.error) {
        text += `\n# 错误信息:\n${item.error}\n`;
      }
      
      return text;
    }).join('\n---\n\n');
    
    await navigator.clipboard.writeText(historyText);
    ElMessage.success('命令历史已复制到剪贴板');
  } catch (error) {
    ElMessage.error(`复制失败: ${(error as Error).message}`);
  } finally {
    isCopyingHistory.value = false;
  }
}

// 只复制命令列表
async function copyCommandsOnly() {
  if (commandHistory.value.length === 0) {
    ElMessage.warning('没有可复制的命令');
    return;
  }
  
  try {
    isCopyingCommands.value = true;
    
    // 只提取命令部分
    const commandsText = commandHistory.value
      .map(item => item.command)
      .join('\n');
    
    await navigator.clipboard.writeText(commandsText);
    ElMessage.success('命令列表已复制到剪贴板');
  } catch (error) {
    ElMessage.error(`复制失败: ${(error as Error).message}`);
  } finally {
    isCopyingCommands.value = false;
  }
}

// 清空命令历史记录
async function clearCommandHistory() {
  try {
    // 先确认是否要清空
    await ElMessageBox.confirm(
      '确定要清空所有命令历史记录吗？此操作不可恢复。',
      '清空命令历史',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );
    
    isClearingHistory.value = true;
    
    // 优先使用WebSocket
    if (gitStore.socket && gitStore.socket.connected) {
      gitStore.socket.emit('clear_command_history');
    } else {
      // 后备方案：使用HTTP API
      const response = await fetch('/api/clear-command-history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        commandHistory.value = [];
        ElMessage.success('命令历史已清空');
      } else {
        ElMessage.error(`清空命令历史失败: ${result.error}`);
      }
    }
  } catch (error: any) {
    // 用户取消操作不显示错误
    if (error !== 'cancel' && error.toString() !== 'Error: cancel') {
      ElMessage.error(`清空命令历史失败: ${error.message}`);
    }
  } finally {
    isClearingHistory.value = false;
  }
}

// Format timestamp to a more readable format
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

// Format execution time
function formatExecutionTime(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  } else {
    return `${(ms / 1000).toFixed(2)}s`;
  }
}

// Toggle expansion of a command result
function toggleExpand(index: number) {
  if (expandedItems.value.has(index)) {
    expandedItems.value.delete(index);
  } else {
    expandedItems.value.add(index);
  }
}

// Check if a command is expanded
function isExpanded(index: number): boolean {
  return expandedItems.value.has(index);
}

// Copy command to clipboard
async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    ElMessage.success('命令已复制到剪贴板');
  } catch (error) {
    ElMessage.error(`复制失败: ${(error as Error).message}`);
  }
}

// 判断是否是Git push相关命令
function isGitPushCommand(command: string): boolean {
  return command.includes('git push') || command.includes('git-push');
}

// 判断stderr是否应该被视为正常输出
function isStderrNormalOutput(command: string): boolean {
  // Git push命令的stderr通常包含正常的推送信息
  if (isGitPushCommand(command)) {
    return true;
  }

  // 可以在这里添加其他命令的特殊处理
  return false;
}

// Copy output to clipboard
async function copyOutput(item: CommandHistoryItem) {
  try {
    let outputText = '';
    if (item.stdout) outputText += `标准输出:\n${item.stdout}\n\n`;

    if (item.stderr) {
      // 根据命令类型决定标签
      const stderrLabel = isStderrNormalOutput(item.command) ? '输出信息' : '错误输出';
      outputText += `${stderrLabel}:\n${item.stderr}\n\n`;
    }

    if (item.error) outputText += `错误信息:\n${item.error}`;

    await navigator.clipboard.writeText(outputText.trim());
    ElMessage.success('输出已复制到剪贴板');
  } catch (error) {
    ElMessage.error(`复制失败: ${(error as Error).message}`);
  }
}

// 初始化WebSocket监听
function initSocketListeners() {
  if (!gitStore.socket) {
    console.error('Socket实例不可用');
    return;
  }
  
  // 监听初始命令历史
  gitStore.socket.on('initial_command_history', (data: { history: CommandHistoryItem[] }) => {
    commandHistory.value = data.history;
    hasSocketConnection.value = true;
  });
  
  // 监听命令历史更新
  gitStore.socket.on('command_history_update', (data: { 
    newCommand: CommandHistoryItem,
    fullHistory: CommandHistoryItem[]
  }) => {
    // 将新命令添加到历史记录的开头
    commandHistory.value.unshift(data.newCommand);
    
    // 确保不超过100条记录
    if (commandHistory.value.length > 100) {
      commandHistory.value.pop();
    }
    
    hasSocketConnection.value = true;
  });
  
  // 监听完整历史响应
  gitStore.socket.on('full_command_history', (data: { history: CommandHistoryItem[] }) => {
    commandHistory.value = data.history;
    isLoading.value = false;
    hasSocketConnection.value = true;
  });
  
  // 监听历史清空事件
  gitStore.socket.on('command_history_cleared', (data: { success: boolean }) => {
    if (data.success) {
      commandHistory.value = [];
      ElMessage.success('命令历史已清空');
    }
    isClearingHistory.value = false;
  });
  
  // 监听Socket连接/断开事件
  gitStore.socket.on('connect', () => {
    hasSocketConnection.value = true;
    ElMessage.success('已连接到实时命令历史');
  });
  
  gitStore.socket.on('disconnect', () => {
    hasSocketConnection.value = false;
    ElMessage.warning('实时命令历史连接已断开');
  });
}

// 清除WebSocket监听器
function cleanupSocketListeners() {
  if (gitStore.socket) {
    gitStore.socket.off('initial_command_history');
    gitStore.socket.off('command_history_update');
    gitStore.socket.off('full_command_history');
    gitStore.socket.off('command_history_cleared');
  }
}

// Load history on component mount
onMounted(() => {
  // 初始化Socket.io监听器
  initSocketListeners();

  // 确保Socket已初始化
  if (!gitStore.socket) {
    console.log('尝试初始化Socket连接');
    gitStore.initSocketConnection();
  }

  // 不再自动加载历史记录，改为在弹窗打开时加载
});

// 清理工作
onUnmounted(() => {
  cleanupSocketListeners();
});
</script>

<template>
  <!-- 命令历史按钮 -->
  <el-button
    type="primary"
    :icon="Clock"
    @click="openCommandHistory"
    class="command-history-button"
    title="查看Git命令历史"
  >
    命令历史
  </el-button>

  <!-- 命令历史弹窗 -->
  <Teleport to="body">
    <el-dialog
      v-model="dialogVisible"
      title="Git 命令历史"
      width="80%"
      top="5vh"
      destroy-on-close
      class="command-history-dialog"
      :z-index="99999"
      append-to-body
      modal
    >
    <div class="dialog-content">
      <div class="dialog-toolbar">
        <el-tag
          :type="hasSocketConnection ? 'success' : 'danger'"
          size="small"
          effect="dark"
          class="socket-status"
        >
          {{ hasSocketConnection ? '实时更新' : '未连接' }}
        </el-tag>
        <el-button
          type="success"
          :icon="CopyDocument"
          circle
          size="small"
          @click="copyCommandsOnly"
          :loading="isCopyingCommands"
          class="copy-commands-button"
          title="只复制命令列表（不含输出）"
          :disabled="commandHistory.length === 0"
        />
        <el-button
          type="primary"
          :icon="CopyDocument"
          circle
          size="small"
          @click="copyAllHistory"
          :loading="isCopyingHistory"
          class="copy-all-button"
          title="复制完整命令历史（含输出）"
          :disabled="commandHistory.length === 0"
        />
        <el-button
          type="danger"
          :icon="Delete"
          circle
          size="small"
          @click="clearCommandHistory"
          :loading="isClearingHistory"
          class="clear-button"
          title="清空命令历史"
          :disabled="commandHistory.length === 0"
        />
      </div>
      <div class="history-scroll">
      <div v-if="isLoading && commandHistory.length === 0" class="loading-state">
        <el-icon class="loading-icon is-loading">
          <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <path fill="currentColor"
              d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32zM195.2 195.2a32 32 0 0 1 45.248 0L376.32 331.008a32 32 0 0 1-45.248 45.248L195.2 240.448a32 32 0 0 1 0-45.248zm452.544 452.544a32 32 0 0 1 45.248 0L828.8 783.552a32 32 0 0 1-45.248 45.248L647.744 692.992a32 32 0 0 1 0-45.248zM828.8 195.264a32 32 0 0 1 0 45.184L692.992 376.32a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0zm-452.544 452.48a32 32 0 0 1 0 45.248L240.448 828.8a32 32 0 0 1-45.248-45.248l135.808-135.808a32 32 0 0 1 45.248 0z">
            </path>
          </svg>
        </el-icon>
        <div class="loading-text">加载命令历史...</div>
      </div>

      <el-empty v-else-if="commandHistory.length === 0" description="暂无命令历史" />

      <div v-else class="history-list">
        <div v-for="(item, index) in commandHistory" :key="index" class="history-item" :class="{ 'is-error': !item.success }">
          <div class="item-header" @click="toggleExpand(index)">
            <div class="command-info">
              <div class="command-text">
                <el-tag size="small" :type="item.success ? 'success' : 'danger'" effect="dark" class="status-tag">
                  {{ item.success ? '成功' : '失败' }}
                </el-tag>
                <code>{{ item.command }}</code>
              </div>
              <div class="command-meta">
                <span class="timestamp">{{ formatTimestamp(item.timestamp) }}</span>
                <span class="duration">耗时: {{ formatExecutionTime(item.executionTime) }}</span>
              </div>
            </div>
            <div class="item-actions">
              <el-button
                type="primary"
                :icon="CopyDocument"
                circle
                size="small"
                @click.stop="copyCommand(item.command)"
                title="复制命令"
              />
              <el-button
                :type="isExpanded(index) ? 'primary' : 'default'"
                :icon="isExpanded(index) ? ArrowUp : ArrowDown"
                circle
                size="small"
                @click.stop="toggleExpand(index)"
                title="展开/收起"
              />
            </div>
          </div>

          <div v-if="isExpanded(index)" class="item-details">
            <div v-if="item.stdout" class="output-section">
              <div class="output-header">
                <h4>标准输出</h4>
                <el-button
                  type="primary"
                  :icon="CopyDocument"
                  circle
                  size="small"
                  @click="copyOutput(item)"
                  title="复制输出"
                />
              </div>
              <pre class="output-content">{{ item.stdout }}</pre>
              <div v-if="item.isStdoutTruncated" class="truncation-notice">
                <el-alert type="info" :closable="false" show-icon>
                  输出内容过长已被截断，请直接执行命令查看完整输出
                </el-alert>
              </div>
            </div>

            <div v-if="item.stderr" :class="['output-section', isStderrNormalOutput(item.command) ? '' : 'error']">
              <div class="output-header">
                <h4>{{ isStderrNormalOutput(item.command) ? '输出信息' : '错误输出' }}</h4>
              </div>
              <pre class="output-content">{{ item.stderr }}</pre>
              <div v-if="item.isStderrTruncated" class="truncation-notice">
                <el-alert type="info" :closable="false" show-icon>
                  {{ isStderrNormalOutput(item.command) ? '输出信息' : '错误输出' }}内容过长已被截断，请直接执行命令查看完整输出
                </el-alert>
              </div>
            </div>

            <div v-if="item.error" class="output-section error">
              <div class="output-header">
                <h4>错误信息</h4>
              </div>
              <pre class="output-content">{{ item.error }}</pre>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  </el-dialog>
  </Teleport>
</template>

<style scoped>
/* 命令历史按钮样式 */
.command-history-button {
  transition: all 0.3s ease;
}

.command-history-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
}

/* 弹窗样式 */
.command-history-dialog {
  border-radius: 8px;
  z-index: 9999 !important;
}

:deep(.command-history-dialog .el-overlay) {
  z-index: 9998 !important;
}

:deep(.command-history-dialog .el-dialog) {
  z-index: 9999 !important;
}


.dialog-toolbar {
  padding: 12px 20px 12px 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.socket-status { font-size: 12px; }

.clear-button {
  transition: all 0.3s;
}

.clear-button:hover {
  transform: rotate(12deg);
  background-color: #ff4d4f;
  border-color: #ff4d4f;
}

.copy-all-button {
  transition: all 0.3s;
  position: relative;
}

.copy-all-button:hover {
  transform: translateY(-2px);
  background-color: #409EFF;
  border-color: #409EFF;
  box-shadow: 0 2px 6px rgba(64, 158, 255, 0.3);
}

.copy-commands-button {
  transition: all 0.3s;
  position: relative;
}

.copy-commands-button:hover {
  transform: translateY(-2px);
  background-color: #67C23A;
  border-color: #67C23A;
  box-shadow: 0 2px 6px rgba(103, 194, 58, 0.3);
}

.copy-commands-button::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.3);
  opacity: 0;
  transition: opacity 0.3s;
}

.copy-all-button::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background-color: rgba(255, 255, 255, 0.3);
  opacity: 0;
  transition: opacity 0.3s;
}

.copy-commands-button:active::after,
.copy-all-button:active::after {
  opacity: 1;
  animation: ripple 0.6s ease-out;
}

@keyframes ripple {
  0% {
    width: 0;
    height: 0;
    opacity: 0.5;
  }
  100% {
    width: 30px;
    height: 30px;
    opacity: 0;
  }
}

.dialog-content {
  padding: 0 20px 20px 20px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 100px;
}

.history-scroll {
  overflow-y: auto;
  max-height: calc(80vh - 160px);
}

.loading-icon {
  font-size: 36px;
  color: #409EFF;
  margin-bottom: 10px;
}

.loading-text {
  font-size: 14px;
  color: #606266;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  border: 1px solid #ebeef5;
  border-radius: 4px;
  transition: all 0.2s;
  background-color: #f8f9fa;
  overflow: hidden;
}

.history-item:hover {
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.history-item.is-error {
  border-left: 3px solid #f56c6c;
}

.item-header {
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  transition: background-color 0.2s;
}

.item-header:hover {
  background-color: #f0f2f5;
}

.command-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.command-text {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.command-text code {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.command-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 12px;
  color: #909399;
}

.timestamp {
  white-space: nowrap;
}

.duration {
  white-space: nowrap;
}

.item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}

.item-details {
  padding: 10px 12px;
  border-top: 1px solid #ebeef5;
  background-color: #fff;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.output-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.output-section.error {
  border-left: 3px solid #f56c6c;
  padding-left: 8px;
}

/* 为正常的stderr输出（如git push）添加不同的样式 */
.output-section:not(.error) {
  border-left: 3px solid #67c23a;
  padding-left: 8px;
}

.output-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.output-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: #606266;
}

.output-content {
  background-color: #f8f9fa;
  padding: 10px;
  border-radius: 4px;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid #ebeef5;
}

.status-tag {
  flex-shrink: 0;
}

.truncation-notice {
  margin-top: 6px;
}

/* Custom scrollbar for output-content */
.output-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.output-content::-webkit-scrollbar-thumb {
  background-color: #c0c4cc;
  border-radius: 3px;
}

.output-content::-webkit-scrollbar-track {
  background-color: #f5f7fa;
}
</style>

<!-- 全局样式确保弹窗在最上层 -->
<style>
.command-history-dialog {
  z-index: 99999 !important;
}

.el-overlay {
  z-index: 99998 !important;
}

.el-dialog {
  z-index: 99999 !important;
}

/* 确保命令历史弹窗的遮罩层在最上层 */
.el-overlay.is-message-box {
  z-index: 99998 !important;
}

.el-dialog.command-history-dialog {
  z-index: 99999 !important;
}
</style>
