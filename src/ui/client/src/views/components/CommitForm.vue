<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, computed, watch, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Edit, Check, RefreshRight, Delete, Download, Connection, ArrowDown, Share, Warning, Loading, Box, Setting, Document } from "@element-plus/icons-vue";
import GlobalLoading from "@/components/GlobalLoading.vue";
import SuccessModal from "@/components/SuccessModal.vue";
import { useGlobalLoading } from "@/composables/useGlobalLoading";
import { useSuccessModal } from "@/composables/useSuccessModal";
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
import FileDiffViewer from "@components/FileDiffViewer.vue";
import CommonDialog from "@components/CommonDialog.vue";
import TemplateManager from "@components/TemplateManager.vue";
import GitCommandPreview from "@components/GitCommandPreview.vue";
import QuickPushButton from "@/components/buttons/QuickPushButton.vue";
import StageButton from "@/components/buttons/StageButton.vue";
import CommitButton from "@/components/buttons/CommitButton.vue";
import PushButton from "@/components/buttons/PushButton.vue";
import GitActionButtons from "@/components/GitActionButtons.vue";
import OptionSwitchCard from "@components/OptionSwitchCard.vue";
import CommandConsole from "@components/CommandConsole.vue";

const gitStore = useGitStore();
const configStore = useConfigStore();
const commitMessage = ref("");
const { loadingState, show: showLoading, hide: hideLoading, setText: setLoadingText } = useGlobalLoading();
const { successState, show: showSuccess } = useSuccessModal();
const isUpdatingStatus = ref(false); // 添加状态更新中的标识
// 添加placeholder变量
const placeholder = ref("输入提交信息...");
// 添加默认提交信息变量
const defaultCommitMessage = ref("");
const isStandardCommit = ref(false);
const commitType = ref("feat");
const commitScope = ref("");
const commitDescription = ref("");
const commitBody = ref("");
const commitFooter = ref("");

// 配置JSON编辑器
const configEditorVisible = ref(false);
const configEditorText = ref("");
const configEditorSaving = ref(false);

// 配置文件格式警告弹窗
const configWarningVisible = ref(false);
const configWarningMessage = ref('');

// 提交模板相关变量
const descriptionTemplates = ref<string[]>([]);
// 添加对话框可见性变量
const descriptionDialogVisible = ref(false);


// 添加合并分支相关的状态
const isMergeDialogVisible = ref(false);
const selectedBranch = ref('');
const mergeOptions = ref({
  noFf: false,
  squash: false,
  noCommit: false,
  message: ''
});

// 作用域模板相关变量
const scopeTemplates = ref<string[]>([]);
const scopeDialogVisible = ref(false);


// 默认提交信息设置相关变量
const defaultMessageDialogVisible = ref(false);


// 跳过钩子
const skipHooks = ref(false);

// 回车自动一键提交开关
const autoQuickPushOnEnter = ref(false);

// 添加控制正文和页脚显示的状态变量
const showAdvancedFields = ref(false);

// 提交类型选项（支持国际化）
const commitTypeOptions = computed(() => [
  { value: "feat", label: `feat: ${$t('@76872:新功能')}` },
  { value: "fix", label: `fix: ${$t('@76872:修复bug')}` },
  { value: "docs", label: `docs: ${$t('@76872:文档修改')}` },
  { value: "style", label: `style: ${$t('@76872:样式修改')}` },
  { value: "refactor", label: `refactor: ${$t('@76872:代码重构')}` },
  { value: "test", label: `test: ${$t('@76872:测试代码')}` },
  { value: "chore", label: `chore: ${$t('@76872:构建/工具修改')}` },
]);

// 添加stash相关的状态
const isStashDialogVisible = ref(false);
const isStashListDialogVisible = ref(false);
const stashMessage = ref('');
const includeUntracked = ref(true);
// 新增：排除锁定文件选项（默认不勾选）
const excludeLocked = ref(false);

// stash详情弹窗相关状态
const stashDetailVisible = ref(false);
const selectedStash = ref<{ id: string; description: string } | null>(null);
const stashFiles = ref<string[]>([]);
const stashDiff = ref('');
const isLoadingStashDetail = ref(false);
const selectedStashFile = ref('');

// 添加stash相关方法
function openStashDialog() {
  stashMessage.value = '';
  if(!allChangesAreLocked.value){
    excludeLocked.value = false;
  }
  isStashDialogVisible.value = true;
}

// 打开配置编辑器
async function openConfigEditor() {
  try {
    // 检查系统配置文件格式
    const formatCheckResp = await fetch('/api/config/check-file-format');
    const formatResult = await formatCheckResp.json();
    
    let warningMessage = '';
    if (formatResult.success) {
      if (!formatResult.exists) {
        warningMessage = $t('@76872:系统配置文件不存在，将使用默认配置。');
      } else if (!formatResult.isValidJson) {
        warningMessage = `${$t('@76872:系统配置文件格式有误：')}${formatResult.error}\n编辑后保存可能会覆盖原文件内容。`;
      }
    }
    
    const cfg = configStore.config;
    // 使用当前配置填充编辑器
    configEditorText.value = JSON.stringify(cfg, null, 2);
    
    // 如果有警告信息，先显示提示
    if (warningMessage) {
      configWarningMessage.value = warningMessage;
      configWarningVisible.value = true;
      return; // 停止执行，等待用户选择
    }
    
    configEditorVisible.value = true;
  } catch (e) {
    ElMessage.error($t('@76872:加载配置失败'));
  }
}

// 保存完整配置
async function saveFullConfig() {
  try {
    configEditorSaving.value = true;
    let parsed: any;
    try {
      parsed = JSON.parse(configEditorText.value);
    } catch (e: any) {
      ElMessage.error(`${$t('@76872:JSON 解析失败: ')}${e.message || e}`);
      return;
    }

    const resp = await fetch('/api/config/saveAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    });
    const result = await resp.json();
    if (!result.success) {
      throw new Error(result.error || $t('@76872:保存失败'));
    }
    // 重新加载配置
    await configStore.loadConfig(true);
    // 同步锁定文件列表（部分视图依赖独立接口）
    try {
      await configStore.loadLockedFiles();
    } catch {}
    // 同步本地模板列表，保证保存后UI立刻更新
    try {
      if (Array.isArray(configStore.descriptionTemplates)) {
        // pinia ref arrays
        descriptionTemplates.value = [...configStore.descriptionTemplates];
      }
    } catch {}
    try {
      if (Array.isArray(configStore.scopeTemplates)) {
        scopeTemplates.value = [...configStore.scopeTemplates];
      }
    } catch {}
    try {
      if (Array.isArray(configStore.messageTemplates)) {
        messageTemplates.value = [...configStore.messageTemplates];
      }
    } catch {}
    ElMessage.success($t('@76872:配置已保存'));
    configEditorVisible.value = false;
  } catch (err: any) {
    ElMessage.error(`${$t('@76872:保存配置失败: ')}${err.message || err}`);
  } finally {
    configEditorSaving.value = false;
  }
}

// 用系统默认程序打开用户主目录下的配置文件
async function openSystemConfigFile() {
  try {
    const resp = await fetch('/api/config/open-file', { method: 'POST' });
    const result = await resp.json();
    if (!resp.ok || !result?.success) {
      throw new Error(result?.error || $t('@76872:打开失败'));
    }
    ElMessage.success($t('@76872:已用系统程序打开配置文件'));
  } catch (err: any) {
    ElMessage.error(`${$t('@76872:打开配置文件失败: ')}${err?.message || err}`);
  }
}

// 处理配置文件警告弹窗的操作
function handleConfigWarningAction(action: 'continue' | 'open' | 'cancel') {
  configWarningVisible.value = false;
  
  if (action === 'continue') {
    // 继续编辑 - 打开JSON编辑器
    configEditorVisible.value = true;
  } else if (action === 'open') {
    // 打开系统配置文件
    openSystemConfigFile();
  }
  // action === 'cancel' 时什么也不做，只关闭弹窗
}

function openStashListDialog() {
  gitStore.getStashList();
  isStashListDialogVisible.value = true;
}

async function saveStash() {
  try {
    await gitStore.saveStash(stashMessage.value, includeUntracked.value, excludeLocked.value);
    isStashDialogVisible.value = false;
  } catch (error) {
    console.error('储藏失败:', error);
  }
}

async function applyStash(stashId: string, pop = false) {
  try {
    await gitStore.applyStash(stashId, pop);
    if (pop) {
      // 如果是应用并删除，刷新列表
      await gitStore.getStashList();
    }
  } catch (error) {
    console.error('应用储藏失败:', error);
  }
}

async function confirmDropStash(stashId: string) {
  ElMessageBox.confirm(
    $t('@76872:确定要删除此储藏吗？此操作不可恢复。'),
    $t('@76872:删除储藏'),
    {
      confirmButtonText: $t('@76872:确定'),
      cancelButtonText: $t('@76872:取消'),
      type: 'warning'
    }
  )
  .then(async () => {
    await gitStore.dropStash(stashId);
    await gitStore.getStashList();
  })
  .catch(() => {
    // 用户取消操作
  });
}

async function confirmClearAllStashes() {
  ElMessageBox.confirm(
    $t('@76872:确定要清空所有储藏吗？此操作不可恢复。'),
    $t('@76872:清空所有储藏'),
    {
      confirmButtonText: $t('@76872:确定'),
      cancelButtonText: $t('@76872:取消'),
      type: 'warning'
    }
  )
  .then(async () => {
    await gitStore.clearAllStashes();
    await gitStore.getStashList();
  })
  .catch(() => {
    // 用户取消操作
  });
}

// 查看stash详情
async function viewStashDetail(stash: { id: string; description: string }) {
  if (!stash) return;

  selectedStash.value = stash;
  stashDetailVisible.value = true;
  isLoadingStashDetail.value = true;
  stashFiles.value = [];
  stashDiff.value = '';
  selectedStashFile.value = '';

  try {
    // 确保 stash ID 有效
    if (!stash.id || stash.id.length < 7) {
      stashDiff.value = $t('@76872:无效的stash ID');
      isLoadingStashDetail.value = false;
      return;
    }

    // 获取stash的变更文件列表
    const filesResponse = await fetch(`/api/stash-files?stashId=${encodeURIComponent(stash.id)}`);
    const filesData = await filesResponse.json();

    if (filesData.success && Array.isArray(filesData.files)) {
      stashFiles.value = filesData.files;

      // 如果有文件，自动加载第一个文件的差异
      if (stashFiles.value.length > 0) {
        await getStashFileDiff(stash.id, stashFiles.value[0]);
      } else {
        stashDiff.value = $t('@76872:该stash没有变更文件');
      }
    } else {
      stashDiff.value = `${$t('@76872:获取文件列表失败: ')}${filesData.error || $t('@76872:未知错误')}`;
    }
  } catch (error) {
    stashDiff.value = `${$t('@76872:获取stash详情失败: ')}${(error as Error).message}`;
  } finally {
    isLoadingStashDetail.value = false;
  }
}

// 获取stash中特定文件的差异
async function getStashFileDiff(stashId: string, filePath: string) {
  isLoadingStashDetail.value = true;
  selectedStashFile.value = filePath;

  try {
    const diffResponse = await fetch(
      `/api/stash-file-diff?stashId=${encodeURIComponent(stashId)}&file=${encodeURIComponent(filePath)}`
    );
    const diffData = await diffResponse.json();

    if (diffData.success) {
      stashDiff.value = diffData.diff || $t('@76872:没有变更内容');
    } else {
      stashDiff.value = `${$t('@76872:获取差异失败: ')}${diffData.error || $t('@76872:未知错误')}`;
    }
  } catch (error) {
    stashDiff.value = `${$t('@76872:获取差异失败: ')}${(error as Error).message}`;
  } finally {
    isLoadingStashDetail.value = false;
  }
}

// 处理stash文件选择
function handleStashFileSelect(filePath: string) {
  if (selectedStash.value) {
    getStashFileDiff(selectedStash.value.id, filePath);
  }
}

// 处理打开文件
async function handleOpenFile(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || $t('@76872:打开文件失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@76872:打开文件失败: ')}${(error as Error).message}`);
  }
}

// 处理用VSCode打开文件
async function handleOpenWithVSCode(filePath: string, context: string) {
  try {
    const response = await fetch('/api/open-with-vscode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filePath,
        context
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.error || $t('@76872:用VSCode打开文件失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@76872:用VSCode打开文件失败: ')}${(error as Error).message}`);
  }
}



// 添加默认提交信息模板相关变量
const messageTemplates = ref<string[]>([]);


// 监听标准化提交状态变化，保存到localStorage
watch(isStandardCommit, (newValue) => {
  localStorage.setItem("zen-gitsync-standard-commit", newValue.toString());
});

// 监听跳过钩子状态变化，保存到localStorage
watch(skipHooks, (newValue) => {
  localStorage.setItem("zen-gitsync-skip-hooks", newValue.toString());
});

// 监听回车自动一键提交状态变化，保存到localStorage
watch(autoQuickPushOnEnter, (newValue) => {
  localStorage.setItem("zen-gitsync-auto-quick-push", newValue.toString());
});

// 计算最终的提交信息
const finalCommitMessage = computed(() => {
  if (!isStandardCommit.value) {
    // 如果用户没有输入提交信息，则使用默认提交信息
    return commitMessage.value || defaultCommitMessage.value;
  }

  // 构建标准化提交信息
  let message = `${commitType.value || ""}`;
  if (commitScope.value) {
    message += `(${commitScope.value})`;
  }
  message += `: ${commitDescription.value}`;

  if (commitBody.value) {
    message += `\n\n${commitBody.value}`;
  }

  if (commitFooter.value) {
    message += `\n\n${commitFooter.value}`;
  }

  return message;
});

// 计算是否有用户输入的提交信息（不包括默认提交信息）
const hasUserCommitMessage = computed(() => {
  if (!isStandardCommit.value) {
    // 普通提交模式：只有用户输入的提交信息才算有效
    return commitMessage.value.trim() !== '';
  } else {
    // 标准化提交模式：必须有提交类型和描述
    return commitType.value.trim() !== '' && commitDescription.value.trim() !== '';
  }
});

// 占位符：普通提交输入框，根据是否开启回车自动一键提交显示提示
const commitMessagePlaceholder = computed(() => {
  const base = `${$t('@76872:输入提交信息 (默认: ')}${defaultCommitMessage.value})`;
  return autoQuickPushOnEnter.value ? `${base}${$t('@76872:（按回车一键推送）')}` : base;
});

// 占位符：标准化提交的简短描述输入框，根据是否开启回车自动一键提交显示提示
const descriptionPlaceholder = computed(() => {
  const base = $t('@76872:简短描述（必填）');
  return autoQuickPushOnEnter.value ? $t('@76872:简短描述（必填，按回车一键推送）') : base;
});

// 为stash组件准备文件列表
const stashFilesForViewer = computed(() => {
  return stashFiles.value.map(file => ({
    path: file,
    name: file.split('/').pop() || file
  }));
});

// 计算Git命令预览
const gitCommandPreview = computed(() => {
  // 基本命令
  let command = `git commit -m "${finalCommitMessage.value}"`

  // 如果跳过钩子开关打开，添加 --no-verify 参数
  if (skipHooks.value) {
    command += ' --no-verify'
  }

  return command
});

// 使用配置信息
function updateFromConfig() {
  const config = configStore.config;
  if (config) {
    placeholder.value = `${$t('@76872:输入提交信息 (默认: ')}${config.defaultCommitMessage})`;
    defaultCommitMessage.value = config.defaultCommitMessage || "";

    // 加载描述模板
    if (config.descriptionTemplates && Array.isArray(config.descriptionTemplates)) {
      descriptionTemplates.value = config.descriptionTemplates;
    }

    // 加载作用域模板
    if (config.scopeTemplates && Array.isArray(config.scopeTemplates)) {
      scopeTemplates.value = config.scopeTemplates;
    }
    
    // 加载提交信息模板
    if (config.messageTemplates && Array.isArray(config.messageTemplates)) {
      messageTemplates.value = config.messageTemplates;
    }
  }
}







// 使用模板
function useTemplate(template: string) {
  commitDescription.value = template;
  descriptionDialogVisible.value = false;
}

// 使用作用域模板
function useScopeTemplate(template: string) {
  commitScope.value = template;
  scopeDialogVisible.value = false;
}

// 打开设置弹窗
function openDescriptionSettings() {
  descriptionDialogVisible.value = true;
}

// 打开作用域设置弹窗
function openScopeSettings() {
  scopeDialogVisible.value = true;
}

// 显示推送成功提示（保留兼容性）
function showPushSuccessIndicator() {
  showSuccess({
    text: $t('@76872:操作成功！'),
    description: $t('@76872:已完成操作'),
    duration: 2000
  });
}

// 处理git pull操作
async function handleGitPull() {
  try {
    // 使用store中的状态变量，而不是本地变量
    await gitStore.gitPull()
    // 刷新Git状态
    await gitStore.fetchStatus();
    await gitStore.fetchLog(false);
  } catch (error) {
    // 错误处理已经在store中完成
    console.error('拉取操作发生错误:', error)
  }
}

// 处理git fetch --all操作
async function handleGitFetchAll() {
  try {
    // 使用store中的状态变量，而不是本地变量
    await gitStore.gitFetchAll()
    // 刷新Git状态
    await gitStore.fetchStatus();
    await gitStore.fetchLog(false);
  } catch (error) {
    // 错误处理已经在store中完成
    console.error('获取远程分支信息操作发生错误:', error)
  }
}

// 添加并提交 (git add + git commit)
async function addAndCommit() {
  if (!finalCommitMessage.value.trim()) {
    ElMessage({
      message: "提交信息不能为空",
      type: "warning",
    });
    return;
  }

  try {
    await gitStore.addAndCommit(finalCommitMessage.value, skipHooks.value);

    // 清空提交信息
    clearCommitFields();

    // 触发成功事件
    gitStore.fetchStatus();
    gitStore.fetchLog();
  } catch (error) {
    ElMessage({
      message: `${$t('@76872:暂存并提交失败: ')}${(error as Error).message}`,
      type: "error",
    });
  }
}

// 重置到远程分支 (git reset --hard origin/branch)
async function resetToRemote() {
  try {
    await ElMessageBox.confirm(
      `${$t('@76872:确定要重置当前分支 "')}${gitStore.currentBranch}${$t('@76872:" 到远程状态吗？这将丢失所有未推送的提交和本地更改。')}`,
      $t('@76872:重置到远程分支'),
      {
        confirmButtonText: $t('@76872:确定'),
        cancelButtonText: $t('@76872:取消'),
        type: 'warning'
      }
    );

    const result = await gitStore.resetToRemote(gitStore.currentBranch);
    if (result) {
      // 触发状态更新事件
      gitStore.fetchStatus();
      // 更新提交历史
      gitStore.fetchLog();
    }
  } catch (error) {
    // 用户取消操作，不显示错误
    if ((error as any) !== 'cancel') {
      ElMessage({
        message: `${$t('@76872:重置到远程分支失败: ')}${(error as Error).message}`,
        type: 'error'
      });
    }
  }
}

// 清空提交字段
function clearCommitFields() {
  commitMessage.value = "";
  commitDescription.value = "";
  commitBody.value = "";
  commitFooter.value = "";
  
  // 如果开启了自动设置默认提交信息，则自动填充
  if (configStore.autoSetDefaultMessage && configStore.defaultCommitMessage) {
    commitMessage.value = configStore.defaultCommitMessage;
  }
}

// 处理QuickPushButton的推送前事件
function handleQuickPushBefore() {
  // 显示全局loading，初始显示暂存文件
  showLoading({
    text: $t('@76872:正在暂存文件...'),
    showProgress: false
  });
}

// 处理QuickPushButton的推送后事件
function handleQuickPushAfter(success: boolean) {
  // 关闭loading
  hideLoading();
  
  if (success) {
    // 等待分支状态刷新完成
    isUpdatingStatus.value = true;
    try {
      // 延时确保所有状态都已更新
      setTimeout(async () => {
        try {
          // 分支状态刷新完成，不再显示成功提示
          console.log($t('@76872:推送成功，状态已更新'));
        } catch (error) {
          console.error('一键推送后处理失败:', error);
        } finally {
          isUpdatingStatus.value = false;
        }
      }, 1000);
    } catch (error) {
      console.error('一键推送后处理失败:', error);
      isUpdatingStatus.value = false;
    }
  }
}

// 检查文件是否被锁定的同步方法
function isFileLocked(filePath: string): boolean {
  // 标准化路径分隔符，统一使用正斜杠
  const normalizedPath = filePath.replace(/\\/g, '/')
  return configStore.lockedFiles.some(lockedFile => {
    const normalizedLocked = lockedFile.replace(/\\/g, '/')
    return normalizedPath === normalizedLocked
  })
}

// 根据Git状态计算按钮禁用状态
const hasUnstagedChanges = computed(() => {
  return gitStore.fileList.some(file =>
    ['modified', 'deleted', 'untracked'].includes(file.type) &&
    !isFileLocked(file.path)
  );
});


// 计算已暂存文件数量（排除锁定文件）
const stagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file =>
    file.type === 'added' &&
    !isFileLocked(file.path)
  ).length;
});

const hasStagedChanges = computed(() => {
  return stagedFilesCount.value > 0;
});

// 新增：是否存在任何变更（包含锁定文件在内）
const anyChangesIncludingLocked = computed(() => {
  return gitStore.fileList.length > 0;
});

// 新增：是否所有变更均为锁定文件
const allChangesAreLocked = computed(() => {
  return gitStore.fileList.length > 0 && gitStore.fileList.every(file => isFileLocked(file.path));
});

const needsPush = computed(() => {
  return gitStore.branchAhead > 0;
});

const needsPull = computed(() => {
  return gitStore.branchBehind > 0;
});

const canReset = computed(() => {
  return hasStagedChanges.value;
});

const canResetToRemote = computed(() => {
  // 重置到远程会丢弃所有本地修改（包括锁定文件），所以应该检查所有变更
  const hasAnyLocalChanges = gitStore.fileList.length > 0; // 包括锁定和非锁定文件
  return gitStore.hasUpstream && (needsPush.value || needsPull.value || hasAnyLocalChanges);
});

// 使用默认提交信息模板
function useMessageTemplate(template: string) {
  // 设置为当前提交信息
  commitMessage.value = template;
  // 关闭弹窗
  defaultMessageDialogVisible.value = false;
}

// 处理回车键事件 - 自动一键提交
async function handleEnterKey(event: KeyboardEvent) {
  // 只在开启自动一键提交时处理
  if (!autoQuickPushOnEnter.value) {
    return;
  }

  // 检查是否有有效的提交信息
  if (!hasUserCommitMessage.value) {
    return;
  }

  // 添加与一键推送按钮相同的禁用逻辑判断
  // 检查是否有任何变更
  const hasAnyChangesValue = gitStore.fileList.some(file => !isFileLocked(file.path));
  
  // 检查是否满足推送条件（与QuickPushButton.vue中的isDisabled逻辑一致）
  if (!hasAnyChangesValue || !hasUserCommitMessage.value || !gitStore.hasUpstream) {
    return;
  }

  // 只在按下 Enter 键时处理（不包括 Shift+Enter）
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault(); // 阻止默认的换行行为

    try {
      // 执行一键提交推送
      handleQuickPushBefore();
      const result = await gitStore.addCommitAndPush(
        finalCommitMessage.value,
        skipHooks.value
      );
      if (result) {
        clearCommitFields();
      }
      handleQuickPushAfter(result);
    } catch (error) {
      console.error('回车自动一键提交失败:', error);
      handleQuickPushAfter(false);
    }
  }
}

// 设置为默认提交信息（从 TemplateManager 组件调用）
async function setDefaultFromTemplate(template: string) {
  try {
    const success = await configStore.saveDefaultMessage(template);
    if (success) {
      ElMessage.success($t('@76872:默认提交信息设置成功'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@76872:设置默认提交信息失败: ')}${(error as Error).message}`);
  }
}

// 监听GitStore状态变化，更新loading文字
watch(() => gitStore.isAddingFiles, (isAdding) => {
  if (isAdding && loadingState.visible) {
    setLoadingText($t('@76872:正在暂存文件...'));
  }
});

watch(() => gitStore.isCommiting, (isCommiting) => {
  if (isCommiting && loadingState.visible) {
    setLoadingText($t('@76872:正在提交更改...'));
  }
});

watch(() => gitStore.isPushing, (isPushing) => {
  if (isPushing && loadingState.visible) {
    // 推送阶段关闭loading，让进度弹窗接管
    hideLoading();
  }
});

onMounted(async () => {
  // 从localStorage加载标准化提交选项
  const savedStandardCommit = localStorage.getItem("zen-gitsync-standard-commit");
  if (savedStandardCommit !== null) {
    isStandardCommit.value = savedStandardCommit === "true";
  }

  // 从localStorage加载跳过钩子选项
  const savedSkipHooks = localStorage.getItem("zen-gitsync-skip-hooks");
  if (savedSkipHooks !== null) {
    skipHooks.value = savedSkipHooks === "true";
  }

  // 从localStorage加载回车自动一键提交选项
  const savedAutoQuickPush = localStorage.getItem("zen-gitsync-auto-quick-push");
  if (savedAutoQuickPush !== null) {
    autoQuickPushOnEnter.value = savedAutoQuickPush === "true";
  }

  // autoClosePushModal 现在由 configStore 统一管理，不需要在这里加载

  // 监听配置变化并更新
  watch(() => configStore.config, updateFromConfig, { immediate: true });
  
  // 确保配置已加载
  if (!configStore.config) {
    await configStore.loadConfig();
  }
  
  // 如果开启了自动设置默认提交信息，且当前提交信息为空，则自动填充
  if (configStore.autoSetDefaultMessage && configStore.defaultCommitMessage && !commitMessage.value) {
    commitMessage.value = configStore.defaultCommitMessage;
  }
});

// 打开合并分支对话框
function openMergeDialog() {
  selectedBranch.value = '';
  mergeOptions.value = {
    noFf: false,
    squash: false,
    noCommit: false,
    message: ''
  };
  branchTypeFilter.value = 'all'; // 默认显示所有分支
  isMergeDialogVisible.value = true;
  
  // 确保已经加载了分支列表
  if (gitStore.allBranches.length === 0) {
    gitStore.getAllBranches();
  }
}

// 分支类型过滤器
const branchTypeFilter = ref('all');

// 根据分支类型过滤分支列表
const filteredBranches = computed(() => {
  const branches = gitStore.allBranches.filter(b => b !== gitStore.currentBranch);
  
  console.log('筛选分支列表:', {
    allBranches: gitStore.allBranches,
    currentBranch: gitStore.currentBranch,
    branchTypeFilter: branchTypeFilter.value,
    filteredBranches: branches
  });
  
  if (branchTypeFilter.value === 'local') {
    // 过滤本地分支（不包含 'origin/' 前缀的分支）
    const localBranches = branches.filter(b => !b.includes('origin/'));
    console.log('本地分支:', localBranches);
    return localBranches;
  } else if (branchTypeFilter.value === 'remote') {
    // 过滤远程分支（包含 'origin/' 前缀的分支）
    const remoteBranches = branches.filter(b => b.includes('origin/'));
    console.log('远程分支:', remoteBranches);
    return remoteBranches;
  } else {
    // 返回所有分支
    console.log('所有分支:', branches);
    return branches;
  }
});

// 执行合并分支操作
async function handleMergeBranch() {
  if (!selectedBranch.value) {
    ElMessage({
      message: $t('@76872:请选择要合并的分支'),
      type: 'warning'
    });
    return;
  }
  
  try {
    const result = await gitStore.mergeBranch(selectedBranch.value, mergeOptions.value);
    if (result) {
      isMergeDialogVisible.value = false;
      // 刷新Git状态
      await gitStore.fetchStatus();
      await gitStore.fetchLog(false);
    }
  } catch (error) {
    console.error('合并分支操作发生错误:', error);
  }
}

// 添加抽屉状态变量
const gitOperationsDrawerVisible = ref(false);

// 添加提交设置弹窗状态变量
const commitSettingsDialogVisible = ref(false);

// 切换抽屉显示/隐藏
function toggleGitOperationsDrawer() {
  gitOperationsDrawerVisible.value = !gitOperationsDrawerVisible.value;
}

// 向父组件暴露方法，便于从 Header 触发
defineExpose({ openConfigEditor, toggleGitOperationsDrawer });

// 查询描述模板的函数
function queryDescriptionTemplates(queryString: string, callback: (suggestions: any[]) => void) {
  const templateResults = queryString
    ? descriptionTemplates.value.filter(template => 
        template.toLowerCase().includes(queryString.toLowerCase())
      ).map(template => ({ value: template }))
    : descriptionTemplates.value.map(template => ({ value: template }));
  
  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: '⚙️ 管理模板...', isSettings: true }
  ];
  callback(results);
}

// 查询作用域模板的函数
function queryScopeTemplates(queryString: string, callback: (suggestions: any[]) => void) {
  const templateResults = queryString
    ? scopeTemplates.value.filter(template => 
        template.toLowerCase().includes(queryString.toLowerCase())
      ).map(template => ({ value: template }))
    : scopeTemplates.value.map(template => ({ value: template }));
  
  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: '⚙️ 管理模板...', isSettings: true }
  ];
  callback(results);
}

// 处理描述选择
function handleDescriptionSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    openDescriptionSettings();
    // 清空输入框中的设置选项文本
    commitDescription.value = '';
  } else {
    commitDescription.value = item.value;
  }
}

// 处理作用域选择
function handleScopeSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    openScopeSettings();
    // 清空输入框中的设置选项文本
    commitScope.value = '';
  } else {
    commitScope.value = item.value;
  }
}

// 查询提交信息模板的函数
function queryMessageTemplates(queryString: string, callback: (suggestions: any[]) => void) {
  const templateResults = queryString
    ? messageTemplates.value.filter(template => 
        template.toLowerCase().includes(queryString.toLowerCase())
      ).map(template => ({ value: template }))
    : messageTemplates.value.map(template => ({ value: template }));
  
  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: '⚙️ 管理模板...', isSettings: true }
  ];
  callback(results);
}

// 处理提交信息选择
function handleMessageSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    defaultMessageDialogVisible.value = true;
    // 清空输入框中的设置选项文本
    commitMessage.value = '';
  } else {
    commitMessage.value = item.value;
  }
}


</script>

<template>
  <div class="card app-card" :class="{ 'is-pushing': gitStore.isPushing }">
    <div class="card-header app-card-header">
      <div class="header-left">
        <!-- <h2>{{ $t('@76872:提交更改') }}</h2> -->
        <!-- 提交模式开关 -->
        <OptionSwitchCard
          v-model="isStandardCommit"
          :title="$t('@76872:提交模式')"
          :tooltip="$t('@76872:选择传统或标准化提交格式')"
          :active-text="$t('@76872:标准化')"
          :inactive-text="$t('@76872:普通')"
          active-color="#409eff"
        >
          <template #icon>
            <el-icon><Edit /></el-icon>
          </template>
        </OptionSwitchCard>
        <el-button
          v-if="gitStore.userName !== '' && gitStore.userEmail !== ''"
          :icon="Setting"
          @click="commitSettingsDialogVisible = true"
          class="modern-btn btn-icon-24"
        />
      </div>
      <!-- Git操作按钮组 - 移到标题右侧 -->
      <div class="header-actions" v-if="gitStore.userName !== '' && gitStore.userEmail !== ''">
        <GitActionButtons
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          from="form"
          @after-commit="(success) => { if (success) clearCommitFields() }"
          @after-push="handleQuickPushAfter"
          @before-push="handleQuickPushBefore"
          @clear-fields="clearCommitFields"
        />
      </div>
    </div>

    <div class="card-content app-card-content">
      <div class="layout-container">
        <!-- 如果没有配置Git用户信息，显示提示 -->
        <div v-if="gitStore.userName === '' || gitStore.userEmail === ''" class="git-config-warning">
          <el-alert
            :title="$t('@76872:Git用户信息未配置')"
            type="warning"
            :closable="false"
            show-icon
          >
            <p>{{ $t('@76872:您需要配置Git用户名和邮箱才能提交代码。请使用以下命令配置：') }}</p>
            <pre class="config-command">git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"</pre>
          </el-alert>
        </div>
        
        <!-- 正常的提交区域，仅在Git用户信息已配置时显示 -->
        <template v-else>
          <!-- 左侧：提交表单 -->
          <div class="commit-section">


            <GitCommandPreview 
              :command="gitCommandPreview"
              :title="$t('@76872:提交命令预览：')"
              placeholder="git commit -m &quot;<提交信息>&quot;"
            />

            <!-- 普通提交表单 -->
            <div v-if="!isStandardCommit" class="commit-form">
              <div class="description-container">
                <el-autocomplete
                  v-model="commitMessage"
                  :fetch-suggestions="queryMessageTemplates"
                  :placeholder="commitMessagePlaceholder"
                  type="textarea"
                  :rows="3"
                  resize="none"
                  class="commit-message-input"
                  @select="handleMessageSelect"
                  @keydown="handleEnterKey"
                />
              </div>
            </div>

            <!-- 标准化提交表单 -->
            <div v-else class="standard-commit-form">
              <div class="standard-commit-header">
                <div class="type-scope-container">
                  <el-select v-model="commitType" :placeholder="$t('@76872:提交类型')" class="type-select" clearable>
                    <el-option v-for="item in commitTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>

                  <div class="scope-wrapper">
                    <el-autocomplete
                      v-model="commitScope"
                      :fetch-suggestions="queryScopeTemplates"
                      :placeholder="$t('@76872:作用域（可选）')"
                      class="scope-input"
                      clearable
                      @select="handleScopeSelect"
                    />
                  </div>

                  <!-- 将简短描述放入同一行 -->
                  <div class="description-container description-inline">
                    <el-autocomplete
                      v-model="commitDescription"
                      :fetch-suggestions="queryDescriptionTemplates"
                      :placeholder="descriptionPlaceholder"
                      class="description-input"
                      clearable
                      @select="handleDescriptionSelect"
                      @keydown="handleEnterKey"
                    />
                  </div>
                </div>
              </div>

              <!-- 添加展开/收起高级选项的控制按钮 -->
              <div class="advanced-options-toggle" @click="showAdvancedFields = !showAdvancedFields">
                <span>{{ showAdvancedFields ? $t('@76872:收起') : $t('@76872:正文及页脚') }}</span>
                <el-icon class="toggle-icon" :class="{ 'is-active': showAdvancedFields }">
                  <arrow-down />
                </el-icon>
              </div>

              <!-- 使用过渡效果包装高级字段 -->
              <div v-show="showAdvancedFields" class="advanced-fields">
                <el-input v-model="commitBody" type="textarea" :rows="4" :placeholder="$t('@76872:正文（可选）：详细描述本次提交的内容和原因')" class="body-input"
                  clearable />

                <el-input v-model="commitFooter" :placeholder="$t('@76872:页脚（可选）：如 Closes #123')" class="footer-input" clearable />
              </div>
            </div>
            
            <!-- 自定义指令执行控制台 -->
            <CommandConsole />
          </div>
        </template>
      </div>
      </div>
    </div>

    <!-- Git操作抽屉 -->
      <el-drawer
        v-model="gitOperationsDrawerVisible"
        :title="$t('@76872:Git 操作')"
        direction="rtl"
        size="362px"
        :with-header="true"
        :show-close="true"
        :destroy-on-close="false"
        class="git-operations-drawer"
      >
        <div class="actions-section">
          <div class="action-groups">
            <div class="operations-wrapper">
              <!-- 基础操作 -->
              <div class="action-group">
                <div class="group-title">{{ $t('@76872:基础操作') }}</div>
                <div class="group-buttons">
                  <StageButton
                    @click="() => {}"
                    from="drawer"
                  />

                  <CommitButton
                    :has-user-commit-message="hasUserCommitMessage"
                    :final-commit-message="finalCommitMessage"
                    :skip-hooks="skipHooks"
                    @before-commit="() => {}"
                    @after-commit="(success) => { if (success) clearCommitFields() }"
                    @click="() => {}"
                    from="drawer"
                  />

                  <PushButton
                    @before-push="() => {}"
                    @after-push="(success) => { if (success) showPushSuccessIndicator() }"
                    @click="() => {}"
                    from="drawer"
                  />
                  
                  <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : (needsPull ? `${$t('@76872:拉取')}${gitStore.branchBehind}${$t('@76872:个远程提交')}` : 'git pull')" placement="top">
                    <el-button 
                      type="primary"
                      :icon="Download"
                      @click="handleGitPull"
                      :loading="gitStore.isGitPulling"
                      :disabled="!gitStore.hasUpstream || gitStore.hasConflictedFiles"
                      class="action-button"
                      :style="gitStore.hasUpstream && !gitStore.hasConflictedFiles ? {color: 'white', backgroundColor: '#1e90ff', borderColor: '#1e90ff'} : {}"
                    >
                      {{ $t('@76872:拉取') }}
                      <span v-if="needsPull">({{gitStore.branchBehind}})</span>
                    </el-button>
                  </el-tooltip>
                  
                  <el-tooltip content="git fetch --all" placement="top">
                    <el-button 
                      type="info"
                      :icon="Connection"
                      @click="handleGitFetchAll"
                      :loading="gitStore.isGitFetching"
                      class="action-button"
                      style="color: white; background-color: #1e90ff; border-color: #1e90ff;"
                    >
                      {{ $t('@76872:获取所有远程分支') }}
                    </el-button>
                  </el-tooltip>
                </div>
              </div>

              

              <!-- 组合操作 -->
              <div class="action-group">
                <div class="group-title">{{ $t('@76872:组合操作') }}</div>
                <div class="group-buttons">
                  <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git add + git commit'" placement="top">
                    <el-button 
                      type="primary"
                      :icon="Edit"
                      @click="addAndCommit"
                      :loading="gitStore.isAddingFiles || gitStore.isCommiting"
                      :disabled="!hasUnstagedChanges || !hasUserCommitMessage || gitStore.hasConflictedFiles"
                      class="action-button"
                    >
                      {{ $t('@76872:暂存并提交') }}
                    </el-button>
                  </el-tooltip>

                  <QuickPushButton 
                    from="drawer"
                    :has-user-commit-message="hasUserCommitMessage"
                    :final-commit-message="finalCommitMessage"
                    :skip-hooks="skipHooks"
                    @before-push="handleQuickPushBefore"
                    @after-push="handleQuickPushAfter"
                    @clear-fields="clearCommitFields"
                  />
                </div>
              </div>
            </div>

            <!-- 重置操作 -->
            <div class="action-group reset-group">
              <div class="group-title">{{ $t('@76872:重置操作') }}</div>
              <div class="group-buttons">
                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : (canReset ? `${$t('@76872:撤销')}${stagedFilesCount}${$t('@76872:个已暂存文件')}` : 'git reset HEAD')" placement="top">
                  <el-button 
                    type="warning"
                    :icon="RefreshRight"
                    @click="gitStore.resetHead"
                    :loading="gitStore.isResetting"
                    :disabled="!canReset || gitStore.hasConflictedFiles"
                    class="action-button reset-button"
                  >
                    {{ $t('@76872:重置暂存区') }}
                    <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                  </el-button>
                </el-tooltip>

                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : 'git reset --hard origin/branch'" placement="top">
                  <el-button 
                    type="danger"
                    :icon="Delete"
                    @click="resetToRemote"
                    :loading="gitStore.isResetting"
                    :disabled="!canResetToRemote || gitStore.hasConflictedFiles"
                    class="action-button danger-button"
                  >
                    {{ $t('@76872:重置到远程') }}
                  </el-button>
                </el-tooltip>
              </div>
            </div>
            
            <!-- 添加单独的分支操作组 -->
            <div class="action-group branch-group">
              <div class="group-title">{{ $t('@76872:分支操作') }}</div>
              <div class="group-buttons">
                <!-- 合并分支按钮 -->
                <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:合并其他分支到当前分支')" placement="top">
                  <el-button 
                    type="primary"
                    :icon="Share"
                    @click="openMergeDialog"
                    :loading="gitStore.isGitMerging"
                    :disabled="gitStore.hasConflictedFiles"
                    class="action-button merge-button"
                  >
                    {{ $t('@76872:合并分支') }}
                  </el-button>
                </el-tooltip>
              </div>
            </div>

            <!-- 储藏操作 -->
            <div class="action-group">
                <div class="group-title">{{ $t('@76872:储藏操作') }}</div>
                <div class="group-buttons">
                  <el-tooltip :content="gitStore.hasConflictedFiles ? $t('@76872:存在冲突文件，请先解决冲突') : $t('@76872:将工作区更改储藏起来')" placement="top">
                    <el-button 
                      type="warning" 
                      @click="openStashDialog" 
                      :loading="gitStore.isSavingStash"
                      :disabled="!anyChangesIncludingLocked || gitStore.hasConflictedFiles"
                      class="action-button"
                    >
                      {{ $t('@76872:储藏更改') }}
                    </el-button>
                  </el-tooltip>

                  <el-tooltip :content="$t('@76872:查看和管理所有储藏记录')" placement="top">
                    <el-button 
                      type="info"
                      @click="openStashListDialog"
                      class="action-button"
                    >
                      {{ $t('@76872:储藏列表') }}
                    </el-button>
                  </el-tooltip>
                </div>
              </div>
          </div>
        </div>
      </el-drawer>

      <!-- 配置JSON编辑弹窗 -->
      <CommonDialog
        v-model="configEditorVisible"
        :title="$t('@76872:编辑配置 JSON')"
        size="large"
        height-mode="fixed"
        custom-class="config-editor-dialog"
        :show-footer="false"
      >
          <!-- 编辑器头部信息 -->
          <div class="editor-header">
            <div class="editor-info">
              <el-icon class="info-icon"><Edit /></el-icon>
              <span class="info-text">{{ $t('@76872:编辑当前项目的配置文件') }}</span>
            </div>
            <div class="editor-tips">
              <el-tag size="small" type="info">{{ $t('@76872:支持JSON格式') }}</el-tag>
            </div>
          </div>
          
          <!-- JSON编辑器 -->
          <div class="json-editor-wrapper">
            <el-input
              v-model="configEditorText"
              type="textarea"
              spellcheck="false"
              autocomplete="off"
              :placeholder="$t('@76872:在此编辑当前项目配置的 JSON...')"
              class="json-editor"
            />
          </div>
          
          <!-- 底部操作按钮 -->
          <div class="editor-footer">
            <div class="footer-left">
              <el-button 
                :icon="Connection" 
                @click="openSystemConfigFile"
                class="system-config-btn"
              >
                {{ $t('@76872:打开系统配置文件') }}
              </el-button>
            </div>
            <div class="footer-right">
              <el-button @click="configEditorVisible = false">{{ $t('@76872:取消') }}</el-button>
              <el-button 
                type="primary" 
                :loading="configEditorSaving" 
                :icon="Check"
                @click="saveFullConfig"
                class="save-btn"
              >
                {{ $t('@76872:保存配置') }}
              </el-button>
            </div>
          </div>
      </CommonDialog>

      <!-- 配置文件格式警告弹窗 -->
      <el-dialog
        v-model="configWarningVisible"
        :title="$t('@76872:配置文件格式提示')"
        width="500px"
        :close-on-click-modal="false"
        :close-on-press-escape="false"
        :show-close="false"
      >
        <div class="config-warning-content">
          <el-icon class="warning-icon" color="#f56c6c" size="24">
            <Warning />
          </el-icon>
          <p class="warning-message">{{ configWarningMessage }}</p>
        </div>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="handleConfigWarningAction('cancel')">{{ $t('@76872:取消') }}</el-button>
            <el-button type="info" @click="handleConfigWarningAction('open')">{{ $t('@76872:打开系统配置文件') }}</el-button>
            <el-button type="primary" @click="handleConfigWarningAction('continue')">{{ $t('@76872:继续编辑') }}</el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 简短描述模板设置 -->
      <TemplateManager
        v-model:visible="descriptionDialogVisible"
        type="description"
        :title="$t('@76872:简短描述模板设置')"
        :placeholder="$t('@76872:输入新模板内容')"
        :edit-placeholder="$t('@76872:编辑模板内容')"
        :empty-description="$t('@76872:暂无保存的模板')"
        @use-template="useTemplate"
      />


      <!-- 作用域设置弹窗 -->
      <TemplateManager
        v-model:visible="scopeDialogVisible"
        type="scope"
        :title="$t('@76872:作用域模板设置')"
        :placeholder="$t('@76872:输入新作用域模板')"
        :edit-placeholder="$t('@76872:编辑作用域模板内容')"
        :empty-description="$t('@76872:暂无保存的作用域')"
        @use-template="useScopeTemplate"
      />

      <!-- 默认提交信息设置弹窗 -->
      <TemplateManager
        v-model:visible="defaultMessageDialogVisible"
        type="message"
        :title="$t('@76872:默认提交信息设置')"
        :placeholder="$t('@76872:输入新模板内容')"
        :edit-placeholder="$t('@76872:编辑模板内容')"
        :empty-description="$t('@76872:暂无保存的模板')"
        :show-default-section="true"
        :show-help-text="true"
        @use-template="useMessageTemplate"
        @set-default="setDefaultFromTemplate"
      />
      
      <!-- Stash弹窗：创建储藏 -->
      <CommonDialog
        v-model="isStashDialogVisible"
        :title="$t('@76872:储藏更改 (Git Stash)')"
        size="medium"
        :close-on-click-modal="false"
        show-footer
        :confirm-text="$t('@76872:储藏')"
        :cancel-text="$t('@76872:取消')"
        :confirm-loading="gitStore.isSavingStash"
        custom-class="stash-dialog"
        @confirm="saveStash"
      >
        <div class="stash-dialog-content">
          <!-- 功能说明卡片 -->
          <div class="stash-info-card">
            <div class="info-icon">
              <el-icon><Box /></el-icon>
            </div>
            <div class="info-content">
              <h4>{{ $t('@76872:储藏工作区更改') }}</h4>
              <p>{{ $t('@76872:将当前工作区的更改临时保存，稍后可以重新应用到任何分支') }}</p>
            </div>
          </div>
          
          <el-form label-position="top" class="stash-form">
            <el-form-item :label="$t('@76872:储藏说明')">
              <el-input 
                v-model="stashMessage" 
                :placeholder="$t('@76872:为这次储藏添加描述信息（可选）')"
                clearable
                :rows="2"
                type="textarea"
                resize="none"
                maxlength="200"
                show-word-limit
              />
            </el-form-item>
            
            <!-- 选项配置 -->
            <div class="stash-options">
              <h5 class="options-title">
                <el-icon><Setting /></el-icon>
                {{ $t('@76872:储藏选项') }}
              </h5>
              
              <div class="option-item">
                <el-checkbox v-model="includeUntracked" size="large">
                  <span class="option-label">{{ $t('@76872:包含未跟踪文件') }}</span>
                </el-checkbox>
                <p class="option-desc">{{ $t('@76872:同时储藏新建但未添加到Git的文件 (--include-untracked)') }}</p>
              </div>

              <div class="option-item">
                <el-checkbox v-model="excludeLocked" :disabled="allChangesAreLocked" size="large">
                  <span class="option-label">{{ $t('@76872:排除锁定文件') }}</span>
                </el-checkbox>
                <p class="option-desc" :class="{ 'disabled': allChangesAreLocked }">
                  {{ $t('@76872:不储藏被锁定的文件，保持其当前状态') }}
                </p>
              </div>
            </div>
            
            <!-- 储藏预览信息 -->
            <div class="stash-preview" v-if="gitStore.status.staged.length > 0 || gitStore.status.unstaged.length > 0">
              <h5 class="preview-title">
                <el-icon><Document /></el-icon>
                {{ $t('@76872:将要储藏的文件') }}
              </h5>
              <div class="file-count-info">
                <el-tag type="success" v-if="gitStore.status.staged.length > 0">
                  {{ $t('@76872:已暂存: ') }}{{ gitStore.status.staged.length }} {{ $t('@76872:个文件') }}
                </el-tag>
                <el-tag type="warning" v-if="gitStore.status.unstaged.length > 0">
                  {{ $t('@76872:未暂存: ') }}{{ gitStore.status.unstaged.length }} {{ $t('@76872:个文件') }}
                </el-tag>
              </div>
            </div>
          </el-form>
        </div>
      </CommonDialog>
      
      <!-- 合并分支对话框 -->
      <el-dialog 
        :title="$t('@76872:合并分支')" 
        v-model="isMergeDialogVisible" 
        width="500px"
        :close-on-click-modal="false"
        class="merge-dialog"
      >
        <div class="merge-dialog-content">
          <p class="merge-intro">{{ $t('@76872:选择要合并到当前分支 (') }}{{ gitStore.currentBranch }}{{ $t('@76872:) 的分支:') }}</p>
          
          <el-form label-position="top">
            <el-form-item :label="$t('@76872:分支类型')">
              <el-radio-group v-model="branchTypeFilter" size="small">
                <el-radio-button label="all">{{ $t('@76872:所有分支') }}</el-radio-button>
                <el-radio-button label="local">{{ $t('@76872:本地分支') }}</el-radio-button>
                <el-radio-button label="remote">{{ $t('@76872:远程分支') }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item :label="$t('@76872:选择分支')">
              <el-select 
                v-model="selectedBranch" 
                :placeholder="$t('@76872:选择要合并的分支')" 
                style="width: 100%"
                filterable
              >
                <el-option 
                  v-for="branch in filteredBranches" 
                  :key="branch" 
                  :label="branch" 
                  :value="branch" 
                />
              </el-select>
            </el-form-item>
            
            <el-form-item :label="$t('@76872:合并选项')">
              <div class="merge-options">
                <el-checkbox v-model="mergeOptions.noFf">
                  <el-tooltip :content="$t('@76872:创建合并提交，即使可以使用快进合并')" placement="top">
                    <span>{{ $t('@76872:禁用快进合并 (--no-ff)') }}</span>
                  </el-tooltip>
                </el-checkbox>
                
                <el-checkbox v-model="mergeOptions.squash">
                  <el-tooltip :content="$t('@76872:将多个提交压缩为一个提交')" placement="top">
                    <span>{{ $t('@76872:压缩提交 (--squash)') }}</span>
                  </el-tooltip>
                </el-checkbox>
                
                <el-checkbox v-model="mergeOptions.noCommit">
                  <el-tooltip :content="$t('@76872:执行合并但不自动创建提交')" placement="top">
                    <span>{{ $t('@76872:不自动提交 (--no-commit)') }}</span>
                  </el-tooltip>
                </el-checkbox>
              </div>
            </el-form-item>
            
            <el-form-item :label="$t('@76872:合并提交信息 (可选)')" v-if="mergeOptions.noFf && !mergeOptions.noCommit">
              <el-input 
                v-model="mergeOptions.message" 
                type="textarea" 
                :rows="3" 
                :placeholder="$t('@76872:输入自定义合并提交信息')"
              />
            </el-form-item>
          </el-form>
        </div>
        
        <template #footer>
          <div class="dialog-footer">
            <el-button @click="isMergeDialogVisible = false">{{ $t('@76872:取消') }}</el-button>
            <el-button 
              type="primary" 
              @click="handleMergeBranch" 
              :loading="gitStore.isGitMerging"
              :disabled="!selectedBranch"
              class="merge-confirm-btn"
            >
              {{ $t('@76872:合并') }}
            </el-button>
          </div>
        </template>
      </el-dialog>
      
      <!-- Stash列表弹窗 -->
      <CommonDialog
        v-model="isStashListDialogVisible"
        :title="$t('@76872:储藏列表 (Git Stash)')"
        size="large"
        :show-footer="false"
        custom-class="stash-list-dialog"
      >
        <div class="stash-list-content">
          <!-- 头部统计信息 -->
          <div class="stash-header" v-if="!gitStore.isLoadingStashes">
            <div class="stash-stats">
              <div class="stat-item">
                <el-icon class="stat-icon"><Connection /></el-icon>
                <span class="stat-number">{{ gitStore.stashes.length }}</span>
                <span class="stat-label">{{ $t('@76872:个储藏') }}</span>
              </div>
            </div>
            <div class="stash-actions-header" v-if="gitStore.stashes.length > 0">
              <el-button
                type="danger"
                size="small"
                :icon="Delete"
                @click="confirmClearAllStashes"
                :loading="gitStore.isDroppingStash"
                class="clear-all-btn"
              >
                {{ $t('@76872:清空所有储藏') }}
              </el-button>
            </div>
          </div>

          <!-- 储藏列表 -->
          <div class="stash-list-container" v-loading="gitStore.isLoadingStashes">
            <div v-if="gitStore.stashes.length === 0 && !gitStore.isLoadingStashes" class="empty-state">
              <el-empty
                :description="$t('@76872:暂无储藏记录')"
                :image-size="120"
              >
                <template #image>
                  <el-icon class="empty-icon"><Connection /></el-icon>
                </template>
                <template #description>
                  <p class="empty-text">{{ $t('@76872:还没有任何储藏记录') }}</p>
                  <p class="empty-hint">{{ $t('@76872:使用 git stash 可以临时保存工作进度') }}</p>
                </template>
              </el-empty>
            </div>
            
            <div v-else class="stash-cards">
              <div 
                v-for="(stash, index) in gitStore.stashes" 
                :key="stash.id"
                class="stash-card"
                :class="{ 'stash-card-latest': index === 0 }"
              >
                <div class="stash-card-content">
                  <div class="stash-info">
                    <div class="stash-main-info">
                      <div class="stash-id-badge">
                        <el-icon class="badge-icon"><Connection /></el-icon>
                        <span class="stash-id-text">{{ stash.id }}</span>
                        <el-tag v-if="index === 0" size="small" type="success" class="latest-tag">{{ $t('@76872:最新') }}</el-tag>
                      </div>
                      <div class="stash-description">
                        <span class="description-text">{{ stash.description }}</span>
                      </div>
                    </div>
                  </div>
                  
                  <div class="stash-card-actions">
                    <el-button
                      size="small"
                      type="info"
                      :icon="Edit"
                      @click="viewStashDetail(stash)"
                      :loading="isLoadingStashDetail"
                      class="action-btn view-btn"
                    >
                      {{ $t('@76872:查看') }}
                    </el-button>
                    <el-button
                      size="small"
                      type="success"
                      :icon="Download"
                      @click="applyStash(stash.id, false)"
                      :loading="gitStore.isApplyingStash"
                      class="action-btn apply-btn"
                    >
                      {{ $t('@76872:应用') }}
                    </el-button>
                    <el-button
                      size="small"
                      type="primary"
                      :icon="Check"
                      @click="applyStash(stash.id, true)"
                      :loading="gitStore.isApplyingStash"
                      class="action-btn apply-pop-btn"
                    >
                      {{ $t('@76872:应用并删除') }}
                    </el-button>
                    <el-button
                      size="small"
                      type="danger"
                      :icon="Delete"
                      @click="confirmDropStash(stash.id)"
                      :loading="gitStore.isDroppingStash"
                      class="action-btn delete-btn"
                    >
                      {{ $t('@76872:删除') }}
                    </el-button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </CommonDialog>
      
      <!-- Stash详情弹窗 -->
      <CommonDialog
        v-model="stashDetailVisible"
        :title="$t('@76872:储藏详情')"
        custom-class="stash-detail-dialog"
        size="extra-large"
        type="flex"
        heightMode="fixed"
        :close-on-click-modal="false"
      >
        <div class="stash-content">
          <!-- 储藏信息横向布局 -->
          <div class="stash-info-row" v-if="selectedStash">
            <div class="stash-id">
              <span class="info-label">Stash ID:</span>
              <code class="stash-id-value">{{ selectedStash.id }}</code>
            </div>
            <div class="stash-description">
              <span class="info-label">{{ $t('@76872:描述:') }}</span>
              <span class="stash-description-value">{{ selectedStash.description }}</span>
            </div>
          </div>

          <!-- 文件差异查看器 -->
          <div class="stash-main-content">
            <FileDiffViewer
              :files="stashFilesForViewer"
              :diffContent="stashDiff"
              :selectedFile="selectedStashFile"
              context="stash-detail"
              :emptyText="$t('@76872:该stash没有变更文件')"
              @file-select="handleStashFileSelect"
              @open-file="handleOpenFile"
              @open-with-vscode="handleOpenWithVSCode"
            />
          </div>
        </div>
      </CommonDialog>
      
      <!-- 状态更新指示器 -->
      <transition name="el-fade-in-linear">
        <div v-if="isUpdatingStatus" class="status-updating-indicator">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ $t('@76872:更新状态中...') }}</span>
        </div>
      </transition>

      <!-- 全局Loading组件 -->
      <GlobalLoading 
        :visible="loadingState.visible"
        :text="loadingState.text"
        :show-progress="loadingState.showProgress"
        :progress="loadingState.progress"
      />
        
      <!-- 成功提示组件 -->
      <SuccessModal 
        :visible="successState.visible"
        :text="successState.text"
        :description="successState.description"
      />

      <!-- 提交设置弹窗 -->
      <CommonDialog
        v-model="commitSettingsDialogVisible"
        :title="$t('@76872:提交设置')"
        size="medium"
        :show-footer="false"
        custom-class="commit-settings-dialog"
      >
        <div class="commit-settings-content">
          

          <!-- Git钩子开关 -->
          <OptionSwitchCard
            v-model="skipHooks"
            :title="$t('@76872:跳过钩子检查')"
            :tooltip="$t('@76872:添加 --no-verify 参数')"
            active-color="#f56c6c"
            icon-class="warning"
          >
            <template #icon>
              <el-icon><Warning /></el-icon>
            </template>
          </OptionSwitchCard>

          <!-- 回车自动提交开关 -->
          <OptionSwitchCard
            v-model="autoQuickPushOnEnter"
            :title="$t('@76872:回车自动提交')"
            :tooltip="$t('@76872:输入提交信息后按回车直接执行一键推送')"
            active-color="#67c23a"
            icon-class="success"
          >
            <template #icon>
              <el-icon><Check /></el-icon>
            </template>
          </OptionSwitchCard>

          <!-- Push完成后自动关闭弹窗 -->
          <OptionSwitchCard
            v-model="configStore.autoClosePushModal"
            :title="$t('@76872:Push完成自动关闭')"
            :tooltip="$t('@76872:推送成功后自动关闭进度弹窗')"
            active-color="#409eff"
            icon-class="info"
          >
            <template #icon>
              <el-icon><Check /></el-icon>
            </template>
          </OptionSwitchCard>

          <!-- 自动设置默认提交信息 -->
          <OptionSwitchCard
            v-model="configStore.autoSetDefaultMessage"
            :title="$t('@76872:自动填充默认提交信息')"
            :tooltip="$t('@76872:打开页面或提交完成后自动填充默认提交信息')"
            active-color="#67c23a"
            icon-class="success"
          >
            <template #icon>
              <el-icon><Edit /></el-icon>
            </template>
          </OptionSwitchCard>
        </div>
      </CommonDialog>
</template>

<style scoped lang="scss">
.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  
  h2 {
    margin: 0;
  }
}


.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

// .header-actions :deep(.button-grid) {
//   gap: 8px;
// }

/* 头部按钮样式优化 */
.header-actions :deep(.el-button) {
  border-radius: 6px;
  font-weight: 500;
  transition: all 0.3s ease;
  padding: 6px 8px;
  font-size: 12px;
}

.header-actions :deep(.el-button:hover) {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
}

.header-actions :deep(.el-button--primary) {
  background: #409eff;
  border: none;
  color: white;
}

.header-actions :deep(.el-button--success) {
  background: #67c23a;
  border: none;
  color: white;
}

.header-actions :deep(.el-button--warning) {
  background: #e6a23c;
  border: none;
  color: white;
}

/* 头部按钮禁用状态样式优化 */
.header-actions :deep(.el-button:disabled) {
  opacity: 0.4 !important;
}

.header-actions :deep(.el-button--primary:disabled) {
  background-color: #a0cfff !important;
  border-color: #a0cfff !important;
  opacity: 0.5 !important;
}

.header-actions :deep(.el-button--success:disabled) {
  background-color: #b3e19d !important;
  border-color: #b3e19d !important;
  opacity: 0.5 !important;
}

.header-actions :deep(.el-button--warning:disabled) {
  background-color: #f3d19e !important;
  border-color: #f3d19e !important;
  opacity: 0.5 !important;
}

.card-content {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

.layout-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}

.commit-section {
  flex: 1;
  width: 100%;
  min-width: 0; /* 防止子元素撑开 */
}

.actions-section {
  padding: 0;
}

.actions-section h3 {
  margin-top: 0;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-card);
  font-size: 16px;
  
  font-weight: 500;
}

.operations-wrapper {
  display: flex;
  gap: 8px;
}

.action-groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-group {
  background-color: var(--bg-component-area);
  border-radius: 6px;
  padding: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s ease;
  flex: 1;
}

.action-group:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.group-title {
  font-size: 13px;
  font-weight: bold;
  margin-bottom: 8px;
  color: var(--text-primary);
  text-align: left;
  display: block;
  position: relative;
  padding-left: 6px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding-bottom: 6px;
}

.group-buttons {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0;
}

.action-button {
  font-size: 14px;
  font-weight: 500;
  // flex: 1;
  // padding: 0 10px;
}

.action-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.action-button:active {
  transform: translateY(0);
}

/* 储藏详情弹窗样式 */
.stash-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 8px;
}

.stash-info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--border-component);
  flex-shrink: 0; /* 不被压缩 */
}

.stash-id,
.stash-description {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.stash-id-value {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata, "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace;
  font-size: 12px;
  background-color: var(--border-component);
  color: var(--color-text);
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid var(--border-component);
}

.stash-description {
  flex: 1; /* 占据剩余空间 */
}

.stash-description-value {
  font-size: 14px;
  
  font-weight: 400;
  word-break: break-all;
}

.stash-main-content {
  flex: 1;
  min-height: 0; /* 关键：允许flex子元素缩小 */
  display: flex;
  flex-direction: column;
}

.command-text {
  display: none;
}

.command-text-long {
  display: none;
}

.standard-commit-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}

.standard-commit-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.type-scope-container {
  display: flex;
  gap: 8px;
  width: 100%;
  align-items: stretch;
}

.type-select {
  width: 180px; 
}

.scope-wrapper {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 130px;
}

.commit-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.description-container {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  background: linear-gradient(135deg, #f8faff 0%, #eef4ff 100%);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
  transition: all 0.3s ease;
}

/* 行内模式（与类型/作用域同一行） */
.description-container.description-inline {
  flex: 1;
  min-width: 0;
  background: transparent;
  box-shadow: none;
}
.description-container.description-inline:hover {
  box-shadow: none;
}

.description-container:hover {
  // border-color: #409eff;
  box-shadow: 0 4px 16px rgba(64, 158, 255, 0.2);
}

/* 简短描述输入框样式 */
:deep(.description-input) {
  flex-grow: 1;
  
  .el-input__wrapper {
    border-radius: 8px;
    background: var(--bg-container);
    border: 2px solid #409eff;
    box-shadow: 0 2px 4px rgba(64, 158, 255, 0.1);
    transition: all 0.3s ease;
    height: 40px; /* 统一高度，与其它输入保持一致 */
  }
  
  .el-input__wrapper:hover {
    border-color: #66b1ff;
    box-shadow: 0 4px 8px rgba(64, 158, 255, 0.2);
  }
  
  .el-input__wrapper.is-focus {
    border-color: #409eff;
    box-shadow: 0 0 0 4px rgba(64, 158, 255, 0.2);
  }
  
  .el-input__inner {
    font-size: 15px;
    font-weight: 500;
    height: 34px;
  }
  
  .el-input__inner::placeholder {
    color: #a8abb2;
    font-weight: normal;
  }
}

/* 提交类型选择框样式 */
:deep(.type-select) {
  .el-select__wrapper {
    border-radius: 8px;
    background: var(--bg-container);
    border: 2px solid #f56c6c;
    box-shadow: 0 2px 4px rgba(245, 108, 108, 0.1);
    transition: all 0.3s ease;
    height: 40px; /* 统一高度 */
  }
  
  .el-select__wrapper:hover {
    border-color: #f78989;
    box-shadow: 0 4px 8px rgba(245, 108, 108, 0.2);
  }
  
  .el-select__wrapper.is-focus {
    border-color: #f56c6c;
    box-shadow: 0 0 0 4px rgba(245, 108, 108, 0.2);
  }
  
  .el-select__inner {
    font-size: 14px;
    font-weight: 500;
    
  }
  
  .el-select__inner::placeholder {
    color: #a8abb2;
    font-weight: normal;
  }
}

/* 作用域输入框样式 */
:deep(.scope-input) {
  flex-grow: 1;
  
  .el-input__wrapper {
    border-radius: 8px;
    background: var(--bg-container);
    border: 2px solid #67c23a;
    box-shadow: 0 2px 4px rgba(103, 194, 58, 0.1);
    transition: all 0.3s ease;
    height: 40px; /* 统一高度 */
  }
  
  .el-input__wrapper:hover {
    border-color: #85ce61;
    box-shadow: 0 4px 8px rgba(103, 194, 58, 0.2);
  }
  
  .el-input__wrapper.is-focus {
    border-color: #67c23a;
    box-shadow: 0 0 0 4px rgba(103, 194, 58, 0.2);
  }
  
  .el-input__inner {
    font-size: 14px;
    font-weight: 500;
  }
  
  .el-input__inner::placeholder {
    color: #a8abb2;
    font-weight: normal;
  }
}

/* 提交信息输入框样式 */
:deep(.commit-message-input) {
  /* 添加背景和边框，让容器更明显 */
  background: linear-gradient(135deg, var(--bg-container-hover) 0%, #fff2e6 100%);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(230, 162, 60, 0.1);
  transition: all 0.3s ease;
  
  .el-textarea__inner {
    border-radius: 8px;
    background: var(--bg-container);
    border: 2px solid #e6a23c;
    box-shadow: 0 2px 4px rgba(230, 162, 60, 0.1);
    font-size: 15px;
    font-weight: 500;
    transition: all 0.3s ease;
  }
  
  .el-textarea__inner:hover {
    border-color: #ebb563;
    box-shadow: 0 4px 8px rgba(230, 162, 60, 0.2);
  }
  
  .el-textarea__inner:focus {
    border-color: #e6a23c;
    box-shadow: 0 0 0 4px rgba(230, 162, 60, 0.2);
    outline: none;
  }
  
  .el-textarea__inner::placeholder {
    color: #a8abb2;
    font-weight: normal;
  }
}

:deep(.commit-message-input):hover {
  border-color: #e6a23c;
  box-shadow: 0 4px 16px rgba(230, 162, 60, 0.2);
}


.settings-button {
  flex-shrink: 0;
}




/* 提交选项卡片样式 */
.commit-options {
  display: flex;
  flex-direction: row;
  gap: 8px;
  margin-bottom: 8px;
}

.option-card {
  background: linear-gradient(135deg, var(--color-white) 0%, #f8f9fa 100%);
  border: 1px solid var(--border-component);
  border-radius: 8px;
  padding: 8px;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  flex: 1;
  min-width: 0;
}

.option-card:hover {
  border-color: #409eff;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
  transform: translateY(-1px);
}

.option-header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  text-align: left;
}

.option-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #409eff;
  color: white;
  font-size: 10px;
  flex-shrink: 0;
}

.option-icon.warning {
  background: #f56c6c;
}

.option-icon.success {
  background: #67c23a;
}

.option-info {
  flex: 1;
  min-width: 0;
}

.option-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.option-desc {
  margin: 0;
  font-size: 10px;
  color: #909399;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.option-switch {
  flex-shrink: 0;
}

/* 开关组件自定义样式 */
.option-switch :deep(.el-switch__label) {
  font-size: 12px;
  font-weight: 500;
}

.option-switch :deep(.el-switch__label.is-active) {
  color: #409eff;
}


/* 响应式设计 */
@media (max-width: 768px) {
  .commit-options {
    flex-direction: column;
    gap: 6px;
  }
  
  .option-card {
    padding: 8px;
  }
  
  .option-header {
    flex-direction: row;
    gap: 8px;
    text-align: left;
  }
  
  .option-icon {
    width: 20px;
    height: 20px;
    font-size: 10px;
  }
  
  .option-title {
    font-size: 11px;
  }
  
  .option-desc {
    font-size: 9px;
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
}

.code-command {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: 'Courier New', Courier, monospace;
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre;
  font-size: 14px;
}

  .layout-container {
    flex-direction: row;
  }

  .commit-section {
    flex: 3;
  }

  .actions-section {
    width: 320px;
  }
  
  .operations-wrapper {
    flex-direction: column;
  }

.git-config-warning {
  width: 100%;
}

.config-command {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: 'Courier New', Courier, monospace;
  padding: 8px;
  border-radius:
  4px;
  margin-top: 8px;
  white-space: pre;
}

/* 推送时的动画效果 */
@keyframes pushing-pulse {
  0% { box-shadow: 0 0 0 0 rgba(103, 194, 58, 0.4); }
  70% { box-shadow: 0 0 0 15px rgba(103, 194, 58, 0); }
  100% { box-shadow: 0 0 0 0 rgba(103, 194, 58, 0); }
}

@keyframes pushing-border {
  0% { border-color: #67c23a; }
  50% { border-color: #85ce61; }
  100% { border-color: #67c23a; }
}

.card.is-pushing {
  animation: pushing-border 1.5s infinite ease-in-out;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
}



/* 一键推送所有按钮动画 */
@keyframes one-click-push-glow {
  0% { box-shadow: 0 0 5px rgba(103, 194, 58, 0.5); }
  50% { box-shadow: 0 0 20px rgba(103, 194, 58, 0.8); }
  100% { box-shadow: 0 0 5px rgba(103, 194, 58, 0.5); }
}

.action-button.one-click-push {
  position: relative;
  overflow: hidden;
}

.action-button.one-click-push.is-loading, 
.action-button.one-click-push.is-loading:hover {
  animation: one-click-push-glow 1.5s infinite;
  background-color: #67c23a !important;
  border-color: #67c23a !important;
}

/* 推送成功动画已移除，使用新的SuccessModal组件 */

.reset-button {
  background-color: #909399;
  border-color: #909399;
}

.reset-button:hover {
  background-color: #a6a9ad;
  border-color: #a6a9ad;
}

/* 状态更新指示器样式 */
.status-updating-indicator {
  position: fixed;
  top: 20px;
  right: 20px;
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid #409eff;
  border-radius: 8px;
  padding: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.2);
  z-index: 2000;
  backdrop-filter: blur(4px);
}

.status-updating-indicator span {
  font-size: 14px;
  color: #409eff;
  font-weight: 500;
}

.status-updating-indicator .el-icon {
  font-size: 16px;
  color: #409eff;
}

/* 全局loading自定义样式 */
.git-push-loading {
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.95) 0%, rgba(103, 194, 58, 0.95) 100%) !important;
  backdrop-filter: blur(15px) !important;
}

.git-push-loading .el-loading-mask {
  background: transparent !important;
}

.git-push-loading .el-loading-spinner {
  margin-top: -50px !important;
  position: relative !important;
}

.git-push-loading .el-loading-spinner svg {
  width: 100px !important;
  height: 100px !important;
}

.git-push-loading .el-loading-spinner .circular {
  width: 100px !important;
  height: 100px !important;
  animation: git-push-rotate 2s linear infinite !important;
}

.git-push-loading .el-loading-spinner .path {
  stroke: #ffffff !important;
  stroke-width: 4 !important;
  stroke-linecap: round !important;
  filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.8)) !important;
}

.git-push-loading .el-loading-text {
  font-size: 20px !important;
  font-weight: 700 !important;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.5) !important;
  margin-top: 30px !important;
  letter-spacing: 1px !important;
  text-transform: uppercase !important;
}

/* 添加呼吸光环效果 */
.git-push-loading .el-loading-spinner::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 120px;
  height: 120px;
  margin: -60px 0 0 -60px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, 0.2) 0%, transparent 70%);
  animation: git-push-pulse 3s ease-in-out infinite;
  z-index: -1;
}

/* 添加旋转光环 */
.git-push-loading .el-loading-spinner::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 140px;
  height: 140px;
  margin: -70px 0 0 -70px;
  border: 2px solid transparent;
  border-top: 2px solid rgba(255, 255, 255, 0.3);
  border-right: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  animation: git-push-rotate 4s linear infinite reverse;
  z-index: -1;
}

/* 自定义loading动画 */
@keyframes git-push-rotate {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}

@keyframes git-push-pulse {
  0% {
    transform: scale(0.8);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.2);
    opacity: 0.3;
  }
  100% {
    transform: scale(0.8);
    opacity: 0.8;
  }
}

.left-actions {
  flex: 3;
  display: flex;
  align-items: center;
}

.right-actions {
  flex: 2;
  display: flex;
  align-items: center;
  justify-content: center;
}

.one-push-button {
  height: 100%;
  width: 100%;
  padding: 8px;
  background: linear-gradient(135deg, #4169e1, #5e81f4);
  border: none;
  border-radius: 8px;
  box-shadow: 0 4px 10px rgba(65, 105, 225, 0.25);
  transition: all 0.3s ease;
  position: relative;
  z-index: 1000;
}

.one-push-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 12px rgba(65, 105, 225, 0.35);
  background: linear-gradient(135deg, #3a5ecc, #4b6edf);
}

.one-push-button:active {
  transform: translateY(0);
  box-shadow: 0 2px 6px rgba(65, 105, 225, 0.2);
}

.one-push-content {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
}

.one-push-icon {
  font-size: 24px;
  margin-right: 4px;
}

.one-push-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.one-push-title {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.2;
}

.one-push-desc {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}

.pushing-text {
  font-size: 20px;
  font-weight: bold;
  text-align: center;
}

.pushing-spinner {
  margin-bottom: 8px;
}

.circular {
  height: 64px;
  width: 64px;
  animation: pushing-rotate 2s linear infinite;
}

.path {
  stroke: white;
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 90, 150;
  stroke-dashoffset: 0;
  animation: pushing-dash 1.5s ease-in-out infinite;
}

@keyframes pushing-rotate {
  100% {
    transform: rotate(360deg);
  }
}

@keyframes pushing-dash {
  0% {
    stroke-dasharray: 1, 150;
    stroke-dashoffset: 0;
  }
  50% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -35;
  }
  100% {
    stroke-dasharray: 90, 150;
    stroke-dashoffset: -124;
  }
}


.advanced-options-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 7px 0 6px;
  background-color: var(--bg-panel);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.3s ease;
  user-select: none;
  font-size: 14px;
}

.advanced-options-toggle:hover {
  background-color: var(--border-card);
  color: #409EFF;
}

.toggle-icon {
  margin-left: 8px;
  transition: transform 0.3s ease;
  font-size: 12px;
}

.toggle-icon.is-active {
  transform: rotate(180deg);
}

.advanced-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: fade-in 0.3s ease-in-out;
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 合并分支对话框样式 */
.merge-dialog-content {
  padding: 0 10px;
}

.merge-intro {
  margin-bottom: 8px;
  color: var(--text-secondary);
}

.merge-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.merge-confirm-btn {
  margin-left: 10px;
}

.merge-button {
  background-color: #409EFF;
  border-color: #409EFF;
}

/* 分支操作组样式 */
.branch-group {
  border-top: none;
}


/* 禁用复选框下的提示文本换行 */
:deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.4;
}

/* stash相关样式 */
.stash-list-content {
  padding: 0;
  min-height: 400px;
}

/* Stash列表弹窗样式 */
:deep(.stash-list-dialog) {
  .common-dialog__header {
    background: #409eff;
    color: white;
    padding: 20px 24px;
    border-radius: 8px 8px 0 0;
    margin: 0;
  }
  
  .common-dialog__title {
    font-size: 18px;
    font-weight: 600;
    color: white;
  }
  
  .common-dialog__close {
    color: white;
    font-size: 18px;
    
    &:hover {
      color: var(--border-card);
    }
  }
}

/* 头部统计信息 */
.stash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  padding: 8px;
  background: linear-gradient(135deg, var(--color-white) 0%, #f8f9fa 100%);
  border-radius: 8px;
  border: 1px solid var(--border-component);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.stash-stats {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  background: #409eff;
  border-radius: 8px;
  color: white;
}

.stat-icon {
  font-size: 16px;
}

.stat-number {
  font-size: 18px;
  font-weight: 600;
}

.stat-label {
  font-size: 14px;
  opacity: 0.9;
}

.stash-actions-header {
  display: flex;
  gap: 8px;
}

.clear-all-btn {
  border-radius: 8px;
  padding: 2px 8px;
  font-weight: 500;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
  }
}

/* 储藏列表容器 */
.stash-list-container {
  min-height: 300px;
}

/* 空状态样式 */
.empty-state {
  padding: 40px 20px;
  text-align: center;
}

.empty-icon {
  font-size: 64px;
  color: #c0c4cc;
  margin-bottom: 16px;
}

.empty-text {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
  font-weight: 500;
}

.empty-hint {
  font-size: 14px;
  color: #909399;
  margin: 0;
}

/* 储藏卡片列表 */
.stash-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stash-card {
  background: var(--bg-container);
  border-radius: 8px;
  border: 1px solid var(--border-component);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  transition: all 0.3s ease;
  overflow: hidden;
  
  &:hover {
    transform: translateY(-1px);
    border-color: #409eff;
  }
}

.stash-card-latest {
  border: 2px solid #67c23a;
  box-shadow: 0 2px 12px rgba(103, 194, 58, 0.15);
  
  &:hover {
    border-color: #67c23a;
    box-shadow: 0 4px 16px rgba(103, 194, 58, 0.25);
  }
}

.stash-card-content {
  padding: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.stash-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.stash-main-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stash-id-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.badge-icon {
  font-size: 14px;
  color: #909399;
}

.stash-id-text {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  padding: 3px 8px;
  border-radius: 4px;
  font-weight: 500;
  letter-spacing: 0.5px;
  border: 1px solid var(--border-card);
}

.latest-tag {
  margin-left: 4px;
}

  .stash-description {
    flex: 1;
    min-width: 0;
  }

 .description-text {
   margin: 0;
   font-size: 14px;
   
   line-height: 1.4;
   word-break: break-word;
   font-weight: 500;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
 }

 /* 储藏列表右侧按钮：默认隐藏，hover时显示 */
 .stash-card-actions {
   display: none;
   gap: 6px;
   flex-shrink: 0;
   align-items: center;
 }

 .stash-card:hover .stash-card-actions {
   display: flex;
 }

 .action-btn {
   border-radius: 6px;
   font-weight: 500;
   transition: all 0.3s ease;
   min-width: 60px;
   padding: 6px 12px;
   font-size: 12px;
   
   &:hover {
     transform: translateY(-1px);
   }
 }

.view-btn:hover {
  box-shadow: 0 4px 12px rgba(144, 147, 153, 0.3);
}
.apply-btn:hover {
  box-shadow: 0 4px 12px rgba(103, 194, 58, 0.3);
}

.apply-pop-btn:hover {
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
}

.delete-btn:hover {
  box-shadow: 0 4px 12px rgba(245, 108, 108, 0.3);
}

.stash-dialog-content p {
  color: var(--text-secondary);
}

/* 重置操作组样式 */
.reset-group {
  border-top: none;
}

/* 添加Git工具按钮样式 */
.card-header {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-card);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.header-switches {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  justify-content: center;
}

.git-tools-button {
  transition: transform 0.3s;
}

.git-tools-button:hover {
  transform: rotate(90deg);
}

/* 布局调整，让提交区占据全部宽度 */
.layout-container {
  display: flex;
  flex-direction: column;
  gap: 15px;
  height: 100%;
}

.commit-section {
  flex: 1;
  width: 100%;
  min-width: 0; /* 防止子元素撑开 */
}

/* Git操作抽屉样式 */
:deep(.git-operations-drawer) {
  .el-drawer__header {
    padding: 12px 16px;
    font-size: 16px;
    font-weight: 500;
  }
  
  .el-drawer__body {
    padding: 10px;
    overflow-y: auto;
  }
}

.actions-section {
  padding: 0;
}

.center-button-container {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
  position: relative;
}

.button-divider {
  height: 1px;
  background: linear-gradient(to right, rgba(220, 223, 230, 0), rgba(220, 223, 230, 1), rgba(220, 223, 230, 0));
  flex: 1;
  margin: 0 15px;
}

.one-push-button {
  padding: 0 25px;
  min-width: 160px;
  height: 40px;
  font-weight: 500;
  border-radius: 20px;
  box-shadow: 0 2px 6px rgba(65, 105, 225, 0.3);
  transition: all 0.3s;
  position: relative;
  z-index: 2;
}

.one-push-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 8px rgba(65, 105, 225, 0.4);
}

.action-separator {
  position: relative;
  text-align: center;
  margin: 12px 0;
  height: 20px;
}

.separator-text {
  background-color: var(--bg-panel);
  padding: 0 10px;
  font-size: 12px;
  color: #909399;
  position: relative;
  z-index: 1;
}

.action-separator::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 1px;
  background-color: var(--border-card);
  z-index: 0;
}

.one-push-container {
  display: flex;
  justify-content: center;
}

.one-push-button {
  width: 100%;
  max-width: 300px;
  height: auto;
  padding: 10px 20px;
  background: linear-gradient(135deg, #4169e1, #5e81f4);
  border: none;
  border-radius: 8px;
  box-shadow: 0 4px 10px rgba(65, 105, 225, 0.25);
  transition: all 0.3s ease;
  position: relative;
  z-index: 1000;
}

.one-push-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 12px rgba(65, 105, 225, 0.35);
  background: linear-gradient(135deg, #3a5ecc, #4b6edf);
}

.one-push-button:active {
  transform: translateY(0);
  box-shadow: 0 2px 6px rgba(65, 105, 225, 0.2);
}

.one-push-content {
  display: flex;
  align-items: center;
  justify-content: center;
}

.one-push-icon {
  font-size: 20px;
  margin-right: 4px;
}

.one-push-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  text-align: left;
}

.one-push-title {
  font-size: 16px;
  font-weight: 500;
  line-height: 1.2;
}

.one-push-desc {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 2px;
}

.button-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.button-row .el-button {
  flex: 1;
  min-width: 100px;
}

/* 移除之前的样式 */
.center-button-container,
.button-divider {
  display: none;
}
</style>

<!-- 添加全局样式 -->
<style lang="scss">
/* 移除自定义tooltip样式，使用Element Plus默认样式 */

/* Stash详情弹窗样式 */
.stash-detail-dialog .el-dialog__body {
  padding: 12px;
  height: calc(100vh - 200px); // 给对话框体设置明确高度
  display: flex;
  flex-direction: column;
}

.stash-detail-content {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.stash-header {
  padding-bottom: 15px;
  border-bottom: 1px solid var(--border-card);
}

.stash-info h3 {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
  color: #409eff;
  
}

.stash-description {
  margin: 0;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.5;
}

.stash-main-content {
  flex: 1;
  min-height: 0;
  height: 100%; // 确保容器高度填充满
}

.stash-files-panel {
  width: 300px;
  flex-shrink: 0;
  background-color: #fafafa;
  border-radius: 8px;
  border: 1px solid var(--border-card);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.stash-diff-panel {
  flex: 1;
  background-color: #fafafa;
  border-radius: 8px;
  border: 1px solid var(--border-card);
  overflow: hidden;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.panel-header {
  padding: 12px 16px;
  background-color: var(--bg-panel);
  border-bottom: 1px solid var(--border-card);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  
}

.selected-file {
  font-size: 12px;
  color: #909399;
  
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.files-list {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}



.diff-content {
  flex: 1;
  min-height: 0;
}

.diff-text {
  font-size: 12px;
  line-height: 1.6;
  
  margin: 0;
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-all;
  border: none;
  outline: none;
  /* 确保高亮样式能正确应用 */
  overflow-wrap: break-word;
}




.template-dialog .el-input__inner,
.message-template-dialog .el-input__inner,
.merge-dialog .el-input__inner {
  height: 40px;
  line-height: 40px;
}

.template-dialog .el-button,
.message-template-dialog .el-button {
  border-radius: 4px;
  font-weight: 500;
}

.template-dialog .el-card,
.message-template-dialog .el-card {
  border-radius: 4px;
  overflow: hidden;
}

.template-dialog .el-card__body,
.message-template-dialog .el-card__body {
  padding: 12px 15px;
}

.template-dialog .el-empty__image,
.message-template-dialog .el-empty__image {
  width: 80px;
  height: 80px;
}

/* 储藏列表 操作按钮间距 (保留兼容性) */
.stash-action-buttons {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

/* 配置JSON编辑弹窗样式 */
.config-editor-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
}

.editor-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-icon {
  font-size: 16px;
  color: #409eff;
}

.info-text {
  font-size: 14px;
  font-weight: 500;
  
}

.editor-tips {
  display: flex;
  gap: 8px;
}

.json-editor-wrapper {
  flex: 1;
  min-height: 0;
}

.json-editor {
  height: 100%;
  .el-textarea__inner {
    height: 100%;
    border-radius: 8px;
    border: 2px solid var(--border-card);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.6;
    background: #fafafa;
    color: #2c3e50;
    resize: none;
    transition: all 0.3s ease;
    
    &:hover {
      border-color: #c0c4cc;
    }
    
    &:focus {
      border-color: #409eff;
      box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
      background: var(--bg-container);
      outline: none;
    }
    
    &::placeholder {
      color: #a8abb2;
      font-style: italic;
    }
  }
}

.editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid var(--border-component);
}

.footer-left {
  display: flex;
  gap: 8px;
}

.system-config-btn {
  border-radius: 6px;
  font-weight: 500;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(144, 147, 153, 0.3);
  }
}

.save-btn {
  border-radius: 6px;
  font-weight: 500;
  min-width: 100px;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
  }
}

/* 配置文件格式警告弹窗样式 */
.config-warning-content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 16px 0;
}

.warning-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.warning-message {
  flex: 1;
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-line;
}

/* 警告弹窗按钮区域 */
.config-warning-content + .el-dialog__footer .dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 储藏弹窗样式优化 */
.stash-dialog-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stash-info-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border: 1px solid #bae6fd;
  border-radius: 12px;
  position: relative;
  overflow: hidden;
}

.stash-info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #0ea5e9 0%, #0284c7 100%);
}

.stash-info-card .info-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
  border-radius: 10px;
  color: white;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.stash-info-card .info-content {
  flex: 1;
}

.stash-info-card .info-content h4 {
  margin: 0 0 6px 0;
  font-size: 16px;
  font-weight: 600;
  color: #0c4a6e;
  line-height: 1.2;
}

.stash-info-card .info-content p {
  margin: 0;
  font-size: 14px;
  color: #075985;
  line-height: 1.4;
}

.stash-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.stash-form .el-form-item {
  margin-bottom: 0;
}

.stash-form .el-form-item__label {
  font-weight: 600;
  color: var(--color-text-title);
  font-size: 14px;
  margin-bottom: 8px;
}

.stash-form .el-textarea {
  .el-textarea__inner {
    border-radius: 8px;
    border: 2px solid #e5e7eb;
    transition: all 0.3s ease;
    font-size: 14px;
    line-height: 1.5;
    
    &:hover {
      border-color: #d1d5db;
    }
    
    &:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
  }
}

.stash-options {
  padding: 8px;
  border-radius: 12px;
}

.options-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-title);
}

.options-title .el-icon {
  color: #6b7280;
  font-size: 16px;
}

.option-item {
  margin-bottom: 8px;
  
  &:last-child {
    margin-bottom: 0;
  }
}

.option-item .el-checkbox {
  margin-bottom: 8px;
}

.option-label {
  font-weight: 500;
  color: var(--color-text-title);
  font-size: 14px;
}

.option-desc {
  margin: 0;
  font-size: 13px;
  color: #6b7280;
  line-height: 1.4;
  padding-left: 24px;
  
  &.disabled {
    color: #9ca3af;
  }
}

.stash-preview {
  padding: 8px;
  background: linear-gradient(135deg, #fefce8 0%, #fef3c7 100%);
  border: 1px solid #fbbf24;
  border-radius: 12px;
  position: relative;
}

.stash-preview::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, #f59e0b 0%, #d97706 100%);
  border-radius: 12px 12px 0 0;
}

.preview-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #92400e;
}

.preview-title .el-icon {
  color: #d97706;
  font-size: 16px;
}

.file-count-info {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.file-count-info .el-tag {
  border-radius: 6px;
  padding: 4px 8px;
}

/* 储藏弹窗的CommonDialog样式定制 */
:deep(.stash-dialog) {
  .common-dialog__footer {
    .el-button {
      border-radius: 8px;
      font-weight: 500;
      padding: 10px 20px;
      transition: all 0.3s ease;
      
      &:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }
    }
    
    .el-button--primary {
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      border: none;
      
      &:hover {
        background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      }
    }
  }
}

/* 提交设置弹窗样式 */
.commit-settings-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 0;
}
</style>
