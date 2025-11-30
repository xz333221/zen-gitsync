<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, onMounted, onUnmounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Delete, CopyDocument, ArrowDown, ArrowUp, Clock, Loading } from '@element-plus/icons-vue';
import { useGitStore } from '@stores/gitStore';
import CommonDialog from '@/components/CommonDialog.vue';

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
        ElMessage.error(`${$t('@81F0F:加载命令历史失败: ')}${result.error}`);
      }
    }
  } catch (error) {
    ElMessage.error(`${$t('@81F0F:加载命令历史失败: ')}${(error as Error).message}`);
  } finally {
    isLoading.value = false;
  }
}

// 复制所有命令历史
async function copyAllHistory() {
  if (commandHistory.value.length === 0) {
    ElMessage.warning($t('@81F0F:没有可复制的命令历史'));
    return;
  }
  
  try {
    isCopyingHistory.value = true;
    
    // 格式化所有命令历史为文本
    const historyText = commandHistory.value.map(item => {
      // 基本格式：命令 + 时间 + 耗时 + 状态
      let text = `# ${formatTimestamp(item.timestamp)}${$t('@81F0F: (耗时: ')}${formatExecutionTime(item.executionTime)}) - ${item.success ? $t('@81F0F:成功') : $t('@81F0F:失败')}\n`;
      text += `${item.command}\n`;
      
      // 添加输出（如果需要）
      if (item.stdout) {
        text += `\n# 输出:\n${item.stdout}\n`;
      }
      
      // 添加stderr输出（根据命令类型决定标签）
      if (item.stderr) {
        const stderrLabel = isStderrNormalOutput(item.command) ? $t('@81F0F:输出信息') : $t('@81F0F:错误输出');
        text += `\n# ${stderrLabel}:\n${item.stderr}\n`;
      }
      
      if (item.error) {
        text += `\n# 错误信息:\n${item.error}\n`;
      }
      
      return text;
    }).join('\n---\n\n');
    
    await navigator.clipboard.writeText(historyText);
    ElMessage({
      message: $t('@81F0F:命令历史已复制到剪贴板'),
      type: 'success',
      zIndex: 100000
    });
  } catch (error) {
    ElMessage.error(`${$t('@81F0F:复制失败: ')}${(error as Error).message}`);
  } finally {
    isCopyingHistory.value = false;
  }
}

// 只复制命令列表
async function copyCommandsOnly() {
  if (commandHistory.value.length === 0) {
    ElMessage.warning($t('@81F0F:没有可复制的命令'));
    return;
  }
  
  try {
    isCopyingCommands.value = true;
    
    // 只提取命令部分
    const commandsText = commandHistory.value
      .map(item => item.command)
      .join('\n');
    
    await navigator.clipboard.writeText(commandsText);
    ElMessage({
      message: $t('@81F0F:命令列表已复制到剪贴板'),
      type: 'success',
      zIndex: 100000
    });
  } catch (error) {
    ElMessage.error(`${$t('@81F0F:复制失败: ')}${(error as Error).message}`);
  } finally {
    isCopyingCommands.value = false;
  }
}

// 清空命令历史记录
async function clearCommandHistory() {
  try {
    // 先确认是否要清空
    await ElMessageBox.confirm(
      $t('@81F0F:确定要清空所有命令历史记录吗？此操作不可恢复。'),
      $t('@81F0F:清空命令历史'),
      {
        confirmButtonText: $t('@81F0F:确定'),
        cancelButtonText: $t('@81F0F:取消'),
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
        ElMessage.success($t('@81F0F:命令历史已清空'));
      } else {
        ElMessage.error(`${$t('@81F0F:清空命令历史失败: ')}${result.error}`);
      }
    }
  } catch (error: any) {
    // 用户取消操作不显示错误
    if (error !== 'cancel' && error.toString() !== 'Error: cancel') {
      ElMessage.error(`${$t('@81F0F:清空命令历史失败: ')}${error.message}`);
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
    ElMessage({
      message: $t('@81F0F:命令已复制到剪贴板'),
      type: 'success',
      zIndex: 100000
    });
  } catch (error) {
    ElMessage.error(`${$t('@81F0F:复制失败: ')}${(error as Error).message}`);
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
      const stderrLabel = isStderrNormalOutput(item.command) ? $t('@81F0F:输出信息') : $t('@81F0F:错误输出');
      outputText += `${stderrLabel}:\n${item.stderr}\n\n`;
    }

    if (item.error) outputText += `错误信息:\n${item.error}`;

    await navigator.clipboard.writeText(outputText.trim());
    ElMessage({
      message: $t('@81F0F:输出已复制到剪贴板'),
      type: 'success',
      zIndex: 100000
    });
  } catch (error) {
    ElMessage.error(`${$t('@81F0F:复制失败: ')}${(error as Error).message}`);
  }
}

// 初始化WebSocket监听
function initSocketListeners() {
  if (!gitStore.socket) {
    console.error($t('@81F0F:Socket实例不可用'));
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
      ElMessage.success($t('@81F0F:命令历史已清空'));
    }
    isClearingHistory.value = false;
  });
  
  // 监听Socket连接/断开事件
  gitStore.socket.on('connect', () => {
    hasSocketConnection.value = true;
    ElMessage.success($t('@81F0F:已连接到实时命令历史'));
  });
  
  gitStore.socket.on('disconnect', () => {
    hasSocketConnection.value = false;
    ElMessage.warning($t('@81F0F:实时命令历史连接已断开'));
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
    console.log($t('@81F0F:尝试初始化Socket连接'));
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
  <el-tooltip :content="$t('@81F0F:查看Git命令历史')" placement="bottom" effect="dark" :show-after="200">
    <button class="modern-btn btn-icon-36" @click="openCommandHistory">
      <el-icon class="btn-icon">
        <Clock />
      </el-icon>
    </button>
  </el-tooltip>

  <!-- 命令历史弹窗（使用 CommonDialog） -->
  <CommonDialog
    v-model="dialogVisible"
    :title="$t('@81F0F:Git 命令历史')"
    destroy-on-close
    custom-class="command-history-dialog"
    :append-to-body="true"
  >
      <div class="dialog-toolbar">
        <el-tag
          :type="hasSocketConnection ? 'success' : 'danger'"
          size="small"
          effect="dark"
          class="socket-status"
        >
          {{ hasSocketConnection ? $t('@81F0F:实时更新') : $t('@81F0F:未连接') }}
        </el-tag>
        <el-tooltip :content="$t('@81F0F:只复制命令列表（不含输出）')" placement="bottom" effect="dark" :show-after="200">
          <button 
            class="modern-btn copy-commands-button enhanced-btn" 
            @click="copyCommandsOnly"
            :disabled="commandHistory.length === 0 || isCopyingCommands"
          >
            <el-icon class="btn-icon" v-if="!isCopyingCommands">
              <CopyDocument />
            </el-icon>
            <el-icon class="btn-icon is-loading" v-else>
              <Loading />
            </el-icon>
            <span class="btn-text">{{ $t('@81F0F:命令') }}</span>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@81F0F:复制完整命令历史（含输出）')" placement="bottom" effect="dark" :show-after="200">
          <button 
            class="modern-btn copy-all-button enhanced-btn" 
            @click="copyAllHistory"
            :disabled="commandHistory.length === 0 || isCopyingHistory"
          >
            <el-icon class="btn-icon" v-if="!isCopyingHistory">
              <CopyDocument />
            </el-icon>
            <el-icon class="btn-icon is-loading" v-else>
              <Loading />
            </el-icon>
            <span class="btn-text">{{ $t('@81F0F:全部') }}</span>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@81F0F:清空命令历史')" placement="bottom" effect="dark" :show-after="200">
          <button 
            class="modern-btn clear-button enhanced-btn danger-btn" 
            @click="clearCommandHistory"
            :disabled="commandHistory.length === 0 || isClearingHistory"
          >
            <el-icon class="btn-icon" v-if="!isClearingHistory">
              <Delete />
            </el-icon>
            <el-icon class="btn-icon is-loading" v-else>
              <Loading />
            </el-icon>
            <span class="btn-text">{{ $t('@81F0F:清空') }}</span>
          </button>
        </el-tooltip>
      </div>
      <div class="history-scroll">
      <div v-if="isLoading && commandHistory.length === 0" class="loading-state">
        <el-icon class="loading-icon is-loading">
          <Loading />
        </el-icon>
        <div class="loading-text">{{ $t('@81F0F:加载命令历史...') }}</div>
      </div>

      <el-empty v-else-if="commandHistory.length === 0" :description="$t('@81F0F:暂无命令历史')" />

      <div v-else class="history-list">
        <div v-for="(item, index) in commandHistory" :key="index" class="history-item" :class="{ 'is-error': !item.success }">
          <div class="item-header" @click="toggleExpand(index)">
            <div class="command-info">
              <div class="command-text">
                <el-tag size="small" :type="item.success ? 'success' : 'danger'" effect="dark" class="status-tag">
                  {{ item.success ? $t('@81F0F:成功') : $t('@81F0F:失败') }}
                </el-tag>
                <code>{{ item.command }}</code>
              </div>
              <div class="command-meta">
                <span class="timestamp">{{ formatTimestamp(item.timestamp) }}</span>
                <span class="duration">{{ $t('@81F0F:耗时: ') }}{{ formatExecutionTime(item.executionTime) }}</span>
              </div>
            </div>
            <div class="item-actions">
              <el-tooltip :content="$t('@81F0F:复制命令')" placement="bottom" effect="dark" :show-after="200">
                <button 
                  class="modern-btn item-copy-button enhanced-btn" 
                  @click.stop="copyCommand(item.command)"
                >
                  <el-icon class="btn-icon">
                    <CopyDocument />
                  </el-icon>
                </button>
              </el-tooltip>
              <div class="expand-button" :class="{ 'is-expanded': isExpanded(index) }">
                <el-icon class="btn-icon">
                  <ArrowUp v-if="isExpanded(index)" />
                  <ArrowDown v-else />
                </el-icon>
              </div>
            </div>
          </div>

          <div v-if="isExpanded(index)" class="item-details">
            <div v-if="item.stdout" class="output-section">
              <div class="output-header">
                <h4>{{ $t('@81F0F:标准输出') }}</h4>
                <el-tooltip :content="$t('@81F0F:复制输出')" placement="bottom" effect="dark" :show-after="200">
                  <button 
                    class="modern-btn output-copy-button enhanced-btn" 
                    @click="copyOutput(item)"
                  >
                    <el-icon class="btn-icon">
                      <CopyDocument />
                    </el-icon>
                  </button>
                </el-tooltip>
              </div>
              <pre class="output-content">{{ item.stdout }}</pre>
              <div v-if="item.isStdoutTruncated" class="truncation-notice">
                <el-alert type="info" :closable="false" show-icon>
                  {{ $t('@81F0F:输出内容过长已被截断，请直接执行命令查看完整输出') }}
                </el-alert>
              </div>
            </div>

            <div v-if="item.stderr" :class="['output-section', isStderrNormalOutput(item.command) ? '' : 'error']">
              <div class="output-header">
                <h4>{{ isStderrNormalOutput(item.command) ? $t('@81F0F:输出信息') : $t('@81F0F:错误输出') }}</h4>
              </div>
              <pre class="output-content">{{ item.stderr }}</pre>
              <div v-if="item.isStderrTruncated" class="truncation-notice">
                <el-alert type="info" :closable="false" show-icon>
                  {{ isStderrNormalOutput(item.command) ? $t('@81F0F:输出信息') : $t('@81F0F:错误输出') }}{{ $t('@81F0F:内容过长已被截断，请直接执行命令查看完整输出') }}
                </el-alert>
              </div>
            </div>

            <div v-if="item.error" class="output-section error">
              <div class="output-header">
                <h4>{{ $t('@81F0F:错误信息') }}</h4>
              </div>
              <pre class="output-content">{{ item.error }}</pre>
            </div>
          </div>
        </div>
      </div>
      </div>
  </CommonDialog>
</template>

<style lang="scss" scoped>
/* 命令历史按钮样式 */
.command-history-button {
  width: 36px;
  height: 36px;
  padding: 0;
}

.history-scroll {
  flex-grow: 1;
  overflow-y: auto;
}
/* 弹窗内按钮样式调整 */
.dialog-content .modern-btn {
  background: rgba(0, 0, 0, 0.05);
  color: rgba(0, 0, 0, 0.8);
  border: 1px solid rgba(0, 0, 0, 0.1);
}

.dialog-content .modern-btn:hover {
  background: rgba(0, 0, 0, 0.08);
  color: rgba(0, 0, 0, 1);
  border-color: rgba(0, 0, 0, 0.15);
}

/* 增强按钮样式 */
.enhanced-btn {
  min-width: 60px;
  height: 36px;
  padding: var(--spacing-base);
  gap: 6px;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 500;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.enhanced-btn .btn-text {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  z-index: 1;
  position: relative;
}

.enhanced-btn .btn-icon {
  font-size: 18px;
  z-index: 1;
  position: relative;
}

/* 危险按钮样式 */
.danger-btn {
  background: rgba(245, 108, 108, 0.1);
  color: var(--color-danger);
  border-color: rgba(245, 108, 108, 0.2);
}

.danger-btn::before {
  background: linear-gradient(135deg, rgba(245, 108, 108, 0.15) 0%, rgba(255, 77, 79, 0.15) 100%);
}

.danger-btn:hover {
  background: rgba(245, 108, 108, 0.15);
  color: var(--color-danger);
  border-color: rgba(245, 108, 108, 0.3);
  box-shadow: var(--shadow-md);
}

/* 工具栏按钮特殊尺寸 */
.copy-commands-button,
.copy-all-button,
.clear-button {
  min-width: 70px;
  height: 36px;
  font-weight: 600;
}

/* 按钮组整体样式 */
.dialog-toolbar .enhanced-btn {
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(0, 0, 0, 0.08);
  color: rgba(0, 0, 0, 0.85);
  box-shadow: var(--shadow-sm);
}

.dialog-toolbar .enhanced-btn:hover {
  background: rgba(255, 255, 255, 1);
  border-color: rgba(0, 0, 0, 0.12);
  color: rgba(0, 0, 0, 1);
  box-shadow: var(--shadow-lg);
}

/* 深色主题下：工具栏主按钮（命令 / 全部）配色 */
[data-theme="dark"] .dialog-toolbar .enhanced-btn {
  background: var(--bg-container);
  color: var(--text-primary);
  border-color: var(--border-component);
  box-shadow: var(--shadow-md);
}

[data-theme="dark"] .dialog-toolbar .enhanced-btn:hover {
  background: var(--bg-container-hover);
  color: var(--color-white);
  border-color: var(--border-component-light);
  box-shadow: var(--shadow-lg);
}

.dialog-toolbar .danger-btn {
  background: rgba(245, 108, 108, 0.08);
  color: var(--color-danger);
  border-color: rgba(245, 108, 108, 0.15);
}

.dialog-toolbar .danger-btn:hover {
  background: rgba(245, 108, 108, 0.12);
  color: var(--color-danger);
  border-color: rgba(245, 108, 108, 0.25);
  box-shadow: var(--shadow-md);
}

/* 深色主题下：危险按钮配色与可读性 */
[data-theme="dark"] .dialog-toolbar .danger-btn {
  background: #2d1a1a; /* 深红底（无透明） */
  color: var(--color-danger);
  border-color: #7a2e2e;
}

[data-theme="dark"] .dialog-toolbar .danger-btn:hover {
  background: #3a2020;
  color: #ff8f8f;
  border-color: #a33c3c;
  box-shadow: var(--shadow-lg);
}

/* 小按钮尺寸 */
.item-copy-button,
.output-copy-button {
  width: 32px;
  height: 32px;
  padding: 0 !important;
}

.item-copy-button .btn-icon,
.output-copy-button .btn-icon {
  font-size: 16px;
}

.item-copy-button .btn-text,
.output-copy-button .btn-text {
  display: none;
}

/* 小按钮的悬浮效果调整 */
.item-copy-button:hover,
.output-copy-button:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.item-copy-button:active,
.output-copy-button:active {
  transform: translateY(0);
  box-shadow: var(--shadow-md);
}

/* 展开指示器样式（非交互式） */
.expand-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  color: var(--text-secondary);
  transition: transform 0.3s ease;
}

.expand-button .btn-icon {
  font-size: 16px;
  transition: transform 0.3s ease;
}

.enhanced-btn:active {
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

/* 按钮加载状态 */
.enhanced-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none;
}

.enhanced-btn:disabled:hover {
  transform: none;
  box-shadow: none;
}

/* 展开按钮动画 */
.expand-button.is-expanded .btn-icon {
  transform: rotate(180deg);
}

/* 弹窗样式 */
.command-history-dialog {
  border-radius: var(--radius-lg);
  z-index: 9999 !important;
}

:deep(.command-history-dialog .el-overlay) {
  z-index: 9998 !important;
}

:deep(.command-history-dialog .el-dialog) {
  z-index: 9999 !important;
}


.dialog-toolbar {
  padding: var(--spacing-lg) var(--spacing-xl);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-md);
  background: linear-gradient(135deg, #f8f9fa 0%, var(--border-component) 100%);
  border-bottom: 1px solid var(--border-component);
  border-radius: 8px 8px 0 0;
}

/* 深色主题下的工具栏 */
[data-theme="dark"] .dialog-toolbar {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0%, rgba(255, 255, 255, 0.02) 100%);
  border-bottom-color: rgba(255, 255, 255, 0.1);
}

.socket-status { 
  font-size: 12px;
  margin-right: auto;
  font-weight: 500;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 100px;
}

.loading-icon {
  font-size: 36px;
  color: var(--color-primary);
  margin-bottom: 10px;
}

.loading-text {
  font-size: 14px;
  color: var(--text-secondary);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  overflow-y: auto;
  flex: 1;
}

.history-item {
  border: 1px solid var(--border-card);
  border-radius: var(--radius-base);
  transition: all 0.2s;
  overflow: hidden;
}

/* 深色主题下的历史项 */
[data-theme="dark"] .history-item {
  border-color: rgba(255, 255, 255, 0.1);
  background-color: rgba(255, 255, 255, 0.03);
}

[data-theme="dark"] .history-item:hover {
  background-color: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.history-item:hover {
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.history-item.is-error {
  border-left: 3px solid var(--color-danger);
}

.item-header {
  padding: 10px var(--spacing-md);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  transition: background-color 0.2s;
}

.item-header:hover {
  background-color: var(--bg-icon-hover);
}

/* 深色主题通过CSS变量自动处理，无需手动覆盖 */

.command-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.command-text {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-sm);
}

.command-text code {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 13px;
  
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

/* 深色主题下的命令文本 */
[data-theme="dark"] .command-text code {
  color: rgba(255, 255, 255, 0.9);
}

.command-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  font-size: 12px;
  color: var(--text-tertiary);
}

/* 深色主题下的命令元数据 */
[data-theme="dark"] .command-meta {
  color: rgba(255, 255, 255, 0.6);
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
  margin-left: var(--spacing-base);
}

.item-details {
  padding: 10px var(--spacing-md);
  border-top: 1px solid var(--border-card);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* 深色主题下的详情区域 */
[data-theme="dark"] .item-details {
  border-top-color: rgba(255, 255, 255, 0.1);
  background-color: rgba(255, 255, 255, 0.02);
}

.output-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.output-section.error {
  border-left: 3px solid var(--color-danger);
  padding-left: var(--spacing-base);
}

/* 为正常的stderr输出（如git push）添加不同的样式 */
.output-section:not(.error) {
  border-left: 3px solid var(--color-success);
  padding-left: var(--spacing-base);
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
  color: var(--text-secondary);
}

/* 深色主题下的输出头部 */
[data-theme="dark"] .output-header h4 {
  color: rgba(255, 255, 255, 0.8);
}

.output-content {
  padding: 10px;
  border-radius: var(--radius-base);
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--border-card);
}

/* 深色主题下的输出内容 */
[data-theme="dark"] .output-content {
  background-color: rgba(0, 0, 0, 0.3);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
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
  background-color: var(--text-placeholder);
  border-radius: var(--radius-sm);
}

.output-content::-webkit-scrollbar-track {
  background-color: var(--bg-panel);
}
</style>

<!-- 全局样式确保弹窗在最上层 -->
<style>
.command-history-dialog {
  z-index: 1999 !important;
}

.el-overlay {
  z-index: 1998 !important;
}

</style>
