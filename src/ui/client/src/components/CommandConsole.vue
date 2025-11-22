<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { Document, ArrowDown, FullScreen, Setting, Rank, FolderOpened } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import CustomCommandManager from '@components/CustomCommandManager.vue';
import CommandOrchestrator from '@components/CommandOrchestrator.vue';
import OrchestrationManager from '@components/OrchestrationManager.vue';
import type { CustomCommand } from '@components/CustomCommandManager.vue';
import { useConfigStore, type OrchestrationStep } from '@stores/configStore';

const configStore = useConfigStore();

// 控制台相关状态
const currentDirectory = ref("");
const consoleInput = ref("git status"); // 默认命令，方便调试
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

// 控制整个控制台展开/收起（从localStorage读取，默认展开）
const isConsoleExpanded = ref(localStorage.getItem('isConsoleExpanded') !== 'false');

// 控制全屏状态
const isFullscreen = ref(false);

// 控制是否使用终端执行（从localStorage读取，默认关闭以使用流式输出）
const useTerminal = ref(localStorage.getItem('useTerminal') === 'true');

// 控制自定义命令管理弹窗
const commandManagerVisible = ref(false);

// 控制指令编排弹窗
const commandOrchestratorVisible = ref(false);

// 控制编排管理弹窗
const orchestrationManagerVisible = ref(false);

// 当前编辑的编排（用于编辑模式）
const editingOrchestration = ref<any>(null);

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
  
  // 流式执行逻辑
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
  consoleInput.value = '';
  
  try {
    console.log('[前端-控制台] 开始发送流式请求:', cmd);
    const resp = await fetch('/api/exec-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    
    console.log('[前端-控制台] 收到响应，状态:', resp.status, resp.statusText);
    
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('无法读取响应流');
    }
    
    console.log('[前端-控制台] 开始读取流数据');
    let buffer = ''; // 用于累积不完整的数据
    let chunkCount = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      chunkCount++;
      console.log(`[前端-控制台] 读取数据块 #${chunkCount}, done:`, done, 'size:', value?.length || 0);
      if (done) break;
      
      // 解码数据并追加到缓冲区
      buffer += decoder.decode(value, { stream: true });
      
      // 按照 SSE 格式分割消息（以 \n\n 分隔）
      const messages = buffer.split('\n\n');
      
      // 保留最后一个可能不完整的消息
      buffer = messages.pop() || '';
      
      // 处理完整的消息
      for (const message of messages) {
        const lines = message.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'stdout') {
                rec.stdout += data.data;
              } else if (data.type === 'stderr') {
                rec.stderr += data.data;
              } else if (data.type === 'exit') {
                rec.success = data.data.success;
              } else if (data.type === 'error') {
                rec.stderr += `错误: ${data.data}\n`;
              }
            } catch (e) {
              console.warn('解析SSE数据失败:', line, e);
            }
          }
        }
      }
    }
    
    // 处理可能剩余的数据
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'stdout') {
              rec.stdout += data.data;
            } else if (data.type === 'stderr') {
              rec.stderr += data.data;
            }
          } catch (e) {
            console.warn('解析剩余SSE数据失败:', e);
          }
        }
      }
    }
    console.log('[前端-控制台] 流读取完成，正常退出');
  } catch (e: any) {
    console.error('[前端-控制台] 捕获异常:', e);
    rec.success = false;
    rec.stderr = e?.message || String(e);
  } finally {
    console.log('[前端-控制台] finally块执行，设置consoleRunning=false');
    consoleRunning.value = false;
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

// 打开指令编排
function openCommandOrchestrator() {
  editingOrchestration.value = null
  commandOrchestratorVisible.value = true;
}

// 打开编排管理
function openOrchestrationManager() {
  orchestrationManagerVisible.value = true;
}

// 编辑编排
function editOrchestration(orchestration: any) {
  editingOrchestration.value = orchestration
  commandOrchestratorVisible.value = true
}

// 执行指令编排（顺序执行多个步骤）
async function executeOrchestration(steps: OrchestrationStep[]) {
  if (steps.length === 0) return;
  
  commandOrchestratorVisible.value = false;
  orchestrationManagerVisible.value = false;
  consoleRunning.value = true;
  
  ElMessage.success(`开始执行 ${steps.length} 个步骤...`);
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let stepLabel = '';
    let shouldContinue = true;
    
    // 根据步骤类型执行不同逻辑
    if (step.type === 'command') {
      // 执行自定义命令
      const command = configStore.customCommands.find(c => c.id === step.commandId);
      if (!command) {
        ElMessage.error(`命令已删除: ${step.commandName}`);
        break;
      }
      
      stepLabel = step.commandName || command.name;
      const cmd = command.command;
      
      ElMessage.info(`[${i + 1}/${steps.length}] 执行: ${stepLabel}`);
      
      const rec: ConsoleRecord = {
        id: ++consoleIdCounter,
        command: `[${stepLabel}] ${cmd}`,
        success: false,
        ts: new Date().toLocaleString(),
        expanded: true,
        stdout: '',
        stderr: '',
      };
      consoleHistory.value.unshift(rec);
      
      try {
        const resp = await fetch('/api/exec-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        
        const reader = resp.body?.getReader();
        const decoder = new TextDecoder();
        
        if (!reader) {
          throw new Error('无法读取响应流');
        }
        
        let buffer = '';
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || '';
          
          for (const message of messages) {
            const lines = message.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.substring(6));
                  if (data.type === 'stdout') {
                    rec.stdout += data.data;
                  } else if (data.type === 'stderr') {
                    rec.stderr += data.data;
                  } else if (data.type === 'exit') {
                    rec.success = data.data.success;
                  } else if (data.type === 'error') {
                    rec.stderr += `错误: ${data.data}\n`;
                  }
                } catch (e) {
                  console.warn('解析SSE数据失败:', line, e);
                }
              }
            }
          }
        }
        
        if (buffer.trim()) {
          const lines = buffer.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.substring(6));
                if (data.type === 'stdout') rec.stdout += data.data;
                else if (data.type === 'stderr') rec.stderr += data.data;
              } catch (e) {}
            }
          }
        }
        
        if (!rec.success) {
          if (step.optional) {
            ElMessage.warning(`[可选] 命令 ${stepLabel} 执行失败，继续执行后续步骤`);
          } else {
            ElMessage.error(`命令 ${stepLabel} 执行失败，停止后续步骤`);
            shouldContinue = false;
          }
        }
      } catch (e: any) {
        rec.success = false;
        rec.stderr = e?.message || String(e);
        if (step.optional) {
          ElMessage.warning(`[可选] 命令 ${stepLabel} 执行出错: ${e?.message}，继续执行后续步骤`);
        } else {
          ElMessage.error(`命令 ${stepLabel} 执行出错: ${e?.message}`);
          shouldContinue = false;
        }
      }
    } else if (step.type === 'wait') {
      // 执行等待步骤
      const seconds = step.waitSeconds || 0;
      stepLabel = `等待 ${seconds} 秒`;
      
      ElMessage.info(`[${i + 1}/${steps.length}] ${stepLabel}`);
      
      const rec: ConsoleRecord = {
        id: ++consoleIdCounter,
        command: stepLabel,
        success: true,
        ts: new Date().toLocaleString(),
        expanded: true,
        stdout: `等待 ${seconds} 秒...`,
        stderr: '',
      };
      consoleHistory.value.unshift(rec);
      
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      rec.stdout += '\n等待完成';
    } else if (step.type === 'version') {
      // 执行版本管理
      const bumpType = step.versionBump || 'patch';
      const bumpText = bumpType === 'major' ? '主版本' : bumpType === 'minor' ? '次版本' : '补丁版本';
      stepLabel = `版本号+1 (${bumpText})`;
      
      ElMessage.info(`[${i + 1}/${steps.length}] ${stepLabel}`);
      
      const rec: ConsoleRecord = {
        id: ++consoleIdCounter,
        command: stepLabel,
        success: false,
        ts: new Date().toLocaleString(),
        expanded: true,
        stdout: '',
        stderr: '',
      };
      consoleHistory.value.unshift(rec);
      
      try {
        const resp = await fetch('/api/version-bump', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            bumpType: bumpType,
            packageJsonPath: step.packageJsonPath || ''
          })
        });
        
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        
        const result = await resp.json();
        
        if (result.success) {
          rec.success = true;
          rec.stdout = `版本号已更新: ${result.oldVersion} → ${result.newVersion}\n`;
          rec.stdout += `文件路径: ${result.filePath}`;
          ElMessage.success(`版本号已更新: ${result.oldVersion} → ${result.newVersion}`);
        } else {
          throw new Error(result.error || '版本更新失败');
        }
      } catch (e: any) {
        rec.success = false;
        rec.stderr = e?.message || String(e);
        if (step.optional) {
          ElMessage.warning(`[可选] ${stepLabel} 失败: ${e?.message}，继续执行后续步骤`);
        } else {
          ElMessage.error(`${stepLabel} 失败: ${e?.message}`);
          shouldContinue = false;
        }
      }
    }
    
    // 如果步骤执行失败，停止后续步骤
    if (!shouldContinue) {
      break;
    }
    
    // 如果不是最后一个步骤，等待一小段时间
    if (i < steps.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  consoleRunning.value = false;
  ElMessage.success('所有步骤执行完成！');
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
  
  // 流式执行逻辑
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
  
  // 关闭弹窗，让用户可以看到输出
  commandManagerVisible.value = false;
  
  try {
    console.log('[前端-自定义] 开始发送流式请求:', cmd);
    const resp = await fetch('/api/exec-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    
    console.log('[前端-自定义] 收到响应，状态:', resp.status, resp.statusText);
    
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    
    if (!reader) {
      throw new Error('无法读取响应流');
    }
    
    console.log('[前端-自定义] 开始读取流数据');
    let buffer = ''; // 用于累积不完整的数据
    let chunkCount = 0;
    
    while (true) {
      const { done, value } = await reader.read();
      chunkCount++;
      console.log(`[前端-自定义] 读取数据块 #${chunkCount}, done:`, done, 'size:', value?.length || 0);
      if (done) break;
      
      // 解码数据并追加到缓冲区
      buffer += decoder.decode(value, { stream: true });
      
      // 按照 SSE 格式分割消息（以 \n\n 分隔）
      const messages = buffer.split('\n\n');
      
      // 保留最后一个可能不完整的消息
      buffer = messages.pop() || '';
      
      // 处理完整的消息
      for (const message of messages) {
        const lines = message.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.type === 'stdout') {
                rec.stdout += data.data;
              } else if (data.type === 'stderr') {
                rec.stderr += data.data;
              } else if (data.type === 'exit') {
                rec.success = data.data.success;
              } else if (data.type === 'error') {
                rec.stderr += `错误: ${data.data}\n`;
              }
            } catch (e) {
              console.warn('解析SSE数据失败:', line, e);
            }
          }
        }
      }
    }
    
    // 处理可能剩余的数据
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'stdout') {
              rec.stdout += data.data;
            } else if (data.type === 'stderr') {
              rec.stderr += data.data;
            }
          } catch (e) {
            console.warn('解析剩余SSE数据失败:', e);
          }
        }
      }
    }
    console.log('[前端-自定义] 流读取完成，正常退出');
  } catch (e: any) {
    console.error('[前端-自定义] 捕获异常:', e);
    rec.success = false;
    rec.stderr = e?.message || String(e);
  } finally {
    console.log('[前端-自定义] finally块执行，设置consoleRunning=false');
    consoleRunning.value = false;
  }
}

// 监听useTerminal变化并保存到localStorage
watch(useTerminal, (newValue) => {
  localStorage.setItem('useTerminal', String(newValue));
});

// 监听isConsoleExpanded变化并保存到localStorage
watch(isConsoleExpanded, (newValue) => {
  localStorage.setItem('isConsoleExpanded', String(newValue));
});

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
        <el-tooltip :content="$t('@CF05E:指令编排')" placement="bottom">
          <el-button
            text
            @click="openCommandOrchestrator"
            class="toggle-console-btn orchestrator-btn"
          >
            <el-icon>
              <Rank />
            </el-icon>
          </el-button>
        </el-tooltip>
        <el-tooltip content="编排管理" placement="bottom">
          <el-button
            text
            @click="openOrchestrationManager"
            class="toggle-console-btn orchestrator-manager-btn"
          >
            <el-icon>
              <FolderOpened />
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
  
  <!-- 指令编排弹窗 -->
  <CommandOrchestrator
    v-model:visible="commandOrchestratorVisible"
    :editing-orchestration="editingOrchestration"
    @execute-orchestration="executeOrchestration"
  />
  
  <!-- 编排管理弹窗 -->
  <OrchestrationManager
    v-model:visible="orchestrationManagerVisible"
    @execute-orchestration="executeOrchestration"
    @edit-orchestration="editOrchestration"
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

.orchestrator-btn {
  &:hover {
    color: #e6a23c;
    background: rgba(230, 162, 60, 0.1);
  }
}

.orchestrator-manager-btn {
  &:hover {
    color: #409eff;
    background: rgba(64, 158, 255, 0.1);
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
