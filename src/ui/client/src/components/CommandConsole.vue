<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted, nextTick, computed } from 'vue';
import { ArrowDown, FullScreen, VideoPlay, Loading, Close, Position, Monitor, Document, Timer, Ticket, Delete, RefreshRight, Folder } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import SvgIcon from '@components/SvgIcon/index.vue';
import IconButton from '@components/IconButton.vue';
import CustomCommandManager from '@components/CustomCommandManager.vue';
import ProjectStartupButton from '@components/ProjectStartupButton.vue';
import OrchestrationWorkspace from '@components/OrchestrationWorkspace.vue';
import FlowOrchestrationWorkspace from '@components/flow/FlowOrchestrationWorkspace.vue';
import type { CustomCommand } from '@components/CustomCommandManager.vue';
import { useConfigStore, type OrchestrationStep } from '@stores/configStore';
import { useGitStore } from '@stores/gitStore';
import { io, Socket } from 'socket.io-client';
import Convert from 'ansi-to-html';
import { replaceVariables } from '@/utils/commandParser';

const configStore = useConfigStore();
const gitStore = useGitStore();

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
const orchestrationPaused = ref(false); // 编排暂停状态
const consoleHistory = ref<ConsoleRecord[]>([]);
let consoleIdCounter = 0; // ID计数器，确保唯一性

// 清空执行历史
function clearConsoleHistory() {
  ElMessageBox.confirm(
    '确定要清空所有执行历史吗？此操作不可撤销。',
    '清空历史',
    {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning',
    }
  ).then(() => {
    consoleHistory.value = [];
    ElMessage.success('执行历史已清空');
  }).catch(() => {
    // 用户取消
  });
}

// 处理终端命令确认
function continueAfterTerminal() {
  if (terminalConfirmResolve) {
    terminalConfirmResolve(true);
  }
}

function stopAfterTerminal() {
  if (terminalConfirmResolve) {
    terminalConfirmResolve(false);
  }
}

// 处理用户确认节点
function continueUserConfirm() {
  if (userConfirmResolve) {
    userConfirmResolve(true);
  }
}

function stopUserConfirm() {
  if (userConfirmResolve) {
    userConfirmResolve(false);
  }
}

// 编排执行状态
const orchestrationSteps = ref<OrchestrationStep[]>([]); // 当前执行的编排步骤列表
const currentStepIndex = ref(-1); // 当前执行的步骤索引

// 终端命令等待确认状态
const waitingForTerminalConfirm = ref(false); // 是否正在等待终端命令确认
const waitingStepName = ref(''); // 当前等待的步骤名称
let terminalConfirmResolve: ((value: boolean) => void) | null = null; // Promise resolve 函数

// 用户确认节点等待状态
const waitingForUserConfirm = ref(false); // 是否正在等待用户确认节点
const waitingConfirmMessage = ref(''); // 确认消息
let userConfirmResolve: ((value: boolean) => void) | null = null; // Promise resolve 函数

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
  directory?: string; // 执行目录（用于重新执行保持一致）
  sessionId?: string; // 交互式会话区
  isInteractive?: boolean; // 是否为交互式命令
  stdinInput?: string; // 每个命令独立的 stdin 输入
};

type TerminalSession = {
  id: number;
  command: string;
  workingDirectory?: string;
  pid?: number | null;
  createdAt?: number;
  lastStartedAt?: number;
  alive?: boolean;
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
    0: 'var(--color-black)',
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
    15: 'var(--color-white)'
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

const terminalSessions = ref<TerminalSession[]>([]);
const terminalSessionsLoading = ref(false);
const savedShowTerminalSessions = localStorage.getItem('showTerminalSessions');
const showTerminalSessions = ref(savedShowTerminalSessions == null ? true : savedShowTerminalSessions === 'true');
const terminalSessionsCount = computed(() => terminalSessions.value.length);

const startupAutoRunTriggered = ref(false);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocketConnected(timeoutMs: number = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (socket.value && socket.value.connected) return true;
    await sleep(100);
  }
  return false;
}

async function runStartupCommandById(commandId: string) {
  const cmd = configStore.customCommands.find((c) => String(c.id) === String(commandId));
  if (!cmd) {
    ElMessage.warning(`启动项命令不存在: ${commandId}`);
    return;
  }

  const targetDir = cmd.directory || currentDirectory.value;
  const commandText = cmd.command;

  if (useTerminal.value) {
    try {
      const resp = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: commandText, workingDirectory: targetDir })
      });
      const result = await resp.json();
      if (result?.success) {
        if (result?.session) {
          upsertTerminalSession(result.session);
        } else {
          await loadTerminalSessions();
        }
      } else {
        ElMessage.error(result?.error || '启动项命令执行失败');
      }
    } catch (e: any) {
      ElMessage.error(e?.message || '启动项命令执行失败');
    }
    return;
  }

  const ok = await waitForSocketConnected();
  if (!ok) {
    ElMessage.error('Socket 连接未就绪，无法自动执行交互式启动项');
    return;
  }
  await runInteractiveCommandWithCmd(commandText, targetDir);
}

async function runStartupWorkflowById(orchestrationId: string) {
  const wf = configStore.orchestrations.find((o) => String(o.id) === String(orchestrationId));
  if (!wf) {
    ElMessage.warning(`启动项工作流不存在: ${orchestrationId}`);
    return;
  }
  await executeOrchestration(wf.steps || [], 0, false);
}

async function autoRunProjectStartupItems() {
  if (startupAutoRunTriggered.value) return;
  startupAutoRunTriggered.value = true;

  await configStore.loadConfig(false);

  const enabled = configStore.startupAutoRun;
  if (!enabled) return;

  const items = configStore.startupItems;
  const enabledItems = (items || []).filter((it: any) => it?.enabled !== false);
  if (enabledItems.length === 0) return;

  for (const it of enabledItems) {
    if (it.type === 'workflow') {
      await runStartupWorkflowById(it.refId);
    } else {
      await runStartupCommandById(it.refId);
    }
  }
}

const COMMAND_CONSOLE_SPLIT_KEY = 'zen-gitsync-commandconsole-ratio';
const clampPercent = (v: number) => Math.min(85, Math.max(15, v));
const savedSplit = localStorage.getItem(COMMAND_CONSOLE_SPLIT_KEY);
const initialSplit = (() => {
  const v = savedSplit ? parseFloat(savedSplit) : 25;
  return isNaN(v) ? 25 : clampPercent(v);
})();
const splitPercent = ref<number>(initialSplit);

const splitterRef = ref<any>(null);
const getSplitterWidth = () => {
  const el = splitterRef.value?.$el ?? splitterRef.value;
  if (el && el.clientWidth) return el.clientWidth as number;
  try {
    return el?.getBoundingClientRect?.().width ?? 0;
  } catch {
    return 0;
  }
};

const persistSplit = (v: number) => {
  try {
    localStorage.setItem(COMMAND_CONSOLE_SPLIT_KEY, String(clampPercent(v)));
  } catch {}
};

const updateSplitFromDom = () => {
  const root = splitterRef.value?.$el ?? splitterRef.value;
  if (!root) return;
  const panels = root.querySelectorAll?.('.el-splitter__panel');
  const width = getSplitterWidth();
  if (!panels || panels.length < 1 || width <= 0) return;
  const leftPx = (panels[0] as HTMLElement)?.getBoundingClientRect?.().width ?? 0;
  if (leftPx > 0) {
    const percent = clampPercent((leftPx / width) * 100);
    if (percent !== splitPercent.value) {
      splitPercent.value = percent;
      persistSplit(percent);
    }
  }
};

const panelSize = computed<string>({
  get() {
    return `${clampPercent(splitPercent.value)}%`;
  },
  set(val: string | number) {
    let percent = NaN;
    if (typeof val === 'number') {
      const width = getSplitterWidth();
      if (width > 0 && !isNaN(val)) {
        percent = (val / width) * 100;
      }
    } else if (typeof val === 'string') {
      if (val.endsWith('%')) {
        percent = parseFloat(val);
      } else if (val.endsWith('px')) {
        const px = parseFloat(val);
        const width = getSplitterWidth();
        if (width > 0 && !isNaN(px)) {
          percent = (px / width) * 100;
        }
      }
    }
    if (!isNaN(percent)) {
      splitPercent.value = clampPercent(percent);
      persistSplit(splitPercent.value);
    }
  }
});

async function loadTerminalSessionsStatus(cleanup: boolean = true) {
  // 只在有会话时才执行请求
  if (terminalSessions.value.length === 0) {
    return;
  }
  
  try {
    const resp = await fetch(`/api/terminal-sessions/status?cleanup=${cleanup ? 'true' : 'false'}`);
    const result = await resp.json();
    if (result?.success) {
      terminalSessions.value = Array.isArray(result.sessions) ? result.sessions : [];
    }
  } catch {
  }
}

function upsertTerminalSession(session: TerminalSession) {
  if (!session || typeof session.id !== 'number') return;
  const idx = terminalSessions.value.findIndex(s => s.id === session.id);
  if (idx !== -1) {
    terminalSessions.value[idx] = session;
  } else {
    terminalSessions.value.unshift(session);
  }
  terminalSessions.value = [...terminalSessions.value];
}

function getLastDirName(p?: string) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  const normalized = raw.replace(/\/+$/g, '').replace(/\+$/g, '');
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

async function loadTerminalSessions() {
  try {
    terminalSessionsLoading.value = true;
    const resp = await fetch('/api/terminal-sessions');
    const result = await resp.json();
    if (result?.success) {
      terminalSessions.value = Array.isArray(result.sessions) ? result.sessions : [];
    } else {
      ElMessage.error(result?.error || '获取终端会话失败');
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '获取终端会话失败');
  } finally {
    terminalSessionsLoading.value = false;
  }
}

async function restartTerminalSession(session: TerminalSession) {
  try {
    terminalSessionsLoading.value = true;
    const resp = await fetch(`/api/terminal-sessions/${session.id}/restart`, { method: 'POST' });
    const result = await resp.json();
    if (result?.success) {
      ElMessage.success('已重新启动终端');
      await loadTerminalSessions();
    } else {
      ElMessage.error(result?.error || '重新启动失败');
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '重新启动失败');
  } finally {
    terminalSessionsLoading.value = false;
  }
}

async function deleteTerminalSession(session: TerminalSession) {
  try {
    await ElMessageBox.confirm(
      '确定要删除该终端会话记录吗？如果该终端仍在运行，将尝试结束进程。',
      '删除终端会话',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
      }
    );

    terminalSessionsLoading.value = true;
    const resp = await fetch(`/api/terminal-sessions/${session.id}`, { method: 'DELETE' });
    const result = await resp.json();
    if (result?.success) {
      ElMessage.success('已删除');
      await loadTerminalSessions();
    } else {
      ElMessage.error(result?.error || '删除失败');
    }
  } catch (e: any) {
    if (e !== 'cancel') {
      ElMessage.error(e?.message || '删除失败');
    }
  } finally {
    terminalSessionsLoading.value = false;
  }
}

// 控制自定义命令管理弹窗
const commandManagerVisible = ref(false);

// 控制编排工作台弹窗（合并了指令编排和编排管理）
const orchestrationWorkspaceVisible = ref(false);
// 控制可视化编排工作台
const flowOrchestrationVisible = ref(false);

// 执行控制台命令
async function runConsoleCommand() {
  const cmd = consoleInput.value.trim();
  if (!cmd || consoleRunning.value) return;
  consoleInput.value = '';
  await runConsoleCommandWithCmd(cmd, currentDirectory.value);
}

async function runConsoleCommandWithCmd(cmd: string, directory: string = currentDirectory.value) {
  consoleRunning.value = true;
  
  // 如果使用终端执行
  if (useTerminal.value) {
    try {
      const resp = await fetch('/api/exec-in-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, workingDirectory: directory })
      });
      const result = await resp.json();
      if (result?.success) {
        ElMessage.success('已在新终端中执行命令');
        if (result?.session) {
          upsertTerminalSession(result.session);
        } else {
          await loadTerminalSessions();
        }
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
    directory,
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
      body: JSON.stringify({ command: cmd, directory: rec.directory })
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

function closeConsoleRecord(rec: ConsoleRecord) {
  consoleHistory.value = consoleHistory.value.filter(r => r.id !== rec.id);
}

async function rerunConsoleRecord(rec: ConsoleRecord) {
  const cmd = (rec.command || '').trim();
  if (!cmd) return;

  const directory = rec.directory || currentDirectory.value;

  if (rec.running) {
    if (rec.isInteractive) {
      stopInteractiveCommand(rec);
    } else {
      await stopCommand(rec);
    }
  }

  closeConsoleRecord(rec);

  if (rec.isInteractive) {
    await runInteractiveCommandWithCmd(cmd, directory);
  } else {
    await runConsoleCommandWithCmd(cmd, directory);
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

// 打开编排工作台（已被可视化编排工作台替代，暂时保留代码）
// function openOrchestrationWorkspace() {
//   orchestrationWorkspaceVisible.value = true;
// }

// 打开可视化编排工作台
function openFlowOrchestrationWorkspace() {
  flowOrchestrationVisible.value = true;
}

// 滚动到当前执行的步骤
function scrollToCurrentStep() {
  nextTick(() => {
    const currentStep = document.querySelector('.step-item.step-current');
    if (currentStep) {
      currentStep.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  });
}

// 判断命令是否是 git 相关命令
function isGitCommand(command: string): boolean {
  if (!command) return false;
  
  // 移除首尾空格并转小写
  const cmd = command.trim().toLowerCase();
  
  // 检查是否是 git 命令（以 git 开头，或者常见的 git 别名）
  return (
    cmd.startsWith('git ') || 
    cmd === 'git' ||
    // Windows 下的 git.exe
    cmd.startsWith('git.exe ') ||
    // 常见的 git 别名
    cmd.startsWith('g ') ||
    // 其他可能修改 git 状态的命令
    cmd.includes('git add') ||
    cmd.includes('git commit') ||
    cmd.includes('git push') ||
    cmd.includes('git pull') ||
    cmd.includes('git checkout') ||
    cmd.includes('git merge') ||
    cmd.includes('git rebase') ||
    cmd.includes('git reset') ||
    cmd.includes('git stash') ||
    cmd.includes('git branch') ||
    cmd.includes('git tag') ||
    cmd.includes('git fetch')
  );
}

// 从文本中提取版本号（匹配 semver 格式）
function extractVersionFromOutput(output: string): string | undefined {
  if (!output) return undefined;
  
  // 匹配常见的版本号格式：
  // - 1.2.3
  // - v1.2.3
  // - 1.2.3-beta.1
  // - ^1.2.3
  // - ~1.2.3
  const patterns = [
    /\bv?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/,  // 标准 semver
    /["']?\^?(\d+\.\d+\.\d+)["']?/,        // 带引号或前缀的版本号
    /version["']?:\s*["']?v?(\d+\.\d+\.\d+)/i  // "version": "1.2.3" 格式
  ];
  
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // 如果没有匹配到版本号，返回整个输出的第一行（去除空白）
  const firstLine = output.split('\n')[0]?.trim();
  return firstLine || undefined;
}

// 执行指令编排（顺序执行多个步骤）
// isSingleExecution: true表示单个步骤执行，false表示批量执行
async function executeOrchestration(steps: OrchestrationStep[], startIndex: number = 0, isSingleExecution: boolean = false) {
  if (steps.length === 0) return;
  
  // 关闭编排工作台弹窗
  orchestrationWorkspaceVisible.value = false;
  
  // 自动开启全屏模式
  isFullscreen.value = true;
  
  // 设置编排步骤列表和当前步骤
  orchestrationSteps.value = steps;
  currentStepIndex.value = startIndex;
  
  consoleRunning.value = true;
  orchestrationPaused.value = false; // 重置暂停状态
  
  // 节点输出存储（用于节点间引用）
  const nodeOutputs: Record<string, { stdout: string; version?: string }> = {};
  
  const totalSteps = steps.length - startIndex;
  if (startIndex > 0) {
    ElMessage.success(`从第 ${startIndex + 1} 步开始执行，共 ${totalSteps} 个步骤...`);
  } else {
    ElMessage.success(`开始执行 ${steps.length} 个步骤...`);
  }
  
  try {
  
  for (let i = startIndex; i < steps.length; i++) {
    // 检查是否被停止执行
    if (!consoleRunning.value) {
      throw new Error('用户停止执行');
    }
    
    const step = steps[i];
    
    // 更新当前步骤索引并滚动到当前步骤
    currentStepIndex.value = i;
    await nextTick();
    scrollToCurrentStep();
    
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
      let cmd = command.command;
      
      // 处理命令变量替换
      if (step.inputs && step.inputs.length > 0) {
        const variableValues: Record<string, string> = {};
        
        for (const input of step.inputs) {
          if (input.inputType === 'manual') {
            // 手动输入：直接使用输入的值
            variableValues[input.paramName] = input.manualValue || '';
          } else if (input.inputType === 'reference') {
            // 引用节点输出：从nodeOutputs中获取
            if (input.referenceNodeId && input.referenceOutputKey) {
              const nodeOutput = nodeOutputs[input.referenceNodeId];
              if (nodeOutput) {
                // 根据referenceOutputKey获取对应的输出值
                if (input.referenceOutputKey === 'stdout') {
                  variableValues[input.paramName] = nodeOutput.stdout || '';
                } else if (input.referenceOutputKey === 'version' && nodeOutput.version) {
                  variableValues[input.paramName] = nodeOutput.version;
                }
              } else {
                console.warn(`[变量替换] 未找到节点 ${input.referenceNodeId} 的输出`);
                variableValues[input.paramName] = '';
              }
            }
          }
        }
        
        // 替换命令中的变量
        cmd = replaceVariables(cmd, variableValues);
        console.log(`[变量替换] 原命令: ${command.command}`);
        console.log(`[变量替换] 变量值:`, variableValues);
        console.log(`[变量替换] 替换后: ${cmd}`);
      }
      
      ElMessage.info(`[${i + 1}/${steps.length}] 执行: ${stepLabel}${step.useTerminal ? ' (终端)' : ''}`);
      
      // 如果标记为终端执行，在新终端窗口执行
      if (step.useTerminal) {
        try {
          const workingDirectory = command.directory; // 传递命令的工作目录
          const shouldRestartExisting = step.restartExistingTerminal === true;

          if (shouldRestartExisting) {
            await loadTerminalSessionsStatus(false);
            const matched = terminalSessions.value.find((s) => {
              const sameCommand = (s?.command || '').trim() === String(cmd).trim();
              const sameDir = (s?.workingDirectory || '') === (workingDirectory || '');
              return sameCommand && sameDir;
            });

            if (matched) {
              const restartResp = await fetch(`/api/terminal-sessions/${matched.id}/restart`, { method: 'POST' });
              const restartResult = await restartResp.json();
              if (restartResult?.success) {
                ElMessage.success(`${stepLabel} 已重启现存终端命令`);
                await loadTerminalSessions();
              } else {
                throw new Error(restartResult?.error || '重启失败');
              }
            }
          }

          if (!shouldRestartExisting || !terminalSessions.value.some((s) => (s?.command || '').trim() === String(cmd).trim() && (s?.workingDirectory || '') === (workingDirectory || ''))) {
            const resp = await fetch('/api/exec-in-terminal', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                command: cmd,
                workingDirectory
              })
            });
            const result = await resp.json();
            if (result?.success) {
              ElMessage.success(`${stepLabel} 已在新终端中执行`);
              if (result?.session) {
                upsertTerminalSession(result.session);
              } else {
                await loadTerminalSessions();
              }
            } else {
              throw new Error(result?.error || '执行失败');
            }
          }
            
            // 等待用户确认命令执行完成（如果不是最后一个步骤）
            if (i < steps.length - 1 && shouldContinue) {
              waitingForTerminalConfirm.value = true;
              waitingStepName.value = stepLabel;
              
              // 使用 Promise 等待用户确认
              const userConfirmed = await new Promise<boolean>((resolve) => {
                terminalConfirmResolve = resolve;
              });
              
              waitingForTerminalConfirm.value = false;
              waitingStepName.value = '';
              terminalConfirmResolve = null;
              
              if (!userConfirmed) {
                shouldContinue = false;
                throw new Error('用户取消执行');
              }
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
        directory: command.directory || '',
        success: false,
        ts: new Date().toLocaleString(),
        expanded: true,
        stdout: '',
        stderr: '',
        running: true,
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
                  if (data.type === 'process_id') {
                    rec.processId = data.data;
                    consoleHistory.value = [...consoleHistory.value];
                  } else if (data.type === 'stdout') {
                    rec.stdout += ansiToHtml(data.data);
                  } else if (data.type === 'stderr') {
                    rec.stderr += ansiToHtml(data.data);
                  } else if (data.type === 'exit') {
                    rec.success = data.data.success;
                    rec.running = false;
                    consoleHistory.value = [...consoleHistory.value];
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
        } else {
                // 保存命令输出到 nodeOutputs，供后续节点引用
          const rawStdout = (rec.stdout || '').replace(/<[^>]*>/g, '').trim(); // 移除 HTML 标签
          const outputData = {
            stdout: rawStdout,
            // 尝试从输出中提取版本号（匹配 semver 格式）
            version: extractVersionFromOutput(rawStdout)
          };
          
          // 使用 step.id 存储
          nodeOutputs[step.id] = outputData;
          
          // 如果有节点 ID（nodeId），也用节点 ID 存储（用于节点间引用）
          if (step.nodeId) {
            nodeOutputs[step.nodeId] = outputData;
          }
          
          console.log(`[DEBUG] 存储输出 - step.id: ${step.id}, step.nodeId: ${step.nodeId}`);
          console.log(`[DEBUG] nodeOutputs keys:`, Object.keys(nodeOutputs));
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
      
      // 使用可中断的等待（显示倒计时）
      for (let countdown = seconds; countdown > 0; countdown--) {
        // 检查是否被停止
        if (!consoleRunning.value) {
          rec.stdout = `等待已中断（剩余 ${countdown} 秒）`;
          ElMessage.warning('等待已中断');
          throw new Error('用户停止执行');
        }
        rec.stdout = `等待中... 还剩 ${countdown} 秒`;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      rec.stdout = '等待完成';
    } else if (step.type === 'version') {
      // 执行版本管理
      
            // 处理引用输出：如果版本来源是 'reference'，从 nodeOutputs 中获取版本号
      let resolvedDependencyVersion = step.dependencyVersion;
      if (step.versionSource === 'reference' && step.inputRef) {
        const refNodeId = step.inputRef.nodeId;
        const refOutputKey = step.inputRef.outputKey;
        
        console.log(`[DEBUG] 引用查找 - refNodeId: ${refNodeId}`);
        console.log(`[DEBUG] nodeOutputs keys:`, Object.keys(nodeOutputs));
        
        const refOutput = nodeOutputs[refNodeId];
        console.log(`refOutput ==>`, refOutput)
        console.log(`refOutputKey ==>`, refOutputKey)
        
        if (refOutput) {
          if (refOutputKey === 'version' && refOutput.version) {
            resolvedDependencyVersion = refOutput.version;
          } else if (refOutputKey === 'stdout' && refOutput.stdout) {
            // 使用标准输出，尝试提取版本号
            resolvedDependencyVersion = extractVersionFromOutput(refOutput.stdout) || refOutput.stdout;
          }
        }
        
        if (!resolvedDependencyVersion) {
          ElMessage.error(`无法从节点 ${refNodeId} 获取输出，请检查前置节点是否执行成功`);
          break;
        }
      }
      
      if (step.versionTarget === 'dependency') {
        // 修改依赖版本
        const depType = step.dependencyType === 'devDependencies' ? 'devDep' : 'dep';
        if (step.versionSource === 'reference') {
          stepLabel = `修改依赖 [${depType}] ${step.dependencyName} → ${resolvedDependencyVersion} (引用输出)`;
        } else {
          stepLabel = `修改依赖 [${depType}] ${step.dependencyName} → ${resolvedDependencyVersion || '(自动递增)'}`;
        }
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
            bumpType: step.versionSource === 'bump' ? (step.versionBump || 'patch') : undefined,
            packageJsonPath: step.packageJsonPath || '',
            dependencyName: step.dependencyName,
            dependencyVersion: resolvedDependencyVersion,  // 使用解析后的版本号（可能来自引用）
            dependencyVersionBump: step.versionSource === 'bump' ? step.dependencyVersionBump : undefined,
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
    } else if (step.type === 'confirm') {
      // 执行用户确认节点
      stepLabel = '用户确认';
      
      ElMessage.info(`[${i + 1}/${steps.length}] ${stepLabel}`);
      
      const rec: ConsoleRecord = {
        id: ++consoleIdCounter,
        command: stepLabel,
        success: true,
        ts: new Date().toLocaleString(),
        expanded: true,
        stdout: '等待用户确认...',
        stderr: '',
      };
      consoleHistory.value.unshift(rec);
      
      // 使用内联确认条（不遮罩页面）
      waitingForUserConfirm.value = true;
      waitingConfirmMessage.value = `执行到确认节点（第 ${i + 1}/${steps.length} 步），是否继续执行后续步骤？`;
      
      // 使用 Promise 等待用户确认
      const userConfirmed = await new Promise<boolean>((resolve) => {
        userConfirmResolve = resolve;
      });
      
      waitingForUserConfirm.value = false;
      waitingConfirmMessage.value = '';
      userConfirmResolve = null;
      
      if (userConfirmed) {
        rec.stdout = '用户已确认，继续执行';
        ElMessage.success('已确认，继续执行');
      } else {
        rec.success = false;
        rec.stdout = '用户取消执行';
        ElMessage.warning('用户取消执行');
        shouldContinue = false;
      }
    }
    
    // 如果步骤执行失败，停止后续步骤
    if (!shouldContinue) {
      break;
    }
    
    // 如果不是最后一个步骤，检查暂停状态
    if (i < steps.length - 1) {
      // 等待一小段时间
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 检查是否被暂停（仅在批量执行时）
      if (!isSingleExecution && orchestrationPaused.value) {
        ElMessage.warning('编排已暂停');
        
        // 等待用户点击继续
        await new Promise<void>((resolve, reject) => {
          const checkInterval = setInterval(() => {
            if (!orchestrationPaused.value) {
              clearInterval(checkInterval);
              ElMessage.success('继续执行');
              resolve();
            }
            // 如果控制台不再运行（用户停止了），则退出等待
            if (!consoleRunning.value) {
              clearInterval(checkInterval);
              reject(new Error('用户停止执行'));
            }
          }, 100);
        }).catch(() => {
          // 用户停止执行
          throw new Error('用户停止执行');
        });
      }
    }
  }
  
    consoleRunning.value = false;
    orchestrationPaused.value = false; // 重置暂停状态
    currentStepIndex.value = -1; // 重置当前步骤
    orchestrationSteps.value = []; // 清空步骤列表
    ElMessage.success('所有步骤执行完成！');
    
    // 检查是否执行了 git 相关命令，如果是则刷新 git 状态
    const hasGitCommand = steps.some(step => {
      if (step.type === 'command') {
        const command = configStore.customCommands.find(c => c.id === step.commandId);
        if (command) {
          return isGitCommand(command.command);
        }
      }
      return false;
    });
    
    if (hasGitCommand) {
      await gitStore.fetchStatus();
      await gitStore.fetchLog();
    }
  } catch (error: any) {
    consoleRunning.value = false;
    orchestrationPaused.value = false; // 重置暂停状态
    currentStepIndex.value = -1; // 重置当前步骤
    orchestrationSteps.value = []; // 清空步骤列表
    if (error?.message === '用户停止执行') {
      ElMessage.info('编排执行已停止');
    } else {
      ElMessage.error(`编排执行异常: ${error?.message || String(error)}`);
    }
  }
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
        if (result?.session) {
          upsertTerminalSession(result.session);
        } else {
          await loadTerminalSessions();
        }
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
      directory: targetDir,
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
      directory: targetDir,
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
    const onExit = async (data: any) => {
      if (data.sessionId === sessionId) {
        rec.success = data.success;
        rec.running = false;
        console.log(`[交互式-自定义] 进程退出，成功:`, rec.success);
        consoleHistory.value = [...consoleHistory.value];
        
        // 如果是 git 命令，刷新 git 状态
        if (isGitCommand(cmd)) {
          await gitStore.fetchStatus();
          await gitStore.fetchLog();
        }
        
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
    directory: targetDir,
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
        directory: targetDir
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
    
    // 如果是 git 命令，刷新 git 状态
    if (isGitCommand(cmd)) {
      await gitStore.fetchStatus();
      await gitStore.fetchLog();
    }
  }
}

// 执行交互式命令
async function runInteractiveCommand() {
  const cmd = consoleInput.value.trim();
  if (!cmd || consoleRunning.value) return;
  consoleInput.value = '';
  await runInteractiveCommandWithCmd(cmd);
}

async function runInteractiveCommandWithCmd(cmd: string, directory: string = currentDirectory.value) {
  consoleRunning.value = true;
  
  // 生成会话ID
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // 创建命令记录
  const rec: ConsoleRecord = {
    id: ++consoleIdCounter,
    command: cmd,
    directory,
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
    directory,
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

watch(showTerminalSessions, (newValue) => {
  localStorage.setItem('showTerminalSessions', String(newValue));
  if (newValue) {
    loadTerminalSessionsStatus(true);
  }
});

watch(splitPercent, (v) => {
  persistSplit(v);
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

  await configStore.loadConfig(false);

  await loadTerminalSessions();

  await autoRunProjectStartupItems();
  
  // 监听页面可见性变化：标签页激活时刷新终端会话状态
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && showTerminalSessions.value) {
      console.log('[页面可见性] 标签页已激活，刷新终端会话状态');
      loadTerminalSessionsStatus(true);
    }
  };
  
  // 监听窗口获得焦点事件：从其他应用切换回浏览器时刷新
  const handleWindowFocus = () => {
    if (showTerminalSessions.value) {
      console.log('[窗口焦点] 浏览器窗口已激活，刷新终端会话状态');
      loadTerminalSessionsStatus(true);
    }
  };
  
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', handleWindowFocus);
  
  // 组件卸载时移除监听
  onUnmounted(() => {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('focus', handleWindowFocus);
  });
});

// Socket连接断开在onMounted中的onUnmounted回调中处理
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
        <!-- 编排暂停/继续按钮 -->
        <div v-if="consoleRunning" class="execution-controls">
          <el-tooltip :content="orchestrationPaused ? '继续执行' : '暂停执行'" placement="bottom">
            <el-button
              :type="orchestrationPaused ? 'success' : 'warning'"
              size="small"
              @click="orchestrationPaused = !orchestrationPaused"
              class="pause-btn"
            >
              <template #icon>
                <VideoPlay v-if="orchestrationPaused" />
                <Loading v-else />
              </template>
              {{ orchestrationPaused ? '继续' : '暂停' }}
            </el-button>
          </el-tooltip>
          <el-tooltip content="停止执行" placement="bottom">
            <el-button
              type="danger"
              size="small"
              @click="consoleRunning = false; orchestrationPaused = false; currentStepIndex = -1; orchestrationSteps = []"
              class="stop-btn"
            >
              <template #icon>
                <Close />
              </template>
              停止
            </el-button>
          </el-tooltip>
        </div>
        <IconButton
          :tooltip="'清空执行历史'"
          v-if="consoleHistory.length > 0"
          hover-color="var(--color-danger)"
          @click="clearConsoleHistory"
          custom-class="clear-history-btn"
        >
          <el-icon :size="18">
            <Delete />
          </el-icon>
        </IconButton>
        <IconButton
          :tooltip="$t('@CF05E:使用终端执行')"
          :active="useTerminal"
          @click="useTerminal = !useTerminal"
          custom-class="terminal-toggle-btn"
        >
          <el-icon :size="20">
            <Monitor />
          </el-icon>
        </IconButton>
        <IconButton
          :tooltip="$t('@CF05E:自定义命令管理')"
          hover-color="var(--color-success)"
          @click="openCommandManager"
          custom-class="command-manager-btn"
        >
          <SvgIcon icon-class="command-list" class-name="icon-btn" />
        </IconButton>
        <ProjectStartupButton 
          @execute-command="executeCustomCommand"
          @execute-workflow="(wf) => executeOrchestration(wf.steps || [], 0, false)"
        />
        <!-- 编排工作台按钮已被可视化编排工作台替代 -->
        <!-- <IconButton
          :tooltip="$t('@ORCHWS:编排工作台')"
          hover-color="var(--color-warning)"
          @click="openOrchestrationWorkspace"
          custom-class="orchestrator-btn"
        >
          <SvgIcon icon-class="command-orchestrate" class-name="icon-btn" />
        </IconButton> -->
        <IconButton
          :tooltip="$t('@ORCH:可视化编排')"
          hover-color="#9c27b0"
          @click="openFlowOrchestrationWorkspace"
          custom-class="flow-orchestrator-btn"
        >
          <el-icon :size="20">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M288 320a224 224 0 1 0 448 0 224 224 0 1 0-448 0zm544 608H160a32 32 0 1 1 0-64h672a32 32 0 1 1 0 64z"/>
              <path fill="currentColor" d="M64 832h896v64H64z"/>
              <path fill="currentColor" d="M512 512m-64 0a64 64 0 1 0 128 0 64 64 0 1 0-128 0Z"/>
              <path fill="currentColor" d="M512 128L512 448M320 320L512 448M704 320L512 448"/>
            </svg>
          </el-icon>
        </IconButton>
        <IconButton
          :tooltip="$t('@CF05E:全屏')"
          @click="isFullscreen = !isFullscreen"
        >
          <el-icon>
            <FullScreen />
          </el-icon>
        </IconButton>
        <IconButton
          :tooltip="isConsoleExpanded ? $t('@CF05E:收起控制台') : $t('@CF05E:展开控制台')"
          @click="isConsoleExpanded = !isConsoleExpanded"
        >
          <el-icon :class="{ 'rotate-icon': !isConsoleExpanded }">
            <ArrowDown />
          </el-icon>
        </IconButton>
      </div>
    </div>

    <!-- 内容区域 -->
    <transition name="console-content-slide">
      <div v-show="isConsoleExpanded" class="console-content">
        <el-splitter
          ref="splitterRef"
          layout="horizontal"
          style="height: 100%"
          @resize="updateSplitFromDom"
          @resize-end="updateSplitFromDom"
        >
          <el-splitter-panel v-model:size="panelSize" :min="'15%'" :max="'85%'">
            <div class="termial-session">
              <div v-if="showTerminalSessions" class="terminal-sessions-panel">
                <div class="terminal-sessions-header">
                  <div class="terminal-sessions-title">
                    <span>{{ $t('@CMDCON:终端会话') }}</span>
                    <span class="terminal-sessions-count">({{ terminalSessionsCount }})</span>
                  </div>
                  <div class="terminal-sessions-actions">
                    <el-tooltip :content="$t('@CMDCON:刷新')" placement="bottom">
                      <el-button text size="small" @click="loadTerminalSessions" :disabled="terminalSessionsLoading">
                        <el-icon><RefreshRight /></el-icon>
                      </el-button>
                    </el-tooltip>
                    <el-tooltip :content="$t('@CMDCON:隐藏')" placement="bottom">
                      <el-button text size="small" @click="showTerminalSessions = false">
                        <el-icon><ArrowDown /></el-icon>
                      </el-button>
                    </el-tooltip>
                  </div>
                </div>

                <div v-loading="terminalSessionsLoading" class="terminal-sessions-body">
                  <div v-if="terminalSessions.length === 0" class="terminal-sessions-empty">
                    {{ $t('@CMDCON:暂无终端会话') }}
                  </div>

                  <div v-else class="terminal-sessions-list">
                    <div v-for="session in terminalSessions" :key="session.id" class="terminal-session-item">
                      <div class="terminal-session-main">
                        <div class="terminal-session-command" :title="session.command">{{ session.command }}<span class="terminal-session-pid"> PID: {{ session.pid ?? '-' }}</span></div>
                        <div class="terminal-session-meta">
                          <el-tooltip v-if="session.workingDirectory" :content="session.workingDirectory" placement="top">
                            <span class="terminal-session-dir">
                              <el-icon class="cmd-dir-icon"><Folder /></el-icon>
                              {{ getLastDirName(session.workingDirectory) }}
                            </span>
                          </el-tooltip>
                        </div>
                      </div>
                      <div class="terminal-session-actions">
                        <el-tooltip :content="$t('@CMDCON:重新启动')" placement="top">
                          <el-button text size="small" @click="restartTerminalSession(session)">
                            <el-icon><RefreshRight /></el-icon>
                          </el-button>
                        </el-tooltip>
                        <el-tooltip :content="$t('@CMDCON:删除')" placement="top">
                          <el-button text size="small" type="danger" @click="deleteTerminalSession(session)">
                            <el-icon><Delete /></el-icon>
                          </el-button>
                        </el-tooltip>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div v-else class="terminal-sessions-collapsed">
                <el-button text size="small" @click="showTerminalSessions = true">
                  {{ $t('@CMDCON:显示终端会话', { count: terminalSessionsCount }) }}
                </el-button>
              </div>
            </div>
          </el-splitter-panel>
          <el-splitter-panel :min="'15%'" :max="'85%'">
            <div class="console-content-main">
          <!-- 编排步骤列表 -->
          <div v-if="orchestrationSteps.length > 0" class="orchestration-steps-panel">
            <div class="steps-header">
              <span class="steps-title">执行步骤 ({{ currentStepIndex + 1 }}/{{ orchestrationSteps.length }})</span>
            </div>
            <div class="steps-list">
              <div
                v-for="(step, index) in orchestrationSteps"
                :key="index"
                class="step-item"
                :class="{
                  'step-current': index === currentStepIndex,
                  'step-completed': index < currentStepIndex,
                  'step-pending': index > currentStepIndex,
                  'step-disabled': step.enabled === false,
                  [`step-type-${step.type}`]: true
                }"
              >
                <div class="step-indicator">
                  <el-icon v-if="index < currentStepIndex" class="step-icon-check">
                    <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                      <path fill="currentColor" d="M406.656 706.944L195.84 496.256a32 32 0 1 0-45.248 45.248l256 256 512-512a32 32 0 0 0-45.248-45.248L406.592 706.944z"/>
                    </svg>
                  </el-icon>
                  <el-icon v-else-if="step.type === 'wait'" class="step-type-icon">
                    <Timer />
                  </el-icon>
                  <el-icon v-else-if="step.type === 'version'" class="step-type-icon">
                    <Ticket />
                  </el-icon>
                  <el-icon v-else-if="step.type === 'command'" class="step-type-icon">
                    <Document />
                  </el-icon>
                  <span v-else class="step-number">{{ index + 1 }}</span>
                </div>
                <div class="step-content">
                  <div class="step-header">
                    <span class="step-type-tag" :class="`type-${step.type}`">
                      {{ step.type === 'command' ? '命令' : 
                         step.type === 'wait' ? '等待' : 
                         step.type === 'version' ? '版本' : step.type }}
                    </span>
                    <span v-if="step.useTerminal" class="step-terminal-tag" title="终端执行">
                      <el-icon class="step-terminal-icon"><Monitor /></el-icon>
                      终端
                    </span>
                    <span v-if="step.enabled === false" class="step-disabled-tag">已禁用</span>
                  </div>
                  <span class="step-name">
                    {{ step.type === 'command' ? step.commandName : 
                       step.type === 'wait' ? `${step.waitSeconds} 秒` : 
                       step.type === 'version' ? (
                         step.versionTarget === 'dependency' ? 
                         `${step.dependencyName}` : 
                         `${step.versionBump || 'patch'}`
                       ) : step.type }}
                  </span>
                </div>
              </div>
            </div>
            
            <!-- 终端命令等待确认提示 -->
            <div v-if="waitingForTerminalConfirm" class="terminal-waiting-panel">
              <div class="waiting-content">
                <el-icon class="waiting-icon"><Monitor /></el-icon>
                <div class="waiting-text">
                  <div class="waiting-title">等待终端命令完成</div>
                  <div class="waiting-desc">
                    终端命令 "<strong>{{ waitingStepName }}</strong>" 已在新窗口中打开，请在终端中查看命令执行结果
                  </div>
                </div>
              </div>
              <div class="waiting-actions">
                <el-button type="primary" @click="continueAfterTerminal">
                  <el-icon><VideoPlay /></el-icon>
                  继续下一步
                </el-button>
                <el-button type="danger" plain @click="stopAfterTerminal">
                  <el-icon><Close /></el-icon>
                  停止执行
                </el-button>
              </div>
            </div>
            
            <!-- 用户确认节点等待提示 -->
            <div v-if="waitingForUserConfirm" class="terminal-waiting-panel user-confirm-panel">
              <div class="waiting-content">
                <el-icon class="waiting-icon" style="color: #ff9800;">✋</el-icon>
                <div class="waiting-text">
                  <div class="waiting-title">用户确认节点</div>
                  <div class="waiting-desc">
                    {{ waitingConfirmMessage }}
                  </div>
                </div>
              </div>
              <div class="waiting-actions">
                <el-button type="primary" @click="continueUserConfirm">
                  <el-icon><VideoPlay /></el-icon>
                  继续执行
                </el-button>
                <el-button type="danger" plain @click="stopUserConfirm">
                  <el-icon><Close /></el-icon>
                  取消执行
                </el-button>
              </div>
            </div>
          </div>
          
          <!-- 输入区 -->
          <div class="console-input-row">
            <span class="prompt" :title="$t('@CF05E:当前路径')">{{ currentDirectory }} &gt;</span>
            <el-input
              v-model="consoleInput"
              class="console-input"
              :placeholder="useTerminal ? $t('@CMDCON:在新终端执行') : $t('@CMDCON:交互式模式')"
              @keydown.enter.prevent="useTerminal ? runConsoleCommand() : runInteractiveCommand()"
              :disabled="consoleRunning"
              clearable
            />
            <IconButton
              :disabled="consoleRunning"
              hover-color="var(--color-primary)"
              @click="useTerminal ? runConsoleCommand() : runInteractiveCommand()"
            >
              <el-icon v-if="consoleRunning" class="is-loading"><Loading /></el-icon>
              <el-icon v-else><VideoPlay /></el-icon>
            </IconButton>
          </div>
  
          <!-- 命令历史输出 -->
          <div class="console-output" v-if="consoleHistory.length">
            <div v-for="rec in consoleHistory" :key="rec.id" class="console-record">
              <div class="cmd-header cursor-pointer" @click="toggleCommandOutput(rec)">
                <div class="cmd-line">
                  <span class="cmd-prefix">&gt;</span>
                  <span class="cmd-text">{{ rec.command }}</span>
                  <span v-if="rec.directory" class="cmd-dir" :title="rec.directory">
                    <el-icon class="cmd-dir-icon"><Folder /></el-icon>
                    {{ rec.directory }}
                  </span>
                  <el-icon v-if="rec.running" class="running-icon is-loading" color="var(--color-primary)">
                    <Loading />
                  </el-icon>
                  <span class="ts">{{ rec.ts }}</span>
                </div>
                <div class="cmd-actions">
                  <el-tooltip content="重新执行" placement="top">
                    <el-button
                      text
                      size="small"
                      @click.stop="rerunConsoleRecord(rec)"
                      class="rerun-btn"
                    >
                      <el-icon>
                        <RefreshRight />
                      </el-icon>
                    </el-button>
                  </el-tooltip>
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
          </el-splitter-panel>
        </el-splitter>
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
  
  <!-- 可视化编排工作台（基于 vue-flow） -->
  <FlowOrchestrationWorkspace
    v-model:visible="flowOrchestrationVisible"
    @execute-orchestration="executeOrchestration"
  />
</template>

<style lang="scss" scoped>
/* 命令控制台容器 */
.command-console {
  margin-top: var(--spacing-md);
  background: var(--bg-code);
  border: 1px solid var(--border-component);
  border-radius: 10px;
  padding: 0;
  box-shadow: var(--shadow-md);
  transition: all 0.3s ease;
  overflow: hidden;
  
  &:hover {
    box-shadow: var(--shadow-hover);
    border-color: rgba(64, 158, 255, 0.3);
  }

  .console-content {
    flex: 1;
    overflow: hidden;
  }

  .termial-session {
    height: 100%;
    overflow: hidden;
  }

  .console-content-main {
    height: 100%;
    overflow: hidden;
    display: flex;
    flex-direction: column;
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
  gap: var(--spacing-base);
}

.title-icon {
  font-size: var(--font-size-md);
  color: var(--color-primary);
}

.console-title {
  
  font-weight: 600;
  color: var(--text-title);
  letter-spacing: 0.3px;
}

 .terminal-sessions-panel {
   background: var(--bg-panel);
   border-bottom: 1px solid var(--border-component);
 }

 .terminal-sessions-header {
   display: flex;
   align-items: center;
   justify-content: space-between;
   padding: 8px 12px;
 }

 .terminal-sessions-title {
   display: flex;
   align-items: baseline;
   gap: 6px;
   font-weight: 600;
   color: var(--text-title);
 }

 .terminal-sessions-count {
   font-weight: 500;
   color: var(--text-secondary);
 }

 .terminal-sessions-actions {
   display: flex;
   align-items: center;
   gap: 4px;
 }

 .terminal-sessions-body {
   padding: 8px 12px 12px;
 }

 .terminal-sessions-empty {
   padding: 10px 0;
   color: var(--text-secondary);
   font-size: 13px;
 }

 .terminal-sessions-list {
   display: flex;
   flex-direction: column;
   gap: 8px;
 }

 .terminal-session-item {
   display: flex;
   align-items: center;
   justify-content: space-between;
   gap: 10px;
   padding: 10px 12px;
   background: var(--bg-container);
   border: 1px solid var(--border-component);
   border-radius: 8px;
 }

 .terminal-session-main {
   flex: 1;
   min-width: 0;
 }

 .terminal-session-command {
   font-size: var(--font-size-md);
   font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
   color: var(--el-text-color-primary);
   white-space: nowrap;
   overflow: hidden;
   text-overflow: ellipsis;
 }

 .terminal-session-meta {
   margin-top: 6px;
   display: flex;
   flex-direction: column;
   align-items: flex-start;
   gap: 4px;
   font-size: 12px;
   color: var(--text-secondary);
 }

 .terminal-session-dir {
   display: inline-flex;
   align-items: center;
   gap: 4px;
   overflow: hidden;
   text-overflow: ellipsis;
   width: 100%;
   font-size: 12px;
 }

 .terminal-session-pid {
   display: inline-flex;
   align-items: center;
   white-space: nowrap;
   font-size: 11px;
   font-weight: 600;
   color: var(--text-secondary);
   background: rgba(64, 158, 255, 0.10);
   border: 1px solid rgba(64, 158, 255, 0.20);
   padding: 1px 6px;
   border-radius: 999px;
   margin-left: 6px;
   line-height: 1;
   vertical-align: middle;
 }

 .terminal-session-actions {
   display: flex;
   align-items: center;
   gap: 4px;
 }

 .terminal-sessions-collapsed {
   padding: 8px 12px;
   border-bottom: 1px solid var(--border-component);
   background: var(--bg-panel);
 }

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.terminal-toggle-btn {
  width: 36px;
  height: 36px;
  padding: var(--spacing-base);
  border-radius: var(--radius-md);
  transition: all 0.3s ease;
  
  .el-icon {
    color: var(--text-tertiary);
    transition: all 0.3s ease;
  }
  
  &:hover {
    background-color: rgba(64, 158, 255, 0.1);
    
    .el-icon {
      color: var(--color-primary);
    }
  }
  
  &.is-active {
    background-color: rgba(64, 158, 255, 0.15);
    
    .el-icon {
      color: var(--color-primary);
    }
    
    &:hover {
      background-color: rgba(64, 158, 255, 0.2);
    }
  }
}

.execution-controls {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.pause-btn, .stop-btn {
  font-weight: 500;
}

.command-manager-btn {
  &:hover {
    color: var(--color-success);
    background: rgba(103, 194, 58, 0.1);
  }
}

.project-startup-btn {
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
}

.orchestrator-btn {
  &:hover {
    color: var(--color-warning);
    background: rgba(230, 162, 60, 0.1);
  }
}

.orchestrator-manager-btn {
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
}

.toggle-console-btn {
  padding: var(--spacing-sm) var(--spacing-base);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  transition: all 0.3s ease;
  
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
  
  .el-icon {
    transition: transform 0.3s ease;
    font-size: var(--font-size-md);
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
  padding: var(--spacing-sm) var(--spacing-base);
  background: var(--bg-container);
  margin: var(--spacing-md);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  transition: all 0.3s ease;
  
  &:focus-within {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.1);
  }
}

.prompt {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-success);
  /* background: linear-gradient(135deg, rgba(103, 194, 58, 0.1), rgba(103, 194, 58, 0.05)); */
  /* border: 1px solid rgba(103, 194, 58, 0.3); */
  border-radius: var(--radius-md);
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
    padding: var(--spacing-sm) var(--spacing-base);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
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
  padding: var(--spacing-base) var(--spacing-xl);
  font-weight: 500;
  border-radius: var(--radius-md);
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
  
  &:active {
    transform: translateY(0);
  }
}

/* stdin 输入框样式 */
.stdin-input-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-base) var(--spacing-md);
  background: linear-gradient(135deg, rgba(103, 194, 58, 0.05), rgba(103, 194, 58, 0.02));
  margin: var(--spacing-base) 0 0 0;
  border-radius: var(--radius-md);
  border: 1px solid rgba(103, 194, 58, 0.3);
  transition: all 0.3s ease;
  
  &:focus-within {
    border-color: var(--color-success);
    box-shadow: 0 0 0 2px rgba(103, 194, 58, 0.1);
    background: linear-gradient(135deg, rgba(103, 194, 58, 0.08), rgba(103, 194, 58, 0.03));
  }
}

.stdin-icon {
  color: var(--color-success);
  font-size: var(--font-size-md);
  flex-shrink: 0;
}

.stdin-input {
  flex: 1;
  
  :deep(.el-input__wrapper) {
    background-color: transparent;
    box-shadow: none !important;
    border: none;
    padding: var(--spacing-sm) var(--spacing-base);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
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
    border-radius: var(--radius-base);
  }
  
  &::-webkit-scrollbar-thumb {
    background: var(--border-component);
    border-radius: var(--radius-base);
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
  padding: 10px var(--spacing-md);
  gap: var(--spacing-base);
}

.cmd-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.stop-btn {
  padding: var(--spacing-sm) var(--spacing-base);
  
  &:hover {
    background: rgba(245, 108, 108, 0.1);
  }
}

.cmd-line {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex: 1;
  min-width: 0;
}

.cmd-prefix {
  color: var(--color-primary);
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

.cmd-dir {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  font-weight: normal;
  padding: 0 var(--spacing-sm);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.cmd-dir-icon {
  font-size: 14px;
  margin-right: 2px;
  vertical-align: -2px;
}

.running-icon {
  
  color: var(--color-primary);
  flex-shrink: 0;
  margin-left: var(--spacing-sm);
}

.ts {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  font-weight: normal;
  /* background: var(--bg-panel); */
  padding: 0 var(--spacing-sm);
  /* border-radius: var(--radius-base); */
  flex-shrink: 0;
  opacity: 0.8;
}

.toggle-output-btn {
  padding: var(--spacing-sm);
  min-width: auto;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: all 0.3s ease;
  
  &:hover {
    color: var(--color-primary);
    background: rgba(64, 158, 255, 0.1);
  }
  
  .el-icon {
    transition: transform 0.3s ease;
    
  }
  
  .rotate-icon {
    transform: rotate(-90deg);
  }
}

.output-content {
  padding: 0 var(--spacing-md) 10px var(--spacing-md);
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
  padding: var(--spacing-base);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: var(--radius-base);
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

/* 编排步骤列表样式 */
.orchestration-steps-panel {
  margin-bottom: var(--spacing-md);
  background: var(--bg-panel);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* 终端命令等待确认面板 */
.terminal-waiting-panel {
  margin: var(--spacing-sm) var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: linear-gradient(135deg, 
    rgba(64, 158, 255, 0.08) 0%, 
    rgba(64, 158, 255, 0.02) 100%);
  border: 2px solid var(--color-primary);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
  animation: slideDown 0.3s ease-out;
}

.waiting-content {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  flex: 1;
}

.waiting-icon {
  font-size: 24px;
  color: var(--color-primary);
  flex-shrink: 0;
}

.waiting-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.waiting-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-primary);
  line-height: 1.3;
}

.waiting-desc {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  line-height: 1.4;
  
  strong {
    color: var(--text-primary);
    font-weight: 600;
  }
}

.waiting-actions {
  display: flex;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.steps-header {
  padding: var(--spacing-sm) var(--spacing-md);
  background: linear-gradient(135deg, var(--bg-container), var(--bg-panel));
  border-bottom: 1px solid var(--border-component);
}

.steps-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.steps-list {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-card) transparent;
  
  &::-webkit-scrollbar {
    height: 5px;
  }
  
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  
  &::-webkit-scrollbar-thumb {
    background: var(--border-card);
    border-radius: var(--radius-full);
    
    &:hover {
      background: var(--border-component);
    }
  }
}

.step-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 8px 12px;
  background: var(--bg-container);
  border: 1.5px solid var(--border-card);
  border-radius: var(--radius-md);
  min-width: 120px;
  max-width: 200px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  flex-shrink: 0;
  position: relative;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  cursor: default;
  
  // 不同类型步骤的边框颜色
  &.step-type-command:not(.step-current):not(.step-completed) {
    border-left: 3px solid rgba(64, 158, 255, 0.4);
  }
  
  &.step-type-wait:not(.step-current):not(.step-completed) {
    border-left: 3px solid rgba(230, 162, 60, 0.4);
  }
  
  &.step-type-version:not(.step-current):not(.step-completed) {
    border-left: 3px solid rgba(103, 194, 58, 0.4);
  }
  
  &:hover:not(.step-disabled) {
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  }
  
  &.step-current {
    border-color: var(--color-primary);
    border-width: 2px;
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.2),
                0 0 0 2px rgba(64, 158, 255, 0.12);
    
    // 命令类型
    &.step-type-command {
      background: linear-gradient(135deg, 
        rgba(64, 158, 255, 0.15) 0%, 
        rgba(64, 158, 255, 0.05) 100%);
    }
    
    // 等待类型
    &.step-type-wait {
      background: linear-gradient(135deg, 
        rgba(230, 162, 60, 0.15) 0%, 
        rgba(230, 162, 60, 0.05) 100%);
      border-color: var(--color-warning);
      box-shadow: 0 2px 8px rgba(230, 162, 60, 0.2),
                  0 0 0 2px rgba(230, 162, 60, 0.12);
      
      .step-indicator {
        background: linear-gradient(135deg, var(--color-warning), #f0ad4e);
        box-shadow: 0 0 6px rgba(230, 162, 60, 0.35),
                    0 0 0 2px rgba(230, 162, 60, 0.15);
        animation: pulse-ring-warning 1.8s ease-in-out infinite;
      }
      
      .step-name {
        color: var(--color-warning);
      }
    }
    
    // 版本类型
    &.step-type-version {
      background: linear-gradient(135deg, 
        rgba(103, 194, 58, 0.15) 0%, 
        rgba(103, 194, 58, 0.05) 100%);
      border-color: var(--color-success);
      box-shadow: 0 2px 8px rgba(103, 194, 58, 0.2),
                  0 0 0 2px rgba(103, 194, 58, 0.12);
      
      .step-indicator {
        background: linear-gradient(135deg, var(--color-success), #5cb85c);
        box-shadow: 0 0 6px rgba(103, 194, 58, 0.35),
                    0 0 0 2px rgba(103, 194, 58, 0.15);
        animation: pulse-ring-success 1.8s ease-in-out infinite;
      }
      
      .step-name {
        color: var(--color-success);
      }
    }
    
    
    .step-indicator {
      background: linear-gradient(135deg, var(--color-primary), #3a9eff);
      color: white;
      font-weight: 700;
      box-shadow: 0 0 6px rgba(64, 158, 255, 0.35),
                  0 0 0 2px rgba(64, 158, 255, 0.15);
      animation: pulse-ring 1.8s ease-in-out infinite;
      
      .step-type-icon {
        color: white;
      }
    }
    
    .step-name {
      color: var(--color-primary);
      font-weight: 600;
    }
  }
  
  &.step-completed {
    opacity: 0.75;
    background: rgba(103, 194, 58, 0.04);
    border-color: rgba(103, 194, 58, 0.3);
    
    .step-indicator {
      background: linear-gradient(135deg, var(--color-success), #5cb85c);
      color: white;
      font-weight: 600;
    }
    
    .step-name {
      color: var(--text-tertiary);
      opacity: 0.8;
    }
    
    .step-type-tag {
      opacity: 0.6;
    }
  }
  
  &.step-pending {
    opacity: 0.65;
    background: var(--bg-container);
    
    .step-indicator {
      background: var(--bg-panel);
      border: 2px solid var(--border-component);
      color: var(--text-tertiary);
      font-weight: 500;
    }
    
    .step-name {
      color: var(--text-secondary);
    }
    
    .step-type-tag {
      opacity: 0.7;
    }
  }
  
  &.step-disabled {
    opacity: 0.4;
    filter: grayscale(0.5);
    cursor: not-allowed;
    
    .step-indicator {
      background: var(--bg-panel);
      color: var(--text-disabled);
    }
    
    .step-name {
      color: var(--text-disabled);
      text-decoration: line-through;
    }
  }
}

.step-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--bg-panel);
  flex-shrink: 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  
  .step-type-icon {
    font-size: 14px;
    color: var(--text-tertiary);
  }
  
  .step-icon-check {
    font-size: 14px;
    color: white;
  }
}

.step-number {
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.step-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 4px;
}

.step-type-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  
  &.type-command {
    background: rgba(64, 158, 255, 0.12);
    color: var(--color-primary);
  }
  
  &.type-wait {
    background: rgba(230, 162, 60, 0.12);
    color: var(--color-warning);
  }
  
  &.type-version {
    background: rgba(103, 194, 58, 0.12);
    color: var(--color-success);
  }
}

.step-terminal-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
  color: #0ea5e9;
  background: rgba(14, 165, 233, 0.12);
  border: 1px solid rgba(14, 165, 233, 0.25);
}

.step-terminal-icon {
  font-size: 11px;
}

.step-name {
  font-size: 12.5px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.3s ease;
  line-height: 1.3;
}

.step-disabled-tag {
  font-size: 10px;
  color: var(--text-disabled);
  background: var(--bg-panel);
  padding: 1px 4px;
  border-radius: var(--radius-sm);
  align-self: flex-start;
}

@keyframes pulse-ring {
  0%, 100% {
    box-shadow: 0 0 6px rgba(64, 158, 255, 0.35),
                0 0 0 2px rgba(64, 158, 255, 0.25);
  }
  50% {
    box-shadow: 0 0 8px rgba(64, 158, 255, 0.5),
                0 0 0 4px rgba(64, 158, 255, 0);
  }
}

@keyframes pulse-ring-warning {
  0%, 100% {
    box-shadow: 0 0 6px rgba(230, 162, 60, 0.35),
                0 0 0 2px rgba(230, 162, 60, 0.25);
  }
  50% {
    box-shadow: 0 0 8px rgba(230, 162, 60, 0.5),
                0 0 0 4px rgba(230, 162, 60, 0);
  }
}

@keyframes pulse-ring-success {
  0%, 100% {
    box-shadow: 0 0 6px rgba(103, 194, 58, 0.35),
                0 0 0 2px rgba(103, 194, 58, 0.25);
  }
  50% {
    box-shadow: 0 0 8px rgba(103, 194, 58, 0.5),
                0 0 0 4px rgba(103, 194, 58, 0);
  }
}
</style>
