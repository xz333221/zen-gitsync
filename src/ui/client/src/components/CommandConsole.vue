<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted } from 'vue';
import { ArrowDown, FullScreen, VideoPlay, Loading, Close, Position } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import SvgIcon from '@components/SvgIcon/index.vue';
import CustomCommandManager from '@components/CustomCommandManager.vue';
import OrchestrationWorkspace from '@components/OrchestrationWorkspace.vue';
import type { CustomCommand } from '@components/CustomCommandManager.vue';
import { useConfigStore, type OrchestrationStep } from '@stores/configStore';
import { io, Socket } from 'socket.io-client';
import Convert from 'ansi-to-html';

const configStore = useConfigStore();

// 获取后端端口
function getBackendPort() {
  const currentPort = window.location.port || '80';
  if (currentPort === '5173' || currentPort === '4173' || currentPort === '5544') {
    const envPort = import.meta.env.VITE_BACKEND_PORT;
    if (envPort) return parseInt(envPort, 10);
    return 3000;
  }
  return parseInt(currentPort, 10);
}

const backendPort = getBackendPort();

// Socket.IO 连接
const socket = ref<Socket | null>(null);

// 控制台相关状态
const currentDirectory = ref("");
const consoleInput = ref(""); // 命令输入
const consoleRunning = ref(false);
const consoleHistory = ref<ConsoleRecord[]>([]);
let consoleIdCounter = 0; // ID计数器，确保唯一性

type ConsoleRecord = { 
  id: number; 
  command: string; 
  stdout?: string; 
  stderr?: string; 
  success: boolean; 
  ts: string; 
  expanded: boolean;
  running?: boolean; // 运行中标记
  processId?: number; // 进程 ID
  sessionId?: string; // 交互式会话区
  isInteractive?: boolean; // 是否为交互式命令
  stdinInput?: string; // 每个命令独立的 stdin 输入
};

// 控制整个控制台展开/收起（从localStorage读取，默认展开）
const isConsoleExpanded = ref(localStorage.getItem('isConsoleExpanded') !== 'false');

// 创建 ANSI 转 HTML 转换器
const ansiConverter = new Convert({
  fg: '#e5e5e5',
  bg: 'transparent',
  newline: false,
  escapeXML: false,
  stream: false,
  colors: {
    0: '#000000',
    1: '#cd3131',
    2: '#0dbc79',
    3: '#e5e510',
    4: '#2472c8',
    5: '#bc3fbc',
    6: '#11a8cd',
    7: '#e5e5e5',
    8: '#666666',
    9: '#f14c4c',
    10: '#23d18b',
    11: '#f5f543',
    12: '#3b8eea',
    13: '#d670d6',
    14: '#29b8db',
    15: '#ffffff'
  }
});

// 将 ANSI 转义码转换为 HTML
function ansiToHtml(text: string): string {
  return ansiConverter.toHtml(text);
}

// 控制全屏状态
const isFullscreen = ref(false);

// 控制是否使用终端执行（从localStorage读取，默认关闭以使用流式输出）
const useTerminal = ref(localStorage.getItem('useTerminal') === 'true');

// 控制自定义命令管理弹窗
const commandManagerVisible = ref(false);

// 控制编排工作台弹窗（合并了指令编排和编排管理）
const orchestrationWorkspaceVisible = ref(false);

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
    running: true,  // 标记为运行中
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
      const chunk = decoder.decode(value, { stream: true });
      console.log(`[前端-控制台] 解码数据块:`, chunk.substring(0, 200));
      buffer += chunk;
      
      // 按照 SSE 格式分割消息（以 \n\n 分隔）
      const messages = buffer.split('\n\n');
      
      // 保留最后一个可能不完整的消息
      buffer = messages.pop() || '';
      
      console.log(`[前端-控制台] 分割出 ${messages.length} 条消息`);
      
      // 处理完整的消息
      for (const message of messages) {
        const lines = message.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              console.log(`[前端-控制台] 解析到数据:`, data.type, '长度:', data.data?.length || 0);
              
              if (data.type === 'process_id') {
                rec.processId = data.data;
                console.log(`[前端-控制台] 收到进程ID:`, rec.processId);
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'stdout') {
                rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
                console.log(`[前端-控制台] 当前stdout总长度:`, rec.stdout.length);
                // 收到第一个输出时关闭loading，表示命令已启动
                if (consoleRunning.value && rec.stdout.length < 200) {
                  consoleRunning.value = false;
                }
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'stderr') {
                rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
                console.log(`[前端-控制台] 当前stderr总长度:`, rec.stderr.length);
                // 收到第一个输出时关闭loading
                if (consoleRunning.value && rec.stderr.length < 200) {
                  consoleRunning.value = false;
                }
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'exit') {
                rec.success = data.data.success;
                rec.running = false;  // 进程已结束
                console.log(`[前端-控制台] 进程退出，成功:`, rec.success);
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'error') {
                rec.stderr = (rec.stderr || '') + `错误: ${data.data}\n`;
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
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
              rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
            } else if (data.type === 'stderr') {
              rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
            } else if (data.type === 'exit') {
              rec.success = data.data.success;
              rec.running = false;
            }
          } catch (e) {
            console.warn('解析剩余SSE数据失败:', e);
          }
        }
      }
      // 强制触发响应式更新
      consoleHistory.value = [...consoleHistory.value];
    }
    console.log('[前端-控制台] 流读取完成，正常退出');
  } catch (e: any) {
    console.error('[前端-控制台] 捕获异常:', e);
    rec.success = false;
    rec.running = false;
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

// 停止正在运行的命令
async function stopCommand(rec: ConsoleRecord) {
  if (!rec.processId) {
    ElMessage.warning('无法停止：进程ID不存在');
    return;
  }

  if (!rec.running) {
    ElMessage.info('命令已经结束');
    return;
  }

  try {
    console.log(`[停止命令] 尝试停止进程 #${rec.processId}: ${rec.command}`);
    
    const resp = await fetch('/api/kill-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processId: rec.processId })
    });

    const result = await resp.json();
    
    if (result.success) {
      ElMessage.success(`已停止命令: ${rec.command}`);
      rec.running = false;
      // 强制触发响应式更新
      consoleHistory.value = [...consoleHistory.value];
    } else {
      ElMessage.error(`停止失败: ${result.error}`);
    }
  } catch (error: any) {
    console.error('[停止命令] 失败:', error);
    ElMessage.error(`停止失败: ${error.message || '未知错误'}`);
  }
}

// 打开自定义命令管理
function openCommandManager() {
  commandManagerVisible.value = true;
}

// 打开编排工作台
function openOrchestrationWorkspace() {
  orchestrationWorkspaceVisible.value = true;
}

// 执行指令编排（顺序执行多个步骤）
// isSingleExecution: true表示单个步骤执行，false表示批量执行
async function executeOrchestration(steps: OrchestrationStep[], startIndex: number = 0, isSingleExecution: boolean = false) {
  if (steps.length === 0) return;
  
  // 不关闭弹窗，让用户可以继续查看或修改编排
  consoleRunning.value = true;
  
  const totalSteps = steps.length - startIndex;
  if (startIndex > 0) {
    ElMessage.success(`从第 ${startIndex + 1} 步开始执行，共 ${totalSteps} 个步骤...`);
  } else {
    ElMessage.success(`开始执行 ${steps.length} 个步骤...`);
  }
  
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    
    // 确保 enabled 字段有默认值（旧数据兼容）
    if (step.enabled === undefined) {
      step.enabled = true;
    }
    
    // 跳过未启用的步骤（仅在批量执行时检查，单个执行时不检查）
    if (step.enabled === false && !isSingleExecution) {
      const label = step.commandName || step.type;
      ElMessage.info(`[${i + 1}/${steps.length}] 跳过已禁用的步骤: ${label}`);
      continue;
    }
    
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
      
      ElMessage.info(`[${i + 1}/${steps.length}] 执行: ${stepLabel}${step.useTerminal ? ' (终端)' : ''}`);
      
      // 如果标记为终端执行，在新终端窗口执行
      if (step.useTerminal) {
        try {
          const resp = await fetch('/api/exec-in-terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              command: cmd,
              workingDirectory: command.directory // 传递命令的工作目录
            })
          });
          const result = await resp.json();
          if (result?.success) {
            ElMessage.success(`${stepLabel} 已在新终端中执行`);
            
            // 等待用户确认命令执行完成（如果不是最后一个步骤）
            if (i < steps.length - 1 && shouldContinue) {
              await ElMessageBox.confirm(
                `终端命令 "${stepLabel}" 已在新窗口中打开。\n\n请在终端中查看命令执行结果，完成后点击"继续"执行下一步。`,
                '等待终端命令完成',
                {
                  confirmButtonText: '继续下一步',
                  cancelButtonText: '停止执行',
                  type: 'info',
                  closeOnClickModal: false,
                  closeOnPressEscape: false,
                  showClose: false
                }
              ).catch(() => {
                // 用户点击取消，停止执行
                shouldContinue = false;
                throw new Error('用户取消执行');
              });
            }
          } else {
            throw new Error(result?.error || '执行失败');
          }
        } catch (e: any) {
          if (e?.message !== '用户取消执行') {
            ElMessage.error(`${stepLabel} 执行失败: ${e?.message}`);
          }
          shouldContinue = false;
          break; // 用户取消或执行失败时，停止整个流程
        }
        continue; // 跳过后续的流式执行逻辑
      }
      
      // 流式执行（原有逻辑）
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
          body: JSON.stringify({ 
            command: cmd,
            directory: command.directory || ''
          })
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
                    rec.stdout += ansiToHtml(data.data);
                  } else if (data.type === 'stderr') {
                    rec.stderr += ansiToHtml(data.data);
                  } else if (data.type === 'exit') {
                    rec.success = data.data.success;
                  } else if (data.type === 'error') {
                    rec.stderr += ansiToHtml(`错误: ${data.data}\n`);
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
                if (data.type === 'stdout') rec.stdout += ansiToHtml(data.data);
                else if (data.type === 'stderr') rec.stderr += ansiToHtml(data.data);
              } catch (e) {}
            }
          }
        }
        
        if (!rec.success) {
          ElMessage.error(`命令 ${stepLabel} 执行失败，停止后续步骤`);
          shouldContinue = false;
        }
      } catch (e: any) {
        rec.success = false;
        rec.stderr = e?.message || String(e);
        ElMessage.error(`命令 ${stepLabel} 执行出错: ${e?.message}`);
        shouldContinue = false;
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
      if (step.versionTarget === 'dependency') {
        // 修改依赖版本
        const depType = step.dependencyType === 'devDependencies' ? 'devDep' : 'dep';
        stepLabel = `修改依赖 [${depType}] ${step.dependencyName} → ${step.dependencyVersion}`;
      } else {
        // 修改 version 字段
        const bumpType = step.versionBump || 'patch';
        const bumpText = bumpType === 'major' ? '主版本' : bumpType === 'minor' ? '次版本' : '补丁版本';
        stepLabel = `版本号+1 (${bumpText})`;
      }
      
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
            versionTarget: step.versionTarget || 'version',
            bumpType: step.versionBump || 'patch',
            packageJsonPath: step.packageJsonPath || '',
            dependencyName: step.dependencyName,
            dependencyVersion: step.dependencyVersion,
            dependencyVersionBump: step.dependencyVersionBump,
            dependencyType: step.dependencyType || 'dependencies'
          })
        });
        
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        
        const result = await resp.json();
        
        if (result.success) {
          rec.success = true;
          if (step.versionTarget === 'dependency') {
            rec.stdout = `依赖版本已更新: ${result.dependencyName} ${result.oldVersion} → ${result.newVersion}\n`;
            rec.stdout += `依赖类型: ${result.dependencyType}\n`;
            rec.stdout += `文件路径: ${result.filePath}`;
            ElMessage.success(`依赖 ${result.dependencyName} 版本已更新: ${result.oldVersion} → ${result.newVersion}`);
          } else {
            rec.stdout = `版本号已更新: ${result.oldVersion} → ${result.newVersion}\n`;
            rec.stdout += `文件路径: ${result.filePath}`;
            ElMessage.success(`版本号已更新: ${result.oldVersion} → ${result.newVersion}`);
          }
        } else {
          throw new Error(result.error || '版本更新失败');
        }
      } catch (e: any) {
        rec.success = false;
        rec.stderr = e?.message || String(e);
        ElMessage.error(`${stepLabel} 失败: ${e?.message}`);
        shouldContinue = false;
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
      const resp = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          command: cmd,
          workingDirectory: targetDir // 传递工作目录到后端
        })
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
  
  // 非终端模式默认使用交互式执行
  if (!useTerminal.value) {
    // 生成会话ID
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // 创建命令记录
    const rec: ConsoleRecord = {
      id: ++consoleIdCounter,
      command: cmd,
      success: false,
      ts: new Date().toLocaleString(),
      expanded: true,
      stdout: '',
      stderr: '',
      running: true,
      sessionId: sessionId,
      isInteractive: true,
      stdinInput: '' // 初始化独立的输入框
    };
    consoleHistory.value.unshift(rec);
    
    // 关闭弹窗
    commandManagerVisible.value = false;
    
    if (!socket.value || !socket.value.connected) {
      ElMessage.error('Socket 连接未建立，无法执行交互式命令');
      consoleRunning.value = false;
      rec.running = false;
      rec.stderr = 'Socket 连接未建立';
      return;
    }
    
    // 发送执行请求
    socket.value.emit('exec_interactive', {
      command: cmd,
      directory: command.directory || '',
      sessionId
    });
    
    // 监听进程ID
    const onProcessId = (data: any) => {
      if (data.sessionId === sessionId) {
        rec.processId = data.processId;
        console.log(`[交互式-自定义] 收到进程ID:`, rec.processId);
        consoleHistory.value = [...consoleHistory.value];
      }
    };
    
    // 监听标准输出
    const onStdout = (data: any) => {
      if (data.sessionId === sessionId) {
        rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
        consoleRunning.value = false;
        consoleHistory.value = [...consoleHistory.value];
      }
    };
    
    // 监听标准错误
    const onStderr = (data: any) => {
      if (data.sessionId === sessionId) {
        rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
        consoleRunning.value = false;
        consoleHistory.value = [...consoleHistory.value];
      }
    };
    
    // 监听进程退出
    const onExit = (data: any) => {
      if (data.sessionId === sessionId) {
        rec.success = data.success;
        rec.running = false;
        console.log(`[交互式-自定义] 进程退出，成功:`, rec.success);
        consoleHistory.value = [...consoleHistory.value];
        
        // 清理事件监听器
        socket.value?.off('interactive_process_id', onProcessId);
        socket.value?.off('interactive_stdout', onStdout);
        socket.value?.off('interactive_stderr', onStderr);
        socket.value?.off('interactive_exit', onExit);
        socket.value?.off('interactive_error', onError);
      }
    };
    
    // 监听错误
    const onError = (data: any) => {
      if (data.sessionId === sessionId) {
        rec.stderr = (rec.stderr || '') + `错误: ${data.error}\n`;
        rec.running = false;
        rec.success = false;
        consoleHistory.value = [...consoleHistory.value];
        
        // 清理事件监听器
        socket.value?.off('interactive_process_id', onProcessId);
        socket.value?.off('interactive_stdout', onStdout);
        socket.value?.off('interactive_stderr', onStderr);
        socket.value?.off('interactive_exit', onExit);
        socket.value?.off('interactive_error', onError);
      }
    };
    
    socket.value.on('interactive_process_id', onProcessId);
    socket.value.on('interactive_stdout', onStdout);
    socket.value.on('interactive_stderr', onStderr);
    socket.value.on('interactive_exit', onExit);
    socket.value.on('interactive_error', onError);
    
    consoleRunning.value = false;
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
    running: true,  // 标记为运行中
  };
  consoleHistory.value.unshift(rec);
  
  // 关闭弹窗，让用户可以看到输出
  commandManagerVisible.value = false;
  
  try {
    console.log('[前端-自定义] 开始发送流式请求:', cmd, '目录:', command.directory);
    const resp = await fetch('/api/exec-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        command: cmd,
        directory: command.directory || ''
      })
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
      const chunk = decoder.decode(value, { stream: true });
      console.log(`[前端-自定义] 解码数据块:`, chunk.substring(0, 200));
      buffer += chunk;
      
      // 按照 SSE 格式分割消息（以 \n\n 分隔）
      const messages = buffer.split('\n\n');
      
      // 保留最后一个可能不完整的消息
      buffer = messages.pop() || '';
      
      console.log(`[前端-自定义] 分割出 ${messages.length} 条消息, buffer剩余: ${buffer.length} 字符`);
      
      // 处理完整的消息
      for (const message of messages) {
        const lines = message.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              console.log(`[前端-自定义] 解析到数据:`, data.type, '内容长度:', data.data?.length || 0);
              
              if (data.type === 'process_id') {
                rec.processId = data.data;
                console.log(`[前端-自定义] 收到进程ID:`, rec.processId);
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'stdout') {
                rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
                console.log(`[前端-自定义] 当前stdout总长度:`, rec.stdout.length, '内容预览:', rec.stdout.substring(0, 100));
                // 收到第一个输出时关闭loading，表示命令已启动
                if (consoleRunning.value && rec.stdout.length < 200) {
                  consoleRunning.value = false;
                }
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'stderr') {
                rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
                console.log(`[前端-自定义] 当前stderr总长度:`, rec.stderr.length);
                // 收到第一个输出时关闭loading
                if (consoleRunning.value && rec.stderr.length < 200) {
                  consoleRunning.value = false;
                }
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'exit') {
                rec.success = data.data.success;
                rec.running = false;  // 进程已结束
                console.log(`[前端-自定义] 进程退出，成功:`, rec.success);
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              } else if (data.type === 'error') {
                rec.stderr = (rec.stderr || '') + `错误: ${data.data}\n`;
                // 强制触发响应式更新
                consoleHistory.value = [...consoleHistory.value];
              }
            } catch (e) {
              console.warn('[前端-自定义] 解析SSE数据失败:', line, e);
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
              rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
            } else if (data.type === 'stderr') {
              rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
            } else if (data.type === 'exit') {
              rec.success = data.data.success;
              rec.running = false;
            }
          } catch (e) {
            console.warn('解析剩余SSE数据失败:', e);
          }
        }
      }
      // 强制触发响应式更新
      consoleHistory.value = [...consoleHistory.value];
    }
    console.log('[前端-自定义] 流读取完成，正常退出');
  } catch (e: any) {
    console.error('[前端-自定义] 捕获异常:', e);
    rec.success = false;
    rec.running = false;
    rec.stderr = e?.message || String(e);
  } finally {
    console.log('[前端-自定义] finally块执行，设置consoleRunning=false');
    consoleRunning.value = false;
  }
}

// 执行交互式命令
async function runInteractiveCommand() {
  const cmd = consoleInput.value.trim();
  if (!cmd || consoleRunning.value) return;
  consoleRunning.value = true;
  
  // 生成会话ID
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // 创建命令记录
  const rec: ConsoleRecord = {
    id: ++consoleIdCounter,
    command: cmd,
    success: false,
    ts: new Date().toLocaleString(),
    expanded: true,
    stdout: '',
    stderr: '',
    running: true,
    sessionId: sessionId,
    isInteractive: true,
    stdinInput: '' // 初始化独立的输入框
  };
  consoleHistory.value.unshift(rec);
  consoleInput.value = '';
  
  if (!socket.value || !socket.value.connected) {
    ElMessage.error('Socket 连接未建立，无法执行交互式命令');
    consoleRunning.value = false;
    rec.running = false;
    rec.stderr = 'Socket 连接未建立';
    return;
  }
  
  // 发送执行请求
  socket.value.emit('exec_interactive', {
    command: cmd,
    directory: '',
    sessionId
  });
  
  // 监听进程ID
  const onProcessId = (data: any) => {
    if (data.sessionId === sessionId) {
      rec.processId = data.processId;
      console.log(`[交互式] 收到进程ID:`, rec.processId);
      consoleHistory.value = [...consoleHistory.value];
    }
  };
  
  // 监听标准输出
  const onStdout = (data: any) => {
    if (data.sessionId === sessionId) {
      rec.stdout = (rec.stdout || '') + ansiToHtml(data.data);
      consoleRunning.value = false; // 收到输出后关闭loading
      consoleHistory.value = [...consoleHistory.value];
    }
  };
  
  // 监听标准错误
  const onStderr = (data: any) => {
    if (data.sessionId === sessionId) {
      rec.stderr = (rec.stderr || '') + ansiToHtml(data.data);
      consoleRunning.value = false;
      consoleHistory.value = [...consoleHistory.value];
    }
  };
  
  // 监听进程退出
  const onExit = (data: any) => {
    if (data.sessionId === sessionId) {
      rec.success = data.success;
      rec.running = false;
      console.log(`[交互式] 进程退出，成功:`, rec.success);
      consoleHistory.value = [...consoleHistory.value];
      
      // 清理事件监听器
      socket.value?.off('interactive_process_id', onProcessId);
      socket.value?.off('interactive_stdout', onStdout);
      socket.value?.off('interactive_stderr', onStderr);
      socket.value?.off('interactive_exit', onExit);
      socket.value?.off('interactive_error', onError);
    }
  };
  
  // 监听错误
  const onError = (data: any) => {
    if (data.sessionId === sessionId) {
      rec.stderr = (rec.stderr || '') + `错误: ${data.error}\n`;
      rec.running = false;
      rec.success = false;
      consoleHistory.value = [...consoleHistory.value];
      
      // 清理事件监听器
      socket.value?.off('interactive_process_id', onProcessId);
      socket.value?.off('interactive_stdout', onStdout);
      socket.value?.off('interactive_stderr', onStderr);
      socket.value?.off('interactive_exit', onExit);
      socket.value?.off('interactive_error', onError);
    }
  };
  
  socket.value.on('interactive_process_id', onProcessId);
  socket.value.on('interactive_stdout', onStdout);
  socket.value.on('interactive_stderr', onStderr);
  socket.value.on('interactive_exit', onExit);
  socket.value.on('interactive_error', onError);
  
  consoleRunning.value = false;
}

// 发送stdin输入
function sendStdinInput(rec: ConsoleRecord) {
  const input = rec.stdinInput?.trim();
  if (!input || !rec.sessionId) return;
  
  if (!socket.value || !socket.value.connected) {
    ElMessage.error('Socket 连接未建立');
    return;
  }
  
  console.log(`[交互式] 发送 stdin 输入:`, input);
  socket.value.emit(`interactive_stdin_${rec.sessionId}`, { input });
  rec.stdinInput = ''; // 清空输入
  consoleHistory.value = [...consoleHistory.value]; // 触发响应式更新
}

// 停止交互式命令
function stopInteractiveCommand(rec: ConsoleRecord) {
  if (!rec.sessionId || !rec.running) {
    ElMessage.warning('命令已经结束');
    return;
  }
  
  if (!socket.value || !socket.value.connected) {
    ElMessage.error('Socket 连接未建立');
    return;
  }
  
  console.log(`[交互式] 停止命令:`, rec.sessionId);
  socket.value.emit(`interactive_stop_${rec.sessionId}`);
  rec.running = false;
  consoleHistory.value = [...consoleHistory.value];
}

// 监听useTerminal变化并保存到localStorage
watch(useTerminal, (newValue) => {
  localStorage.setItem('useTerminal', String(newValue));
});

// 监听isConsoleExpanded变化并保存到localStorage
watch(isConsoleExpanded, (newValue) => {
  localStorage.setItem('isConsoleExpanded', String(newValue));
});

// 初始化Socket.IO连接
function initSocket() {
  const socketUrl = `http://localhost:${backendPort}`;
  console.log('[控制台] 连接到 Socket.IO:', socketUrl);
  
  socket.value = io(socketUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
  });
  
  socket.value.on('connect', () => {
    console.log('[控制台] Socket.IO 已连接');
  });
  
  socket.value.on('disconnect', () => {
    console.log('[控制台] Socket.IO 已断开');
  });
  
  socket.value.on('connect_error', (error) => {
    console.error('[控制台] Socket.IO 连接错误:', error);
  });
}

// 获取当前工作目录
onMounted(async () => {
  try {
    const resp = await fetch('/api/current_directory');
    const result = await resp.json();
    currentDirectory.value = result?.directory || '';
  } catch {}
  
  // 初始化Socket连接
  initSocket();
});

// 组件卸载时断开Socket连接
onUnmounted(() => {
  if (socket.value) {
    socket.value.disconnect();
    socket.value = null;
  }
});
</script>

<template>
  <!-- 自定义指令执行控制台 -->
  <div class="command-console" :class="{ 'fullscreen': isFullscreen }">
    <!-- 标题栏 -->
    <div class="console-header">
      <div class="header-left">
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
            <SvgIcon icon-class="command-list" class-name="icon-btn" />
          </el-button>
        </el-tooltip>
        <el-tooltip content="编排工作台" placement="bottom">
          <el-button
            text
            @click="openOrchestrationWorkspace"
            class="toggle-console-btn orchestrator-btn"
          >
            <SvgIcon icon-class="command-orchestrate" class-name="icon-btn" />
          </el-button>
        </el-tooltip>
        <el-button
          text
          @click="isFullscreen = !isFullscreen"
          class="toggle-console-btn"
        >
          <el-icon>
            <FullScreen />
          </el-icon>
        </el-button>
        <el-button
          text
          @click="isConsoleExpanded = !isConsoleExpanded"
          class="toggle-console-btn"
        >
          <el-icon :class="{ 'rotate-icon': !isConsoleExpanded }">
            <ArrowDown />
          </el-icon>
        </el-button>
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
        :placeholder="useTerminal ? '在新终端执行' : '交互式模式: 支持需要输入的命令'"
        @keydown.enter.prevent="useTerminal ? runConsoleCommand() : runInteractiveCommand()"
        :disabled="consoleRunning"
        clearable
      />
      <el-button 
        type="primary" 
        :icon="VideoPlay" 
        :loading="consoleRunning" 
        @click="useTerminal ? runConsoleCommand() : runInteractiveCommand()" 
        circle 
      />
    </div>

        <!-- 命令历史输出 -->
        <div class="console-output" v-if="consoleHistory.length">
          <div v-for="rec in consoleHistory" :key="rec.id" class="console-record">
            <div class="cmd-header cursor-pointer" @click="toggleCommandOutput(rec)">
              <div class="cmd-line">
                <span class="cmd-prefix">&gt;</span>
                <span class="cmd-text">{{ rec.command }}</span>
                <el-icon v-if="rec.running" class="running-icon is-loading" color="#409eff">
                  <Loading />
                </el-icon>
                <span class="ts">{{ rec.ts }}</span>
              </div>
              <div class="cmd-actions">
                <el-tooltip v-if="rec.running" content="停止命令" placement="top">
                  <el-button
                    text
                    size="small"
                    @click.stop="rec.isInteractive ? stopInteractiveCommand(rec) : stopCommand(rec)"
                    class="stop-btn"
                    type="danger"
                  >
                    <el-icon>
                      <Close />
                    </el-icon>
                  </el-button>
                </el-tooltip>
                <el-button
                  text
                  size="small"
                  @click.stop="toggleCommandOutput(rec)"
                  :disabled="!rec.stdout && !rec.stderr"
                  class="toggle-output-btn"
                >
                  <el-icon :class="{ 'rotate-icon': !rec.expanded }">
                    <ArrowDown />
                  </el-icon>
                </el-button>
              </div>
            </div>
            <transition name="output-slide">
              <div v-if="rec.expanded && (rec.stdout || rec.stderr)" class="output-content">
                <pre v-if="rec.stdout" class="stdout" v-html="rec.stdout"></pre>
                <pre v-if="rec.stderr" class="stderr" v-html="rec.stderr"></pre>
              </div>
            </transition>
            
            <!-- 每个交互式命令独立的 stdin 输入框 -->
            <div class="stdin-input-row" v-if="rec.isInteractive && rec.running">
              <el-icon class="stdin-icon"><Position /></el-icon>
              <el-input
                v-model="rec.stdinInput"
                class="stdin-input"
                placeholder="输入响应内容（如密码、确认等），按回车发送"
                @keydown.enter.prevent="sendStdinInput(rec)"
                clearable
                size="small"
              />
              <el-button type="success" @click="sendStdinInput(rec)" size="small">发送</el-button>
            </div>
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
  
  <!-- 编排工作台弹窗（合并了指令编排和编排管理） -->
  <OrchestrationWorkspace
    v-model:visible="orchestrationWorkspaceVisible"
    @execute-orchestration="executeOrchestration"
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
  padding: 4px 8px;
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
  /* background: linear-gradient(135deg, rgba(103, 194, 58, 0.1), rgba(103, 194, 58, 0.05)); */
  /* border: 1px solid rgba(103, 194, 58, 0.3); */
  border-radius: 6px;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
  transition: all 0.3s ease;
  
  /* &:hover {
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.15), rgba(103, 194, 58, 0.08));
    border-color: rgba(103, 194, 58, 0.5);
    transform: translateX(2px);
  } */
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

/* stdin 输入框样式 */
.stdin-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: linear-gradient(135deg, rgba(103, 194, 58, 0.05), rgba(103, 194, 58, 0.02));
  margin: 8px 0 0 0;
  border-radius: 6px;
  border: 1px solid rgba(103, 194, 58, 0.3);
  transition: all 0.3s ease;
  
  &:focus-within {
    border-color: #67c23a;
    box-shadow: 0 0 0 2px rgba(103, 194, 58, 0.1);
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.08), rgba(103, 194, 58, 0.03));
  }
}

.stdin-icon {
  color: #67c23a;
  font-size: 16px;
  flex-shrink: 0;
}

.stdin-input {
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
      color: rgba(103, 194, 58, 0.5);
      font-style: italic;
    }
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

.cmd-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.stop-btn {
  color: #f56c6c;
  padding: 4px 8px;
  
  &:hover {
    background: rgba(245, 108, 108, 0.1);
  }
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

.running-icon {
  font-size: 14px;
  color: #409eff;
  flex-shrink: 0;
  margin-left: 4px;
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

/* 不设置固定颜色，让ANSI转换的内联样式生效 */
pre.stderr {
  /* color由ANSI转换提供，保留背景色提示 */
  background: rgba(245, 108, 108, 0.05);
}

/* SVG图标按钮样式 */
.icon-btn {
  width: 18px;
  height: 18px;
  color: var(--text-secondary);
}

.toggle-console-btn:hover .icon-btn {
  color: var(--color-primary);
}
</style>
