<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Document, ArrowDown, FullScreen, Setting } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import CustomCommandManager from '@components/CustomCommandManager.vue';
import type { CustomCommand } from '@components/CustomCommandManager.vue';

// 控制台相关状态
const currentDirectory = ref("");
const consoleInput = ref("");
const consoleRunning = ref(false);

type ConsoleRecord = { 
  id: number; 
  command: string; 
  stdout?: string; 
  stderr?: string; 
  success: boolean; 
  ts: string; 
  expanded?: boolean 
};

const consoleHistory = ref<ConsoleRecord[]>([]);
let consoleIdCounter = 0; // ID计数器，确保唯一性

// 控制整个控制台展开/收起
const isConsoleExpanded = ref(false);

// 控制全屏状态
const isFullscreen = ref(false);

// 控制是否使用终端执行（默认开启）
const useTerminal = ref(true);

// 控制自定义命令管理弹窗
const commandManagerVisible = ref(false);

// 执行控制台命令
async function runConsoleCommand() {
  const cmd = consoleInput.value.trim();
  if (!cmd || consoleRunning.value) return;
  consoleRunning.value = true;
  
  // 如果使用终端执行
  if (useTerminal.value) {
    try {
      const resp = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
      });
      const result = await resp.json();
      if (result?.success) {
        ElMessage.success('已在新终端中执行命令');
      } else {
        ElMessage.error(result?.error || '执行失败');
      }
    } catch (e: any) {
      ElMessage.error(e?.message || '执行失败');
    } finally {
      consoleRunning.value = false;
      consoleInput.value = '';
    }
    return;
  }
  
  // 原有的后台执行逻辑
  const rec: ConsoleRecord = {
    id: ++consoleIdCounter, // 使用递增计数器确保唯一性
    command: cmd,
    success: false,
    ts: new Date().toLocaleString(),
    expanded: true, // 默认展开
    stdout: '', // 初始化为空字符串，确保响应式
    stderr: '', // 初始化为空字符串，确保响应式
  };
  consoleHistory.value.unshift(rec);
  try {
    const resp = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const result = await resp.json();
    rec.success = !!result?.success;
    rec.stdout = result?.stdout || '';
    rec.stderr = result?.error || result?.stderr || '';
  } catch (e: any) {
    rec.success = false;
    rec.stderr = e?.message || String(e);
  } finally {
    consoleRunning.value = false;
    consoleInput.value = '';
  }
}

// 切换命令输出展开/收起
function toggleCommandOutput(rec: ConsoleRecord) {
  // 找到对应的记录索引，确保响应式更新
  const index = consoleHistory.value.findIndex(r => r.id === rec.id);
  if (index !== -1) {
    consoleHistory.value[index].expanded = !consoleHistory.value[index].expanded;
  }
}

// 打开自定义命令管理
function openCommandManager() {
  commandManagerVisible.value = true;
}

// 执行自定义命令
async function executeCustomCommand(command: CustomCommand) {
  const targetDir = command.directory || currentDirectory.value;
  const cmd = command.command;
  
  consoleRunning.value = true;
  
  // 如果使用终端执行
  if (useTerminal.value) {
    try {
      // 如果有指定目录，需要修改命令以包含 cd
      const finalCommand = targetDir && targetDir !== currentDirectory.value 
        ? `cd /d "${targetDir}" && ${cmd}` 
        : cmd;
      
      const resp = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: finalCommand })
      });
      const result = await resp.json();
      if (result?.success) {
        ElMessage.success('已在新终端中执行命令');
        // 关闭弹窗
        commandManagerVisible.value = false;
      } else {
        ElMessage.error(result?.error || '执行失败');
      }
    } catch (e: any) {
      ElMessage.error(e?.message || '执行失败');
    } finally {
      consoleRunning.value = false;
    }
    return;
  }
  
  // 后台执行逻辑
  const rec: ConsoleRecord = {
    id: ++consoleIdCounter,
    command: cmd,
    success: false,
    ts: new Date().toLocaleString(),
    expanded: true,
    stdout: '',
    stderr: '',
  };
  consoleHistory.value.unshift(rec);
  try {
    const resp = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const result = await resp.json();
    rec.success = !!result?.success;
    rec.stdout = result?.stdout || '';
    rec.stderr = result?.error || result?.stderr || '';
    // 关闭弹窗
    commandManagerVisible.value = false;
  } catch (e: any) {
    rec.success = false;
    rec.stderr = e?.message || String(e);
  } finally {
    consoleRunning.value = false;
  }
}

// 获取当前工作目录
onMounted(async () => {
  try {
    const resp = await fetch('/api/current_directory');
    const result = await resp.json();
    currentDirectory.value = result?.directory || '';
  } catch {}
});
</script>

<template>
  <!-- 自定义指令执行控制台 -->
  <div class="command-console" :class="{ 'fullscreen': isFullscreen }">
    <!-- 标题栏 -->
    <div class="console-header">
      <div class="header-left">
        <el-icon class="title-icon"><Document /></el-icon>
        <span class="console-title">{{ $t('@CF05E:自定义指令执行') }}</span>
      </div>
      <div class="header-actions">
        <div class="terminal-switch">
          <span class="switch-label">{{ $t('@CF05E:使用终端执行') }}</span>
          <el-switch
            v-model="useTerminal"
            size="small"
          />
        </div>
        <el-tooltip :content="$t('@CF05E:自定义命令管理')" placement="bottom">
          <el-button
            text
            @click="openCommandManager"
            class="toggle-console-btn command-manager-btn"
          >
            <el-icon>
              <Setting />
            </el-icon>
          </el-button>
        </el-tooltip>
        <el-tooltip :content="isFullscreen ? $t('@CF05E:退出全屏') : $t('@CF05E:全屏显示')" placement="bottom">
          <el-button
            text
            @click="isFullscreen = !isFullscreen"
            class="toggle-console-btn"
          >
            <el-icon>
              <FullScreen />
            </el-icon>
          </el-button>
        </el-tooltip>
        <el-tooltip :content="isConsoleExpanded ? $t('@CF05E:收起') : $t('@CF05E:展开')" placement="bottom">
          <el-button
            text
            @click="isConsoleExpanded = !isConsoleExpanded"
            class="toggle-console-btn"
          >
            <el-icon :class="{ 'rotate-icon': !isConsoleExpanded }">
              <ArrowDown />
            </el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </div>

    <!-- 内容区域 -->
    <transition name="console-content-slide">
      <div v-show="isConsoleExpanded" class="console-content">
        <!-- 输入区 -->
        <div class="console-input-row">
      <span class="prompt" :title="$t('@CF05E:当前路径')">{{ currentDirectory }} &gt;</span>
      <el-input
        v-model="consoleInput"
        class="console-input"
        :placeholder="'输入命令，例如: git status'"
        @keydown.enter.prevent="runConsoleCommand"
        :disabled="consoleRunning"
        clearable
      />
      <el-button type="primary" :loading="consoleRunning" @click="runConsoleCommand">{{ $t('@CF05E:执行') }}</el-button>
    </div>

        <!-- 命令历史输出 -->
        <div class="console-output" v-if="consoleHistory.length">
          <div v-for="rec in consoleHistory" :key="rec.id" class="console-record">
            <div class="cmd-header">
              <div class="cmd-line">
                <span class="cmd-prefix">&gt;</span>
                <span class="cmd-text">{{ rec.command }}</span>
                <span class="ts">{{ rec.ts }}</span>
              </div>
              <el-tooltip 
                :content="(rec.stdout || rec.stderr) ? (rec.expanded ? $t('@CF05E:收起输出') : $t('@CF05E:展开输出')) : $t('@CF05E:无输出内容')"
                placement="left"
              >
                <el-button
                  text
                  size="small"
                  @click="toggleCommandOutput(rec)"
                  :disabled="!rec.stdout && !rec.stderr"
                  class="toggle-output-btn"
                >
                  <el-icon :class="{ 'rotate-icon': !rec.expanded }">
                    <ArrowDown />
                  </el-icon>
                </el-button>
              </el-tooltip>
            </div>
            <transition name="output-slide">
              <div v-if="rec.expanded && (rec.stdout || rec.stderr)" class="output-content">
                <pre v-if="rec.stdout" class="stdout">{{ rec.stdout }}</pre>
                <pre v-if="rec.stderr" class="stderr">{{ rec.stderr }}</pre>
              </div>
            </transition>
          </div>
        </div>
      </div>
    </transition>
  </div>
  
  <!-- 自定义命令管理弹窗 -->
  <CustomCommandManager 
    v-model:visible="commandManagerVisible"
    @execute-command="executeCustomCommand"
  />
</template>

<style lang="scss" scoped>
/* 命令控制台容器 */
.command-console {
  margin-top: 12px;
  background: var(--bg-code);
  border: 1px solid var(--border-component);
  border-radius: 10px;
  padding: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: all 0.3s ease;
  overflow: hidden;
  
  &:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    border-color: rgba(64, 158, 255, 0.3);
  }
  
  /* 全屏模式 */
  &.fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
    border-radius: 0;
    z-index: 9999;
    max-height: 100vh;
    display: flex;
    flex-direction: column;
    
    .console-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .console-output {
      flex: 1;
      max-height: none;
      overflow: auto;
    }
  }
}

/* 控制台标题栏 */
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: linear-gradient(135deg, var(--bg-panel), var(--bg-container));
  border-bottom: 1px solid var(--border-component);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.title-icon {
  font-size: 16px;
  color: #409eff;
}

.console-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
  letter-spacing: 0.3px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.terminal-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: rgba(64, 158, 255, 0.05);
  border-radius: 6px;
  border: 1px solid rgba(64, 158, 255, 0.2);
  transition: all 0.3s ease;
  
  &:hover {
    background: rgba(64, 158, 255, 0.1);
    border-color: rgba(64, 158, 255, 0.3);
  }
}

.switch-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
  user-select: none;
}

.command-manager-btn {
  &:hover {
    color: #67c23a;
    background: rgba(103, 194, 58, 0.1);
  }
}

.toggle-console-btn {
  padding: 4px 8px;
  font-size: 13px;
  color: var(--text-secondary);
  transition: all 0.3s ease;
  
  &:hover {
    color: #409eff;
    background: rgba(64, 158, 255, 0.1);
  }
  
  .el-icon {
    transition: transform 0.3s ease;
    font-size: 16px;
  }
  
  .rotate-icon {
    transform: rotate(-90deg);
  }
}

/* 内容区域过渡动画 */
.console-content-slide-enter-active,
.console-content-slide-leave-active {
  transition: all 0.3s ease;
  overflow: hidden;
}

.console-content-slide-enter-from,
.console-content-slide-leave-to {
  max-height: 0;
  opacity: 0;
}

.console-content-slide-enter-to,
.console-content-slide-leave-from {
  max-height: 500px;
  opacity: 1;
}

.console-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-container);
  margin: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-component);
  transition: all 0.3s ease;
  
  &:focus-within {
    border-color: #409eff;
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.1);
  }
}

.prompt {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  color: #67c23a;
  background: linear-gradient(135deg, rgba(103, 194, 58, 0.1), rgba(103, 194, 58, 0.05));
  border: 1px solid rgba(103, 194, 58, 0.3);
  padding: 6px 12px;
  border-radius: 6px;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
  transition: all 0.3s ease;
  
  &:hover {
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.15), rgba(103, 194, 58, 0.08));
    border-color: rgba(103, 194, 58, 0.5);
    transform: translateX(2px);
  }
}

.console-input {
  flex: 1;
  
  :deep(.el-input__wrapper) {
    background-color: transparent;
    box-shadow: none !important;
    border: none;
    padding: 4px 8px;
    font-family: var(--font-mono);
    font-size: 13px;
  }
  
  :deep(.el-input__inner) {
    color: var(--text-primary);
    
    &::placeholder {
      color: var(--text-tertiary);
      font-style: italic;
    }
  }
}

.console-input-row .el-button {
  padding: 8px 20px;
  font-weight: 500;
  border-radius: 6px;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
  }
  
  &:active {
    transform: translateY(0);
  }
}

.console-output {
  max-height: 280px;
  overflow: auto;
  background: var(--bg-container);
  border-top: 1px solid var(--border-component);
  
  /* 美化滚动条 */
  &::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }
  
  &::-webkit-scrollbar-track {
    background: var(--bg-panel);
    border-radius: 4px;
  }
  
  &::-webkit-scrollbar-thumb {
    background: var(--border-component);
    border-radius: 4px;
    transition: background 0.3s ease;
    
    &:hover {
      background: var(--text-tertiary);
    }
  }
}

.console-record {
  border-bottom: 1px solid var(--border-component);
  transition: background 0.2s ease;
  
  &:hover {
    background: var(--bg-icon);
  }
  
  &:last-child {
    border-bottom: none;
  }
}

.cmd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  gap: 8px;
}

.cmd-line {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.cmd-prefix {
  color: #409eff;
  font-weight: 600;
  flex-shrink: 0;
}

.cmd-text {
  color: var(--text-title);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ts {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: normal;
  background: var(--bg-panel);
  padding: 2px 8px;
  border-radius: 4px;
  flex-shrink: 0;
}

.toggle-output-btn {
  padding: 4px;
  min-width: auto;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: all 0.3s ease;
  
  &:hover {
    color: #409eff;
    background: rgba(64, 158, 255, 0.1);
  }
  
  .el-icon {
    transition: transform 0.3s ease;
    font-size: 14px;
  }
  
  .rotate-icon {
    transform: rotate(-90deg);
  }
}

.output-content {
  padding: 0 12px 10px 12px;
}

/* 输出内容滑动动画 */
.output-slide-enter-active,
.output-slide-leave-active {
  transition: all 0.3s ease;
  overflow: hidden;
}

.output-slide-enter-from,
.output-slide-leave-to {
  max-height: 0;
  opacity: 0;
}

.output-slide-enter-to,
.output-slide-leave-from {
  max-height: 500px;
  opacity: 1;
}

pre.stdout, pre.stderr {
  margin: 0;
  padding: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 4px;
  background: var(--bg-code);
}

pre.stdout {
  color: var(--color-text);
  border-left: 3px solid #67c23a;
}

pre.stderr {
  color: var(--text-danger, #f56c6c);
  background: rgba(245, 108, 108, 0.05);
  border-left: 3px solid #f56c6c;
}
</style>
