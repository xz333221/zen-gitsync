<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Edit, Check, Upload, RefreshRight, Delete, Position, Download, Connection, ArrowDown, Share, Menu } from "@element-plus/icons-vue";
import { useGitStore } from "../stores/gitStore";
import { useConfigStore } from "../stores/configStore";

const gitStore = useGitStore();
const configStore = useConfigStore();
const commitMessage = ref("");
const showPushSuccess = ref(false);
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

// 提交模板相关变量
const descriptionTemplates = ref<string[]>([]);
// 添加对话框可见性变量
const descriptionDialogVisible = ref(false);
const newTemplateName = ref("");
// 添加模板编辑相关变量
const isEditingDescription = ref(false);
const originalDescriptionTemplate = ref("");
const editingDescriptionIndex = ref(-1);

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
const newScopeTemplate = ref("");
// 添加作用域模板编辑相关变量
const isEditingScope = ref(false);
const originalScopeTemplate = ref("");
const editingScopeIndex = ref(-1);

// 默认提交信息设置相关变量
const defaultMessageDialogVisible = ref(false);
const newDefaultMessage = ref("");

// 跳过钩子
const skipHooks = ref(false);

// 添加控制正文和页脚显示的状态变量
const showAdvancedFields = ref(false);

// 提交类型选项
const commitTypeOptions = [
  { value: "feat", label: "feat: 新功能" },
  { value: "fix", label: "fix: 修复bug" },
  { value: "docs", label: "docs: 文档修改" },
  { value: "style", label: "style: 样式修改" },
  { value: "refactor", label: "refactor: 代码重构" },
  { value: "test", label: "test: 测试代码" },
  { value: "chore", label: "chore: 构建/工具修改" },
];

// 添加stash相关的状态
const isStashDialogVisible = ref(false);
const isStashListDialogVisible = ref(false);
const stashMessage = ref('');
const includeUntracked = ref(false);
// 新增：排除锁定文件选项（默认勾选）
const excludeLocked = ref(true);

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
  includeUntracked.value = false;
  excludeLocked.value = true;
  isStashDialogVisible.value = true;
}

// 打开配置编辑器
function openConfigEditor() {
  try {
    const cfg = configStore.config;
    // 使用当前配置填充编辑器
    configEditorText.value = JSON.stringify(cfg, null, 2);
    configEditorVisible.value = true;
  } catch (e) {
    ElMessage.error('加载配置失败');
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
      ElMessage.error(`JSON 解析失败: ${e.message || e}`);
      return;
    }

    const resp = await fetch('/api/config/saveAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    });
    const result = await resp.json();
    if (!result.success) {
      throw new Error(result.error || '保存失败');
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
    ElMessage.success('配置已保存');
    configEditorVisible.value = false;
  } catch (err: any) {
    ElMessage.error(`保存配置失败: ${err.message || err}`);
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
      throw new Error(result?.error || '打开失败');
    }
    ElMessage.success('已用系统程序打开配置文件');
  } catch (err: any) {
    ElMessage.error(`打开配置文件失败: ${err?.message || err}`);
  }
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
    '确定要删除此储藏吗？此操作不可恢复。',
    '删除储藏',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
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
    '确定要清空所有储藏吗？此操作不可恢复。',
    '清空所有储藏',
    {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
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
      stashDiff.value = '无效的stash ID';
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
        stashDiff.value = '该stash没有变更文件';
      }
    } else {
      stashDiff.value = `获取文件列表失败: ${filesData.error || '未知错误'}`;
    }
  } catch (error) {
    stashDiff.value = `获取stash详情失败: ${(error as Error).message}`;
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
      stashDiff.value = diffData.diff || '没有变更内容';
    } else {
      stashDiff.value = `获取差异失败: ${diffData.error || '未知错误'}`;
    }
  } catch (error) {
    stashDiff.value = `获取差异失败: ${(error as Error).message}`;
  } finally {
    isLoadingStashDetail.value = false;
  }
}

// 格式化差异内容，添加颜色和语法高亮
function formatStashDiff(diffText: string) {
  if (!diffText) return "";

  // 将差异内容按行分割
  const lines = diffText.split("\n");

  // 转义 HTML 标签的函数
  function escapeHtml(text: string) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 为每行添加适当的 CSS 类
  return lines
    .map((line) => {
      // 先转义 HTML 标签，再添加样式
      const escapedLine = escapeHtml(line);

      if (line.startsWith("diff --git")) {
        return `<div class="diff-header">${escapedLine}</div>`;
      } else if (line.startsWith("---")) {
        return `<div class="diff-old-file">${escapedLine}</div>`;
      } else if (line.startsWith("+++")) {
        return `<div class="diff-new-file">${escapedLine}</div>`;
      } else if (line.startsWith("@@")) {
        return `<div class="diff-hunk-header">${escapedLine}</div>`;
      } else if (line.startsWith("+")) {
        return `<div class="diff-added">${escapedLine}</div>`;
      } else if (line.startsWith("-")) {
        return `<div class="diff-removed">${escapedLine}</div>`;
      } else {
        return `<div class="diff-context">${escapedLine}</div>`;
      }
    })
    .join("");
}

// 添加默认提交信息模板相关变量
const messageTemplates = ref<string[]>([]);
const isEditingMessage = ref(false);
const originalMessageTemplate = ref("");
const editingMessageIndex = ref(-1);

// 监听标准化提交状态变化，保存到localStorage
watch(isStandardCommit, (newValue) => {
  localStorage.setItem("zen-gitsync-standard-commit", newValue.toString());
});

// 监听跳过钩子状态变化，保存到localStorage
watch(skipHooks, (newValue) => {
  localStorage.setItem("zen-gitsync-skip-hooks", newValue.toString());
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
    placeholder.value = `输入提交信息 (默认: ${config.defaultCommitMessage})`;
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

// 保存描述模板
async function saveDescriptionTemplate() {
  if (!newTemplateName.value.trim()) {
    ElMessage({
      message: "请输入模板内容",
      type: "warning",
    });
    return;
  }

  try {
    // 判断是编辑还是新建
    if (isEditingDescription.value) {
      // 编辑现有模板
      await updateDescriptionTemplate();
    } else {
      // 新建模板
      // 检查是否已存在相同模板
      if (descriptionTemplates.value.includes(newTemplateName.value)) {
        ElMessage({
          message: "该模板已存在",
          type: "warning",
        });
        return;
      }

      // 使用 configStore 保存模板
      const success = await configStore.saveTemplate(newTemplateName.value, 'description');
      
      if (success) {
        // 确保本地数组同步更新
        if (!descriptionTemplates.value.includes(newTemplateName.value)) {
          descriptionTemplates.value.push(newTemplateName.value);
        }
        // 强制更新视图
        descriptionTemplates.value = [...descriptionTemplates.value];
        
        // configStore已经显示了成功消息，这里不需要重复操作
        newTemplateName.value = ""; // 清空输入框，但不关闭弹窗
      }
    }
  } catch (error) {
    ElMessage({
      message: `保存模板失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 更新描述模板
async function updateDescriptionTemplate() {
  if (!newTemplateName.value.trim()) {
    ElMessage({
      message: "请输入模板内容",
      type: "warning",
    });
    return;
  }

  try {
    // 使用 configStore 更新模板
    const success = await configStore.updateTemplate(
      originalDescriptionTemplate.value,
      newTemplateName.value,
      'description'
    );

    if (success) {
      // 确保本地数组同步更新
      const index = descriptionTemplates.value.indexOf(originalDescriptionTemplate.value);
      if (index !== -1) {
        descriptionTemplates.value[index] = newTemplateName.value;
      }
      // 强制更新视图
      descriptionTemplates.value = [...descriptionTemplates.value];
      
      // configStore已经更新了本地数组并显示了成功消息，这里不需要重复操作
      
      // 重置编辑状态
      isEditingDescription.value = false;
      originalDescriptionTemplate.value = "";
      editingDescriptionIndex.value = -1;
      newTemplateName.value = "";
    }
  } catch (error) {
    ElMessage({
      message: `更新模板失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 开始编辑描述模板
function startEditDescriptionTemplate(template: string, index: number) {
  isEditingDescription.value = true;
  originalDescriptionTemplate.value = template;
  editingDescriptionIndex.value = index;
  newTemplateName.value = template;
}

// 取消编辑描述模板
function cancelEditDescriptionTemplate() {
  isEditingDescription.value = false;
  originalDescriptionTemplate.value = "";
  editingDescriptionIndex.value = -1;
  newTemplateName.value = "";
}

// 保存作用域模板
async function saveScopeTemplate() {
  if (!newScopeTemplate.value.trim()) {
    ElMessage({
      message: "请输入模板内容",
      type: "warning",
    });
    return;
  }

  try {
    // 判断是编辑还是新建
    if (isEditingScope.value) {
      // 编辑现有模板
      await updateScopeTemplate();
    } else {
      // 新建模板
      // 检查是否已存在相同模板
      if (scopeTemplates.value.includes(newScopeTemplate.value)) {
        ElMessage({
          message: "该模板已存在",
          type: "warning",
        });
        return;
      }

      // 使用 configStore 保存模板
      const success = await configStore.saveTemplate(newScopeTemplate.value, 'scope');
      
      if (success) {
        // 确保本地数组同步更新
        if (!scopeTemplates.value.includes(newScopeTemplate.value)) {
          scopeTemplates.value.push(newScopeTemplate.value);
        }
        // 强制更新视图
        scopeTemplates.value = [...scopeTemplates.value];
        
        // configStore已经显示了成功消息，这里不需要重复操作
        newScopeTemplate.value = ""; // 清空输入框，但不关闭弹窗
      }
    }
  } catch (error) {
    ElMessage({
      message: `保存模板失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 更新作用域模板
async function updateScopeTemplate() {
  if (!newScopeTemplate.value.trim()) {
    ElMessage({
      message: "请输入模板内容",
      type: "warning",
    });
    return;
  }

  try {
    // 使用 configStore 更新模板
    const success = await configStore.updateTemplate(
      originalScopeTemplate.value,
      newScopeTemplate.value,
      'scope'
    );

    if (success) {
      // 确保本地数组同步更新
      const index = scopeTemplates.value.indexOf(originalScopeTemplate.value);
      if (index !== -1) {
        scopeTemplates.value[index] = newScopeTemplate.value;
      }
      // 强制更新视图
      scopeTemplates.value = [...scopeTemplates.value];
      
      // configStore已经更新了本地数组并显示了成功消息，这里不需要重复操作
      
      // 重置编辑状态
      isEditingScope.value = false;
      originalScopeTemplate.value = "";
      editingScopeIndex.value = -1;
      newScopeTemplate.value = "";
    }
  } catch (error) {
    ElMessage({
      message: `更新模板失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 开始编辑作用域模板
function startEditScopeTemplate(template: string, index: number) {
  isEditingScope.value = true;
  originalScopeTemplate.value = template;
  editingScopeIndex.value = index;
  newScopeTemplate.value = template;
}

// 取消编辑作用域模板
function cancelEditScopeTemplate() {
  isEditingScope.value = false;
  originalScopeTemplate.value = "";
  editingScopeIndex.value = -1;
  newScopeTemplate.value = "";
}

// 删除描述模板
async function deleteDescriptionTemplate(template: string) {
  try {
    // 确认删除
    await ElMessageBox.confirm(
      `确定要删除描述模板 "${template}" 吗？`,
      "删除确认",
      {
        confirmButtonText: "确定",
        cancelButtonText: "取消",
        type: "warning",
      }
    );

    // 使用 configStore 删除模板
    const success = await configStore.deleteTemplate(template, 'description');
    
    if (success) {
      // 确保本地数组同步更新
      const index = descriptionTemplates.value.indexOf(template);
      if (index !== -1) {
        descriptionTemplates.value.splice(index, 1);
      }
      // 强制更新视图
      descriptionTemplates.value = [...descriptionTemplates.value];
    }
  } catch (error) {
    if (error === "cancel") {
      // 用户取消删除，不做任何操作
      return;
    }
    
    ElMessage({
      message: `删除模板失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 删除作用域模板
async function deleteScopeTemplate(template: string) {
  try {
    // 确认删除
    await ElMessageBox.confirm(
      `确定要删除作用域模板 "${template}" 吗？`,
      "删除确认",
      {
        confirmButtonText: "确定",
        cancelButtonText: "取消",
        type: "warning",
      }
    );

    // 使用 configStore 删除模板
    const success = await configStore.deleteTemplate(template, 'scope');
    
    if (success) {
      // 确保本地数组同步更新
      const index = scopeTemplates.value.indexOf(template);
      if (index !== -1) {
        scopeTemplates.value.splice(index, 1);
      }
      // 强制更新视图
      scopeTemplates.value = [...scopeTemplates.value];
    }
  } catch (error) {
    if (error === "cancel") {
      // 用户取消删除，不做任何操作
      return;
    }
    
    ElMessage({
      message: `删除模板失败: ${(error as Error).message}`,
      type: "error",
    });
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

// 添加文件到暂存区 (git add)
async function addToStage() {
  try {
    const result = await gitStore.addToStage();
    if (result) {
      // 触发状态更新事件
      gitStore.fetchStatus();
    }
  } catch (error) {
    ElMessage({
      message: `添加文件失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 提交更改 (git commit)
async function commitChanges() {
  if (!finalCommitMessage.value.trim()) {
    ElMessage({
      message: "提交信息不能为空",
      type: "warning",
    });
    return;
  }

  try {
    // 使用Store提交更改
    const result = await gitStore.commitChanges(finalCommitMessage.value, skipHooks.value);

    if (result) {
      // 清空提交信息
      clearCommitFields();

      // 触发成功事件
      gitStore.fetchStatus();
      gitStore.fetchLog();

      // 手动更新分支状态（不需要等待，因为只是提交操作）
      gitStore.getBranchStatus(true);
    }
  } catch (error) {
    ElMessage({
      message: `提交失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 显示推送成功提示
function showPushSuccessIndicator() {
  showPushSuccess.value = true;
  setTimeout(() => {
    showPushSuccess.value = false;
  }, 2000);
}

// 推送到远程 (git push)
async function pushToRemote() {
  try {
    await gitStore.pushToRemote();

    // 推送完成后，设置状态更新中标识，避免显示间隙
    isUpdatingStatus.value = true;

    // 等待分支状态刷新完成后再显示成功动画
    try {
      // pushToRemote已经刷新了分支状态，这里稍等一下确保状态传播
      await new Promise(resolve => setTimeout(resolve, 200));

      // 分支状态刷新完成后显示推送成功提示
      showPushSuccessIndicator();
    } catch (error) {
      console.error('推送后处理失败:', error);
      // 即使处理失败也显示成功动画，因为推送操作已经成功
      showPushSuccessIndicator();
    } finally {
      isUpdatingStatus.value = false;
    }
  } catch (error) {
    isUpdatingStatus.value = false;
    ElMessage({
      message: `推送失败: ${(error as Error).message}`,
      type: 'error',
    });
  }
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
      message: `暂存并提交失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 添加、提交并推送 (git add + git commit + git push)
async function addCommitAndPush() {
  if (!finalCommitMessage.value.trim()) {
    ElMessage({
      message: "提交信息不能为空",
      type: "warning",
    });
    return;
  }

  try {
    const result = await gitStore.addCommitAndPush(finalCommitMessage.value, skipHooks.value);

    if (result) {
      // 清空提交信息
      clearCommitFields();

      // 等待分支状态刷新完成后再显示成功动画
      isUpdatingStatus.value = true;
      try {
        // 延时确保所有状态都已更新
        await new Promise(resolve => setTimeout(resolve, 1000));

        // pushToRemote已经刷新了分支状态，这里不需要重复调用
        // 只需要等待一下确保状态已经传播到UI
        console.log('一键推送完成，状态已在pushToRemote中刷新');

        // 分支状态刷新完成后显示成功动画
        showPushSuccessIndicator();
      } catch (error) {
        console.error('一键推送后处理失败:', error);
        // 即使处理失败也显示成功动画，因为主要操作已经成功
        showPushSuccessIndicator();
      } finally {
        isUpdatingStatus.value = false;
      }
    }

  } catch (error) {
    ElMessage({
      message: `暂存、提交并推送失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 重置到远程分支 (git reset --hard origin/branch)
async function resetToRemote() {
  try {
    await ElMessageBox.confirm(
      `确定要重置当前分支 "${gitStore.currentBranch}" 到远程状态吗？这将丢失所有未推送的提交和本地更改。`,
      '重置到远程分支',
      {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
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
        message: `重置到远程分支失败: ${(error as Error).message}`,
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
}

// 打开默认提交信息设置弹窗
function openDefaultMessageSettings() {
  newDefaultMessage.value = defaultCommitMessage.value;
  defaultMessageDialogVisible.value = true;
}

// 保存默认提交信息
async function saveDefaultMessage() {
  if (!newDefaultMessage.value.trim()) {
    ElMessage({
      message: "请输入默认提交信息",
      type: "warning",
    });
    return;
  }

  try {
    // 使用 configStore 保存默认提交信息
    const success = await configStore.saveDefaultMessage(newDefaultMessage.value);
    
    if (success) {
      // 更新本地默认提交信息
      defaultCommitMessage.value = newDefaultMessage.value;
      placeholder.value = `输入提交信息 (默认: ${newDefaultMessage.value})`;
      
      // configStore 已经显示了成功消息，这里不需要重复显示
      // ElMessage({
      //   message: "默认提交信息已保存",
      //   type: "success",
      // });
      
      // 关闭对话框
      defaultMessageDialogVisible.value = false;
    }
  } catch (error) {
    ElMessage({
      message: `保存默认提交信息失败: ${(error as Error).message}`,
      type: "error",
    });
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

// 计算未暂存文件数量（排除锁定文件）
const unstagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file =>
    ['modified', 'deleted', 'untracked'].includes(file.type) &&
    !isFileLocked(file.path)
  ).length;
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

const hasAnyChanges = computed(() => {
  return gitStore.fileList.some(file => !isFileLocked(file.path));
});

const needsPush = computed(() => {
  return gitStore.branchAhead > 0;
});

const needsPull = computed(() => {
  return gitStore.branchBehind > 0;
});

const canPush = computed(() => {
  // 修改条件判断：
  // 1. 如果分支有上游并且领先提交，可以推送
  // 2. 如果有已暂存的更改但未提交，不能推送
  // 3. 如果有已提交未推送的更改，可以推送
  return gitStore.hasUpstream && needsPush.value && !hasStagedChanges.value;
});

const canReset = computed(() => {
  return hasStagedChanges.value;
});

const canResetToRemote = computed(() => {
  return gitStore.hasUpstream && (needsPush.value || needsPull.value || hasAnyChanges.value);
});

// 保存默认提交信息模板
async function saveMessageTemplate() {
  if (!newDefaultMessage.value.trim()) {
    ElMessage({
      message: "请输入模板内容",
      type: "warning",
    });
    return;
  }

  try {
    // 判断是编辑还是新建
    if (isEditingMessage.value) {
      // 编辑现有模板
      await updateMessageTemplate();
    } else {
      // 新建模板
      // 检查是否已存在相同模板
      if (messageTemplates.value.includes(newDefaultMessage.value)) {
        ElMessage({
          message: "该模板已存在",
          type: "warning",
        });
        return;
      }

      // 添加到本地数组
      messageTemplates.value.push(newDefaultMessage.value);

      // 保存到服务器
      const response = await fetch("/api/config/save-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: newDefaultMessage.value,
          type: "message",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "提交信息模板保存成功!",
          type: "success",
        });
        newDefaultMessage.value = "";
      } else {
        ElMessage({
          message: "模板保存失败: " + result.error,
          type: "error",
        });
      }
    }
  } catch (error) {
    ElMessage({
      message: "模板保存失败: " + (error as Error).message,
      type: "error",
    });
  }
}

// 更新提交信息模板
async function updateMessageTemplate() {
  try {
    // 先从本地数组中更新
    if (editingMessageIndex.value >= 0) {
      // 保存原模板和新模板
      const oldTemplate = originalMessageTemplate.value;
      const newTemplate = newDefaultMessage.value;

      // 更新本地数组
      messageTemplates.value[editingMessageIndex.value] = newTemplate;

      // 调用API更新服务器
      const response = await fetch("/api/config/update-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oldTemplate,
          newTemplate,
          type: "message",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "提交信息模板更新成功!",
          type: "success",
        });

        // 重置编辑状态
        isEditingMessage.value = false;
        originalMessageTemplate.value = "";
        editingMessageIndex.value = -1;
        newDefaultMessage.value = "";
      } else {
        ElMessage({
          message: "模板更新失败: " + result.error,
          type: "error",
        });
      }
    }
  } catch (error) {
    ElMessage({
      message: "模板更新失败: " + (error as Error).message,
      type: "error",
    });
  }
}

// 开始编辑提交信息模板
function startEditMessageTemplate(template: string, index: number) {
  isEditingMessage.value = true;
  originalMessageTemplate.value = template;
  editingMessageIndex.value = index;
  newDefaultMessage.value = template;
}

// 取消编辑提交信息模板
function cancelEditMessageTemplate() {
  isEditingMessage.value = false;
  originalMessageTemplate.value = "";
  editingMessageIndex.value = -1;
  newDefaultMessage.value = "";
}

// 删除提交信息模板
async function deleteMessageTemplate(template: string) {
  try {
    // 从本地数组中删除
    const index = messageTemplates.value.indexOf(template);
    if (index !== -1) {
      messageTemplates.value.splice(index, 1);
    }

    // 从服务器删除
    const response = await fetch("/api/config/delete-template", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template,
        type: "message",
      }),
    });

    const result = await response.json();
    if (result.success) {
      ElMessage({
        message: "提交信息模板删除成功!",
        type: "success",
      });
    } else {
      ElMessage({
        message: "模板删除失败: " + result.error,
        type: "error",
      });
    }
  } catch (error) {
    ElMessage({
      message: "模板删除失败: " + (error as Error).message,
      type: "error",
    });
  }
}

// 使用默认提交信息模板
function useMessageTemplate(template: string) {
  // 设置为当前提交信息
  commitMessage.value = template;
  // 设置为默认提交信息编辑框的内容
  newDefaultMessage.value = template;
}

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

  // 监听配置变化并更新
  watch(() => configStore.config, updateFromConfig, { immediate: true });
  
  // 确保配置已加载
  if (!configStore.config) {
    await configStore.loadConfig();
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
      message: '请选择要合并的分支',
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

// 切换抽屉显示/隐藏
function toggleGitOperationsDrawer() {
  gitOperationsDrawerVisible.value = !gitOperationsDrawerVisible.value;
}

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
    openDefaultMessageSettings();
    // 清空输入框中的设置选项文本
    commitMessage.value = '';
  } else {
    commitMessage.value = item.value;
  }
}

</script>

<template>
  <div class="card" :class="{ 'is-pushing': gitStore.isPushing }">
    <div class="card-header">
      <h2>提交更改</h2>
      <div class="header-actions">
        <el-button
          size="small"
          type="primary"
          :icon="Edit"
          @click="openConfigEditor"
        >配置</el-button>
        <!-- 更改Git操作按钮图标 -->
        <el-button
          type="primary"
          :icon="Menu"
          size="small"
          circle
          @click="toggleGitOperationsDrawer"
          class="git-tools-button"
        />
      </div>
    </div>

    <!-- 添加推送中指示器 -->
    <transition name="el-fade-in-linear">
      <div v-if="gitStore.isPushing || isUpdatingStatus" class="pushing-indicator">
        <div class="pushing-spinner">
          <svg viewBox="0 0 50 50" class="circular">
            <circle class="path" cx="25" cy="25" r="20" fill="none" />
          </svg>
        </div>
        <div class="pushing-text">
          {{ gitStore.isPushing ? '正在推送...' : '更新状态中...' }}
        </div>
      </div>
    </transition>

    <!-- 添加推送成功指示器 -->
    <transition name="el-fade-in-linear">
      <div v-if="showPushSuccess" class="push-success-indicator">
        <el-icon class="push-success-icon"><Check /></el-icon>
        <div class="push-success-text">已完成!</div>
      </div>
    </transition>

    <div class="card-content">
      <div class="layout-container">
        <!-- 如果没有配置Git用户信息，显示提示 -->
        <div v-if="gitStore.userName === '' || gitStore.userEmail === ''" class="git-config-warning">
          <el-alert
            title="Git用户信息未配置"
            type="warning"
            :closable="false"
            show-icon
          >
            <p>您需要配置Git用户名和邮箱才能提交代码。请使用以下命令配置：</p>
            <pre class="config-command">git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"</pre>
          </el-alert>
        </div>
        
        <!-- 正常的提交区域，仅在Git用户信息已配置时显示 -->
        <template v-else>
          <!-- 左侧：提交表单 -->
          <div class="commit-section">
            <div class="commit-options">
              <div class="options-row">
                <div class="commit-mode-toggle">
                  <el-switch v-model="isStandardCommit" active-text="标准化提交" inactive-text="普通提交" />
                </div>

                <div class="no-verify-toggle">
                  <el-switch v-model="skipHooks" active-text="跳过 Git 钩子检查 (--no-verify)" />
                </div>
              </div>
            </div>

            <!-- 普通提交表单 -->
            <div v-if="!isStandardCommit" class="commit-form">
              <div class="description-container">
                <el-autocomplete
                  v-model="commitMessage"
                  :fetch-suggestions="queryMessageTemplates"
                  :placeholder="placeholder"
                  type="textarea"
                  :rows="6"
                  resize="none"
                  class="commit-message-input"
                  @select="handleMessageSelect"
                />
              </div>
              
              <!-- 添加Git命令预览区域 -->
              <div class="preview-section">
                <div class="preview-title">Git提交命令预览：</div>
                <pre class="preview-content code-command">git commit -m "{{ finalCommitMessage || '<提交信息>' }}"{{ skipHooks ? ' --no-verify' : '' }}</pre>
              </div>
              
              <!-- 添加的按钮组 -->
              <div class="form-bottom-actions">
                <div class="actions-flex-container">
                  <div class="left-actions">
                    <div class="button-grid">
                      <el-button
                        type="primary"
                        @click="addToStage"
                        :loading="gitStore.isAddingFiles"
                        :disabled="!hasUnstagedChanges"
                        class="stage-button"
                      >
                        暂存更改
                        <span v-if="unstagedFilesCount > 0">({{unstagedFilesCount}})</span>
                      </el-button>
                      
                      <el-button 
                        type="primary" 
                        @click="commitChanges" 
                        :loading="gitStore.isLoadingStatus"
                        :disabled="!hasStagedChanges || !finalCommitMessage.trim()"
                      >
                        提交
                        <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                      </el-button>
                      
                      <el-tooltip
                        :content="canPush ? '推送已提交的更改到远程仓库' : (!gitStore.hasUpstream ? '当前分支没有上游分支' : (!needsPush ? '没有需要推送的提交' : '有未提交的暂存更改，请先提交'))"
                        placement="top"
                      >
                        <el-button
                          type="primary"
                          :icon="Upload"
                          @click="pushToRemote"
                          :loading="gitStore.isPushing"
                          :disabled="!canPush"
                          :style="canPush ? {backgroundColor: '#67c23a', borderColor: '#67c23a'} : {}"
                        >
                          推送
                          <span v-if="needsPush">({{gitStore.branchAhead}})</span>
                        </el-button>
                      </el-tooltip>
                    </div>
                  </div>
                  
                  <div class="right-actions">
                    <el-tooltip
                      :content="(!hasAnyChanges ? '没有需要提交的更改' : (!finalCommitMessage.trim() ? '请输入提交信息' : (!gitStore.hasUpstream ? '当前分支没有上游分支' : '一键完成：暂存所有更改 → 提交 → 推送到远程仓库')))"
                      placement="top"
                    >
                      <el-button
                        type="success"
                        @click="addCommitAndPush"
                        :loading="gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing"
                        :disabled="!hasAnyChanges || !finalCommitMessage.trim() || !gitStore.hasUpstream"
                        class="one-push-button"
                      >
                        <div class="one-push-content">
                          <el-icon class="one-push-icon"><Position /></el-icon>
                          <div class="one-push-text">
                            <span class="one-push-title">一键推送所有</span>
                            <span class="one-push-desc">暂存 + 提交 + 推送</span>
                          </div>
                        </div>
                      </el-button>
                    </el-tooltip>
                  </div>
                </div>
              </div>
            </div>

            <!-- 标准化提交表单 -->
            <div v-else class="standard-commit-form">
              <div class="standard-commit-header">
                <div class="type-scope-container">
                  <el-select v-model="commitType" placeholder="提交类型" class="type-select" clearable>
                    <el-option v-for="item in commitTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
                  </el-select>

                  <div class="scope-wrapper">
                    <el-autocomplete
                      v-model="commitScope"
                      :fetch-suggestions="queryScopeTemplates"
                      placeholder="作用域（可选）"
                      class="scope-input"
                      clearable
                      @select="handleScopeSelect"
                    />
                  </div>
                </div>

                <div class="description-container">
                  <el-autocomplete
                    v-model="commitDescription"
                    :fetch-suggestions="queryDescriptionTemplates"
                    placeholder="简短描述（必填）"
                    class="description-input"
                    clearable
                    @select="handleDescriptionSelect"
                  />
                </div>
              </div>

              <!-- 添加展开/收起高级选项的控制按钮 -->
              <div class="advanced-options-toggle" @click="showAdvancedFields = !showAdvancedFields">
                <span>{{ showAdvancedFields ? '收起' : '正文及页脚' }}</span>
                <el-icon class="toggle-icon" :class="{ 'is-active': showAdvancedFields }">
                  <arrow-down />
                </el-icon>
              </div>

              <!-- 使用过渡效果包装高级字段 -->
              <div v-show="showAdvancedFields" class="advanced-fields">
                <el-input v-model="commitBody" type="textarea" :rows="4" placeholder="正文（可选）：详细描述本次提交的内容和原因" class="body-input"
                  clearable />

                <el-input v-model="commitFooter" placeholder="页脚（可选）：如 Closes #123" class="footer-input" clearable />
              </div>

              <div class="preview-section">
                <!-- <div class="preview-title">提交信息预览：</div>
                <pre class="preview-content">{{ finalCommitMessage }}</pre> -->

                <div class="preview-title">Git提交命令预览：</div>
                <pre class="preview-content code-command">{{ gitCommandPreview }}</pre>
              </div>
              
              <!-- 添加的按钮组 -->
              <div class="form-bottom-actions">
                <div class="actions-flex-container">
                  <div class="left-actions">
                    <div class="button-grid">
                      <el-button
                        type="primary"
                        @click="addToStage"
                        :loading="gitStore.isAddingFiles"
                        :disabled="!hasUnstagedChanges"
                        class="stage-button"
                      >
                        暂存更改
                        <span v-if="unstagedFilesCount > 0">({{unstagedFilesCount}})</span>
                      </el-button>
                      
                      <el-button 
                        type="primary" 
                        @click="commitChanges" 
                        :loading="gitStore.isLoadingStatus"
                        :disabled="!hasStagedChanges || !finalCommitMessage.trim()"
                      >
                        提交
                        <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                      </el-button>
                      
                      <el-tooltip
                        :content="canPush ? '推送已提交的更改到远程仓库' : (!gitStore.hasUpstream ? '当前分支没有上游分支' : (!needsPush ? '没有需要推送的提交' : '有未提交的暂存更改，请先提交'))"
                        placement="top"
                      >
                        <el-button
                          type="primary"
                          :icon="Upload"
                          @click="pushToRemote"
                          :loading="gitStore.isPushing"
                          :disabled="!canPush"
                          :style="canPush ? {backgroundColor: '#67c23a', borderColor: '#67c23a'} : {}"
                        >
                          推送
                          <span v-if="needsPush">({{gitStore.branchAhead}})</span>
                        </el-button>
                      </el-tooltip>
                    </div>
                  </div>
                  
                  <div class="right-actions">
                    <el-tooltip
                      :content="(!hasAnyChanges ? '没有需要提交的更改' : (!finalCommitMessage.trim() ? '请输入提交信息' : (!gitStore.hasUpstream ? '当前分支没有上游分支' : '一键完成：暂存所有更改 → 提交 → 推送到远程仓库')))"
                      placement="top"
                    >
                      <el-button
                        type="success"
                        @click="addCommitAndPush"
                        :loading="gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing"
                        :disabled="!hasAnyChanges || !finalCommitMessage.trim() || !gitStore.hasUpstream"
                        class="one-push-button"
                      >
                        <div class="one-push-content">
                          <el-icon class="one-push-icon"><Position /></el-icon>
                          <div class="one-push-text">
                            <span class="one-push-title">一键推送所有</span>
                            <span class="one-push-desc">暂存 + 提交 + 推送</span>
                          </div>
                        </div>
                      </el-button>
                    </el-tooltip>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- Git操作抽屉 -->
      <el-drawer
        v-model="gitOperationsDrawerVisible"
        title="Git 操作"
        direction="rtl"
        size="340px"
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
                <div class="group-title">基础操作</div>
                <div class="group-buttons">
                  <el-tooltip :content="hasUnstagedChanges ? `暂存${unstagedFilesCount}个待更改文件` : 'git add .'" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="primary" 
                      @click="addToStage" 
                      :loading="gitStore.isAddingFiles" 
                      :disabled="!hasUnstagedChanges"
                      class="action-button"
                    >
                      暂存更改
                      <span v-if="unstagedFilesCount > 0">({{unstagedFilesCount}})</span>
                    </el-button>
                  </el-tooltip>

                  <el-tooltip :content="hasStagedChanges ? `提交${stagedFilesCount}个已暂存文件` : 'git commit'" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="primary" 
                      @click="commitChanges" 
                      :loading="gitStore.isLoadingStatus"
                      :disabled="!hasStagedChanges || !finalCommitMessage.trim()"
                      class="action-button"
                    >
                      提交
                      <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                    </el-button>
                  </el-tooltip>

                  <el-tooltip :content="needsPush ? `推送${gitStore.branchAhead}个本地提交` : 'git push'" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="primary"
                      :icon="Upload"
                      @click="pushToRemote"
                      :loading="gitStore.isPushing"
                      :disabled="!canPush"
                      :class="['action-button', 'push-button', { 'is-loading': gitStore.isPushing }]"
                      :style="canPush ? {backgroundColor: '#67c23a', borderColor: '#67c23a'} : {}"
                    >
                      推送
                      <span v-if="needsPush">({{gitStore.branchAhead}})</span>
                    </el-button>
                  </el-tooltip>
                  
                  <el-tooltip :content="needsPull ? `拉取${gitStore.branchBehind}个远程提交` : 'git pull'" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="primary"
                      :icon="Download"
                      @click="handleGitPull"
                      :loading="gitStore.isGitPulling"
                      :disabled="!gitStore.hasUpstream"
                      class="action-button"
                      :style="gitStore.hasUpstream ? {color: 'white', backgroundColor: '#1e90ff', borderColor: '#1e90ff'} : {}"
                    >
                      拉取
                      <span v-if="needsPull">({{gitStore.branchBehind}})</span>
                    </el-button>
                  </el-tooltip>
                  
                  <el-tooltip content="git fetch --all" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="info"
                      :icon="Connection"
                      @click="handleGitFetchAll"
                      :loading="gitStore.isGitFetching"
                      class="action-button"
                      style="color: white; background-color: #1e90ff; border-color: #1e90ff;"
                    >
                      获取所有远程分支
                    </el-button>
                  </el-tooltip>
                </div>
              </div>

              

              <!-- 组合操作 -->
              <div class="action-group">
                <div class="group-title">组合操作</div>
                <div class="group-buttons">
                  <el-tooltip content="git add + git commit" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="primary"
                      :icon="Edit"
                      @click="addAndCommit"
                      :loading="gitStore.isAddingFiles || gitStore.isCommiting"
                      :disabled="!hasUnstagedChanges || !finalCommitMessage.trim()"
                      class="action-button"
                    >
                      暂存并提交
                    </el-button>
                  </el-tooltip>

                  <el-tooltip content="git add + git commit + git push" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="success"
                      :icon="Position"
                      @click="addCommitAndPush"
                      :loading="gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing"
                      :disabled="!hasAnyChanges || !finalCommitMessage.trim() || !gitStore.hasUpstream"
                      :class="['action-button', 'one-click-push', { 'is-loading': gitStore.isAddingFiles || gitStore.isCommiting || gitStore.isPushing }]"
                    >
                      一键推送所有
                    </el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>

            <!-- 重置操作 -->
            <div class="action-group reset-group">
              <div class="group-title">重置操作</div>
              <div class="group-buttons">
                <el-tooltip :content="canReset ? `撤销${stagedFilesCount}个已暂存文件` : 'git reset HEAD'" placement="top" effect="light" popper-class="git-cmd-tooltip">
                  <el-button 
                    type="warning"
                    :icon="RefreshRight"
                    @click="gitStore.resetHead"
                    :loading="gitStore.isResetting"
                    :disabled="!canReset"
                    class="action-button reset-button"
                  >
                    重置暂存区
                    <span v-if="stagedFilesCount > 0">({{stagedFilesCount}})</span>
                  </el-button>
                </el-tooltip>

                <el-tooltip content="git reset --hard origin/branch" placement="top" effect="light" popper-class="git-cmd-tooltip">
                  <el-button 
                    type="danger"
                    :icon="Delete"
                    @click="resetToRemote"
                    :loading="gitStore.isResetting"
                    :disabled="!canResetToRemote"
                    class="action-button danger-button"
                  >
                    重置到远程
                  </el-button>
                </el-tooltip>
              </div>
            </div>
            
            <!-- 添加单独的分支操作组 -->
            <div class="action-group branch-group">
              <div class="group-title">分支操作</div>
              <div class="group-buttons">
                <!-- 合并分支按钮 -->
                <el-tooltip content="合并其他分支到当前分支" placement="top" effect="light" popper-class="git-cmd-tooltip">
                  <el-button 
                    type="primary"
                    :icon="Share"
                    @click="openMergeDialog"
                    :loading="gitStore.isGitMerging"
                    class="action-button merge-button"
                  >
                    合并分支
                  </el-button>
                </el-tooltip>
              </div>
            </div>

            <!-- 储藏操作 -->
            <div class="action-group">
                <div class="group-title">储藏操作</div>
                <div class="group-buttons">
                  <el-tooltip content="将工作区更改储藏起来" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="warning" 
                      @click="openStashDialog" 
                      :loading="gitStore.isSavingStash"
                      :disabled="!hasAnyChanges"
                      class="action-button"
                    >
                      储藏更改
                    </el-button>
                  </el-tooltip>

                  <el-tooltip content="查看和管理所有储藏记录" placement="top" effect="light" popper-class="git-cmd-tooltip">
                    <el-button 
                      type="info"
                      @click="openStashListDialog"
                      class="action-button"
                    >
                      储藏列表
                    </el-button>
                  </el-tooltip>
                </div>
              </div>
          </div>
        </div>
      </el-drawer>

      <!-- 配置JSON编辑弹窗 -->
      <el-dialog
        class="config-editor-dialog"
        title="编辑配置 JSON"
        v-model="configEditorVisible"
        width="60%"
      >
        <el-input
          v-model="configEditorText"
          type="textarea"
          :rows="18"
          spellcheck="false"
          autocomplete="off"
          placeholder="在此编辑当前项目配置的 JSON"
        />
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="openSystemConfigFile">打开系统配置文件</el-button>
            <el-button @click="configEditorVisible = false">取消</el-button>
            <el-button type="primary" :loading="configEditorSaving" @click="saveFullConfig">保存</el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 简短描述设置弹窗 -->
      <el-dialog 
        title="简短描述模板设置" 
        v-model="descriptionDialogVisible" 
        width="80vw"
        top="70px"
        style="height: calc(100vh - 140px);"
        :close-on-click-modal="false"
        class="template-dialog"
      >
        <div class="template-container">
          <div class="template-form">
            <el-input v-model="newTemplateName" :placeholder="isEditingDescription ? '编辑模板内容' : '输入新模板内容'"
              class="template-input" clearable />
            <div class="template-form-buttons">
              <el-button v-if="isEditingDescription" @click="cancelEditDescriptionTemplate">取消</el-button>
              <el-button type="primary" @click="saveDescriptionTemplate" :disabled="!newTemplateName.trim()">{{
                isEditingDescription ? '更新模板' : '添加模板' }}</el-button>
            </div>
          </div>

          <div class="template-list">
            <h3>已保存模板</h3>
            <el-empty v-if="descriptionTemplates.length === 0" description="暂无保存的模板" />
            <el-card v-for="(template, index) in descriptionTemplates" :key="index" class="template-item">
              <!-- 两端对齐 -->
              <el-row justify="space-between" align="middle" style="width: 100%">
                <div class="template-content">{{ template }}</div>
                <div class="template-actions">
                  <el-button type="primary" size="small" @click="useTemplate(template)">使用</el-button>
                  <el-button type="warning" size="small" :icon="Edit"
                    @click="startEditDescriptionTemplate(template, index)">编辑</el-button>
                  <el-button type="danger" size="small" @click="deleteDescriptionTemplate(template)">删除</el-button>
                </div>
              </el-row>
            </el-card>
          </div>
        </div>
      </el-dialog>

      <!-- 作用域设置弹窗 -->
      <el-dialog 
        title="作用域模板设置" 
        v-model="scopeDialogVisible" 
        width="80vw"
        top="70px" 
        style="height: calc(100vh - 140px);"
        :close-on-click-modal="false"
        class="template-dialog"
      >
        <div class="template-container">
          <div class="template-form">
            <el-input v-model="newScopeTemplate" :placeholder="isEditingScope ? '编辑作用域模板内容' : '输入新作用域模板'"
              class="template-input" clearable />
            <div class="template-form-buttons">
              <el-button v-if="isEditingScope" @click="cancelEditScopeTemplate">取消</el-button>
              <el-button type="primary" @click="saveScopeTemplate" :disabled="!newScopeTemplate.trim()">{{ isEditingScope
                ? '更新模板' : '添加模板' }}</el-button>
            </div>
          </div>

          <div class="template-list">
            <h3>已保存作用域</h3>
            <el-empty v-if="scopeTemplates.length === 0" description="暂无保存的作用域" />
            <el-card v-for="(template, index) in scopeTemplates" :key="index" class="template-item">
              <el-row justify="space-between" align="middle" style="width: 100%">
                <div class="template-content">{{ template }}</div>
                <div class="template-actions">
                  <el-button type="primary" size="small" @click="useScopeTemplate(template)">使用</el-button>
                  <el-button type="warning" size="small" :icon="Edit"
                    @click="startEditScopeTemplate(template, index)">编辑</el-button>
                  <el-button type="danger" size="small" @click="deleteScopeTemplate(template)">删除</el-button>
                </div>
              </el-row>
            </el-card>
          </div>
        </div>
      </el-dialog>

      <!-- 默认提交信息设置弹窗 -->
      <el-dialog 
        title="默认提交信息设置" 
        v-model="defaultMessageDialogVisible" 
        width="80vw" 
        top="70px"
        style="height: calc(100vh - 140px);"
        :close-on-click-modal="false"
        class="message-template-dialog"
      >
        <div class="template-container message-template-container">
          <div class="template-form">
            <el-input v-model="newDefaultMessage" :placeholder="isEditingMessage ? '编辑模板内容' : '输入新模板内容'" class="template-input" clearable />
            <div class="template-form-buttons">
              <el-button v-if="isEditingMessage" @click="cancelEditMessageTemplate">取消</el-button>
              <el-button type="primary" @click="saveMessageTemplate" :disabled="!newDefaultMessage.trim()">
                {{ isEditingMessage ? '更新模板' : '添加模板' }}
              </el-button>
              <el-button type="success" @click="saveDefaultMessage" :disabled="!newDefaultMessage.trim()">
                设为默认提交信息
              </el-button>
            </div>
          </div>

          <div class="templates-container">
            <div class="message-templates-list">
              <h3>已保存模板</h3>
              <div class="templates-scroll-area">
                <el-empty v-if="messageTemplates.length === 0" description="暂无保存的模板" />
                <el-card v-for="(template, index) in messageTemplates" :key="index" class="template-item">
                  <el-row justify="space-between" align="middle" style="width: 100%">
                    <div class="template-content">{{ template }}</div>
                    <div class="template-actions">
                      <el-button type="primary" size="small" @click="useMessageTemplate(template)">使用</el-button>
                      <el-button type="warning" size="small" :icon="Edit"
                        @click="startEditMessageTemplate(template, index)">编辑</el-button>
                      <el-button type="danger" size="small" @click="deleteMessageTemplate(template)">删除</el-button>
                    </div>
                  </el-row>
                </el-card>
              </div>
            </div>
            
            <div class="current-default-message">
              <h3>当前默认提交信息</h3>
              <el-card class="default-message-card" v-if="defaultCommitMessage">
                <div class="default-message-content">{{ defaultCommitMessage }}</div>
              </el-card>
              <el-empty v-else description="尚未设置默认提交信息" :image-size="100" />
              
              <div class="message-help-text">
                <h4>关于默认提交信息</h4>
                <p>默认提交信息将在未输入提交信息时自动使用。</p>
                <p>你可以通过点击左侧模板的<el-tag size="small" type="primary">使用</el-tag>按钮先选择喜欢的模板，然后点击上方<el-tag size="small" type="success">设为默认提交信息</el-tag>按钮保存。</p>
              </div>
            </div>
          </div>
        </div>
      </el-dialog>
      
      <!-- 合并分支对话框 -->
      <el-dialog 
        title="合并分支" 
        v-model="isMergeDialogVisible" 
        width="500px"
        :close-on-click-modal="false"
        class="merge-dialog"
      >
        <div class="merge-dialog-content">
          <p class="merge-intro">选择要合并到当前分支 ({{ gitStore.currentBranch }}) 的分支:</p>
          
          <el-form label-position="top">
            <el-form-item label="分支类型">
              <el-radio-group v-model="branchTypeFilter" size="small">
                <el-radio-button label="all">所有分支</el-radio-button>
                <el-radio-button label="local">本地分支</el-radio-button>
                <el-radio-button label="remote">远程分支</el-radio-button>
              </el-radio-group>
            </el-form-item>
            
            <el-form-item label="选择分支">
              <el-select 
                v-model="selectedBranch" 
                placeholder="选择要合并的分支" 
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
            
            <el-form-item label="合并选项">
              <div class="merge-options">
                <el-checkbox v-model="mergeOptions.noFf">
                  <el-tooltip content="创建合并提交，即使可以使用快进合并" placement="top">
                    <span>禁用快进合并 (--no-ff)</span>
                  </el-tooltip>
                </el-checkbox>
                
                <el-checkbox v-model="mergeOptions.squash">
                  <el-tooltip content="将多个提交压缩为一个提交" placement="top">
                    <span>压缩提交 (--squash)</span>
                  </el-tooltip>
                </el-checkbox>
                
                <el-checkbox v-model="mergeOptions.noCommit">
                  <el-tooltip content="执行合并但不自动创建提交" placement="top">
                    <span>不自动提交 (--no-commit)</span>
                  </el-tooltip>
                </el-checkbox>
              </div>
            </el-form-item>
            
            <el-form-item label="合并提交信息 (可选)" v-if="mergeOptions.noFf && !mergeOptions.noCommit">
              <el-input 
                v-model="mergeOptions.message" 
                type="textarea" 
                :rows="3" 
                placeholder="输入自定义合并提交信息"
              />
            </el-form-item>
          </el-form>
        </div>
        
        <template #footer>
          <div class="dialog-footer">
            <el-button @click="isMergeDialogVisible = false">取消</el-button>
            <el-button 
              type="primary" 
              @click="handleMergeBranch" 
              :loading="gitStore.isGitMerging"
              :disabled="!selectedBranch"
              class="merge-confirm-btn"
            >
              合并
            </el-button>
          </div>
        </template>
      </el-dialog>
      
      <!-- Stash列表弹窗 -->
      <el-dialog
        title="储藏列表 (Git Stash)"
        v-model="isStashListDialogVisible"
        width="600px"
        :close-on-click-modal="false"
      >
        <div class="stash-list-content">
          <el-table
            :data="gitStore.stashes"
            stripe
            style="width: 100%"
            v-loading="gitStore.isLoadingStashes"
            empty-text="暂无储藏记录"
          >
            <el-table-column prop="id" label="ID" width="100" />
            <el-table-column prop="description" label="描述" />
            <el-table-column label="操作" width="280">
              <template #default="scope">
                <el-button
                  size="small"
                  type="info"
                  @click="viewStashDetail(scope.row)"
                  :loading="isLoadingStashDetail"
                >
                  查看
                </el-button>
                <el-button
                  size="small"
                  @click="applyStash(scope.row.id, false)"
                  :loading="gitStore.isApplyingStash"
                >
                  应用
                </el-button>
                <el-button
                  size="small"
                  type="primary"
                  @click="applyStash(scope.row.id, true)"
                  :loading="gitStore.isApplyingStash"
                >
                  应用并删除
                </el-button>
                <el-button
                  size="small"
                  type="danger"
                  @click="confirmDropStash(scope.row.id)"
                  :loading="gitStore.isDroppingStash"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          
          <div class="stash-list-actions" v-if="gitStore.stashes.length > 0">
            <el-button
              type="danger"
              @click="confirmClearAllStashes"
              :loading="gitStore.isDroppingStash"
            >
              清空所有储藏
            </el-button>
          </div>
        </div>
      </el-dialog>
      
      <!-- Stash弹窗 -->
      <el-dialog
        title="储藏更改 (Git Stash)"
        v-model="isStashDialogVisible"
        width="500px"
        :close-on-click-modal="false"
      >
        <div class="stash-dialog-content">
          <p>将当前工作区的更改储藏起来，稍后可以再次应用。</p>
          
          <el-form label-position="top">
            <el-form-item label="储藏说明 (可选)">
              <el-input 
                v-model="stashMessage" 
                placeholder="输入储藏说明（可选）"
                clearable
              />
            </el-form-item>
            
            <el-form-item>
              <el-checkbox v-model="includeUntracked">
                包含未跟踪文件 (--include-untracked)
              </el-checkbox>
            </el-form-item>

            <el-form-item>
              <el-checkbox v-model="excludeLocked">
                排除锁定文件
              </el-checkbox>
            </el-form-item>
          </el-form>
        </div>
        
        <template #footer>
          <div class="dialog-footer">
            <el-button @click="isStashDialogVisible = false">取消</el-button>
            <el-button
              type="primary"
              @click="saveStash"
              :loading="gitStore.isSavingStash"
            >
              储藏
            </el-button>
          </div>
        </template>
      </el-dialog>

      <!-- Stash详情弹窗 -->
      <el-dialog
        title="储藏详情"
        v-model="stashDetailVisible"
        width="90%"
        top="5vh"
        :close-on-click-modal="false"
        class="stash-detail-dialog"
      >
        <div class="stash-detail-content" v-if="selectedStash">
          <!-- 储藏信息头部 -->
          <div class="stash-header">
            <div class="stash-info">
              <h3>{{ selectedStash.id }}</h3>
              <p class="stash-description">{{ selectedStash.description }}</p>
            </div>
          </div>

          <!-- 主要内容区域 -->
          <div class="stash-main-content">
            <!-- 左侧：文件列表 -->
            <div class="stash-files-panel">
              <div class="panel-header">
                <h4>变更文件 ({{ stashFiles.length }})</h4>
              </div>
              
              <div class="files-list" v-loading="isLoadingStashDetail && stashFiles.length === 0">
                <el-scrollbar height="400px">
                  <el-tooltip 
                    v-for="file in stashFiles" 
                    :key="file"
                    :content="file"
                    placement="right"
                    effect="dark"
                    :disabled="file.length <= 35"
                  >
                    <div 
                      :class="['file-item', { 'active': file === selectedStashFile }]"
                      @click="getStashFileDiff(selectedStash.id, file)"
                    >
                      <el-icon class="file-icon"><Document /></el-icon>
                      <span class="file-name">{{ file }}</span>
                    </div>
                  </el-tooltip>
                  
                  <el-empty 
                    v-if="!isLoadingStashDetail && stashFiles.length === 0" 
                    description="没有找到变更文件"
                    :image-size="80"
                  />
                </el-scrollbar>
              </div>
            </div>

            <!-- 右侧：差异显示 -->
            <div class="stash-diff-panel">
              <div class="panel-header">
                <h4>文件差异</h4>
                <span v-if="selectedStashFile" class="selected-file">{{ selectedStashFile }}</span>
              </div>
              
              <div class="diff-content" v-loading="isLoadingStashDetail">
                <el-scrollbar height="400px">
                  <div 
                    v-if="stashDiff" 
                    class="diff-text"
                    v-html="formatStashDiff(stashDiff)"
                  ></div>
                  <el-empty 
                    v-else-if="!isLoadingStashDetail" 
                    description="请选择文件查看差异"
                    :image-size="80"
                  />
                </el-scrollbar>
              </div>
            </div>
          </div>
        </div>
        
        <template #footer>
          <div class="dialog-footer">
            <el-button @click="stashDetailVisible = false">关闭</el-button>
          </div>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
/* 添加动画相关的CSS */
@keyframes snakeBorder {
  0%, 100% {
    border-top: 2px solid #409EFF;
    border-right: 2px solid transparent;
    border-bottom: 2px solid transparent;
    border-left: 2px solid transparent;
  }
  25% {
    border-top: 2px solid #409EFF;
    border-right: 2px solid #67C23A;
    border-bottom: 2px solid transparent;
    border-left: 2px solid transparent;
  }
  50% {
    border-top: 2px solid transparent;
    border-right: 2px solid #67C23A;
    border-bottom: 2px solid #409EFF;
    border-left: 2px solid transparent;
  }
  75% {
    border-top: 2px solid transparent;
    border-right: 2px solid transparent;
    border-bottom: 2px solid #409EFF;
    border-left: 2px solid #67C23A;
  }
}

@keyframes glowPulse {
  0%, 100% { box-shadow: 0 0 8px rgba(64, 158, 255, 0.4); }
  50% { box-shadow: 0 0 12px rgba(103, 194, 58, 0.5); }
}

.card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
  border: 1px solid rgba(0, 0, 0, 0.03);
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.card-header {
  padding: 8px 16px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.card-content {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

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

.actions-section {
  padding: 0;
}

.actions-section h3 {
  margin-top: 0;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 16px;
  color: #303133;
  font-weight: 500;
}

.operations-wrapper {
  display: flex;
  gap: 10px;
}

.action-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.action-group {
  background-color: #f9f9f9;
  border-radius: 6px;
  padding: 12px 14px;
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
  color: #606266;
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
  flex: 1;
  min-width: 100px;
  border-radius: 4px;
  height: 36px;
  padding: 0 10px;
}

.action-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
}

.action-button:active {
  transform: translateY(0);
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
  margin-bottom: 15px;
}

.standard-commit-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.type-scope-container {
  display: flex;
  gap: 10px;
  width: 100%;
  margin-bottom: 10px;
}

.type-select {
  width: 35%; /* 提交类型占35%宽度 */
}

.scope-wrapper {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 65%; /* 作用域占65%宽度 */
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
}

.scope-input, .description-input {
  flex-grow: 1;
}

.settings-button {
  flex-shrink: 0;
}

.preview-section {
  background-color: #f5f7fa;
  padding: 10px;
  border-radius: 4px;
}

.preview-title {
  font-weight: bold;
  margin-bottom: 5px;
}

.preview-content {
  white-space: pre-wrap;
  font-family: monospace;
  margin: 0;
  padding: 10px;
  background-color: #ebeef5;
  border-radius: 4px;
}

.template-container {
  display: flex;
  flex-direction: column;
  height: calc(85vh - 100px);
  overflow-y: auto;
  padding: 5px;
}

.template-form {
  margin-bottom: 20px;
  background-color: #f8f9fa;
  padding: 15px;
  border-radius: 6px;
  border: 1px solid #ebeef5;
}

.template-form-buttons {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  justify-content: flex-end;
}

.template-input {
  flex-grow: 1;
}

.template-list {
  overflow-y: auto;
  height: 100%;
}

.template-list h3 {
  margin-top: 0;
  margin-bottom: 15px;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebeef5;
}

.template-item {
  margin-bottom: 10px;
  transition: all 0.2s ease;
  border: 1px solid #ebeef5;
}

.template-item:hover {
  background-color: #f5f7fa;
  transform: translateY(-2px);
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1);
}

.template-content {
  flex-grow: 1;
  margin-right: 10px;
  word-break: break-all;
  padding: 5px 0;
  color: #303133;
  font-weight: 500;
}

.template-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  min-width: 180px;
  flex-shrink: 0;
}

.options-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.code-command {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: 'Courier New', Courier, monospace;
  padding: 10px;
  border-radius: 4px;
  overflow-x: auto;
  white-space: pre;
  font-size: 14px;
}

@media (min-width: 768px) {
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
}

.git-config-warning {
  width: 100%;
}

.config-command {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: 'Courier New', Courier, monospace;
  padding: 10px;
  border-radius:
  4px;
  margin-top: 10px;
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

.push-button {
  background-color: #67c23a;
  border-color: #67c23a;
}

.push-button:hover {
  background-color: #85ce61;
  border-color: #85ce61;
}

.push-button.is-loading, 
.push-button.is-loading:hover, 
.push-button.is-loading:focus {
  animation: pushing-pulse 1.5s infinite;
  background-color: #67c23a !important;
  border-color: #67c23a !important;
}

.el-button.push-button.is-loading .el-loading-spinner {
  color: #fff !important;
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

/* 推送成功动画 */
@keyframes push-success {
  0% { transform: scale(1); }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); }
}

.push-success-indicator {
  position: absolute;
  inset: 0; /* 同时设置top, right, bottom, left为0 */
  margin: auto;
  background-color: rgba(255, 255, 255, 1);
  border-radius: 12px;
  padding: 20px 30px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  animation: push-success 0.5s ease-out;
  z-index: 9999;
  width: 200px;
  height: 200px;
}

.push-success-icon {
  font-size: 64px;
  color: #67c23a;
  margin-bottom: 16px;
  animation: bounce 0.8s ease-in-out;
}

@keyframes bounce {
  0%, 20%, 50%, 80%, 100% {transform: translateY(0);}
  40% {transform: translateY(-20px);}
  60% {transform: translateY(-10px);}
}

.push-success-text {
  font-size: 20px;
  font-weight: bold;
  color: #303133;
  text-align: center;
}

.reset-button {
  background-color: #909399;
  border-color: #909399;
}

.reset-button:hover {
  background-color: #a6a9ad;
  border-color: #a6a9ad;
}
.el-button+.el-button {
  margin-left: 0;
}

/* 推送中动画样式 */
.pushing-indicator {
  position: absolute;
  inset: 0;
  margin: auto;
  background-color: rgba(64, 158, 255, 1);
  border-radius: 12px;
  padding: 20px 30px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  width: 200px;
  height: 200px;
  color: white;
}

/* 表单底部操作按钮样式 */
.form-bottom-actions {
  display: block;
  padding: 8px; /* 从12px减少到8px */
  background-color: #f5f7fa;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: all 0.3s ease;
}

.form-bottom-actions:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.actions-flex-container {
  display: flex;
  justify-content: space-between;
  gap: 10px; /* 从15px减少到10px */
  width: 100%;
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

.button-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 6px; /* 从8px减少到6px */
  width: 100%;
  height: 100%;
}

.button-grid .el-button {
  margin: 0;
  height: 100%;
  min-height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 15px;
}

.button-grid .el-button:first-child {
  grid-column: 1 / 2;
  grid-row: 1 / 2;
}

.button-grid .el-button:nth-child(2) {
  grid-column: 2 / 3;
  grid-row: 1 / 2;
}

.button-grid .el-button:last-child {
  grid-column: 1 / 3;
  grid-row: 2 / 3;
}

.one-push-button {
  height: 100%;
  width: 100%;
  padding: 10px 15px;
  background: linear-gradient(135deg, #4169e1, #5e81f4);
  border: none;
  border-radius: 8px;
  box-shadow: 0 4px 10px rgba(65, 105, 225, 0.25);
  transition: all 0.3s ease;
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
  margin-right: 10px;
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
  margin-bottom: 16px;
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

.message-template-container {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 278px);
  overflow: hidden;
}

.templates-container {
  display: flex;
  gap: 20px;
  margin-top: 15px;
  flex: 1;
  overflow: hidden;
}

.message-templates-list {
  flex: 3;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #ebeef5;
  padding-right: 15px;
  height: calc(100vh - 432px);
}

.message-templates-list h3 {
  margin-top: 0;
  margin-bottom: 15px;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebeef5;
}

.current-default-message {
  flex: 2;
  display: flex;
  flex-direction: column;
  gap: 15px;
  padding-left: 15px;
}

.current-default-message h3 {
  margin-top: 0;
  margin-bottom: 15px;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
  padding-bottom: 8px;
  border-bottom: 1px solid #ebeef5;
}

.templates-scroll-area {
  overflow-y: auto;
  padding-right: 5px;
  flex: 1;
}

.default-message-card {
  margin-bottom: 15px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border-radius: 4px;
  transition: all 0.3s ease;
}

.default-message-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}

.default-message-content {
  padding: 12px 15px;
  background-color: #f0f9eb;
  border-left: 3px solid #67c23a;
  font-weight: 500;
  word-break: break-all;
  min-height: 60px;
  display: flex;
  align-items: center;
  border-radius: 0 4px 4px 0;
  color: #303133;
}

.message-help-text {
  background-color: #f8f9fa;
  border-radius: 4px;
  padding: 15px;
  font-size: 14px;
  color: #606266;
  border-left: 3px solid #909399;
  margin-top: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.message-help-text h4 {
  margin-top: 0;
  margin-bottom: 10px;
  color: #303133;
  font-size: 15px;
}

.message-help-text p {
  margin: 8px 0;
  line-height: 1.5;
}

.advanced-options-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 0;
  background-color: #f5f7fa;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.3s ease;
  user-select: none;
}

.advanced-options-toggle:hover {
  background-color: #ebeef5;
  color: #409EFF;
}

.toggle-icon {
  margin-left: 8px;
  transition: transform 0.3s ease;
}

.toggle-icon.is-active {
  transform: rotate(180deg);
}

.advanced-fields {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 15px;
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
  margin-bottom: 20px;
  color: #606266;
}

.merge-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
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

.branch-group .group-title {
  color: #606266;
  font-weight: 500;
  margin-bottom: 12px;
}

/* 禁用复选框下的提示文本换行 */
:deep(.el-checkbox__label) {
  white-space: normal;
  line-height: 1.4;
}

/* stash相关样式 */
.stash-list-content {
  padding: 20px 0;
}

.stash-list-actions {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}

.stash-dialog-content p {
  margin-bottom: 20px;
  color: #606266;
}

/* 重置操作组样式 */
.reset-group {
  border-top: none;
}

/* 添加Git工具按钮样式 */
.card-header {
  padding: 8px 16px;
  border-bottom: 1px solid #f0f0f0;
  display: flex;
  justify-content: space-between;
  align-items: center;
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
    margin-bottom: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid #f0f0f0;
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
  background-color: #f5f7fa;
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
  background-color: #e4e7ed;
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
  margin-right: 10px;
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
<style>
/* Git命令tooltip样式 */
.git-cmd-tooltip {
  font-family: 'Consolas', 'Courier New', monospace !important;
  font-size: 13px !important;
  font-weight: 500 !important;
  color: #303133 !important;
  background-color: #f5f7fa !important;
  border: 1px solid #dcdfe6 !important;
  border-radius: 4px !important;
  padding: 8px 12px !important;
  box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1) !important;
}

/* Stash详情弹窗样式 */
.stash-detail-dialog .el-dialog__header {
  padding: 15px 20px;
  margin-right: 0;
  border-bottom: 1px solid #ebeef5;
  background-color: #f8f9fa;
}

.stash-detail-dialog .el-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.stash-detail-dialog .el-dialog__body {
  padding: 20px;
}

.stash-detail-dialog .el-dialog__footer {
  padding: 15px 20px;
  border-top: 1px solid #f0f0f0;
}

/* 调整储藏详情弹窗关闭按钮位置 - 垂直居中 */
.stash-detail-dialog .el-dialog__headerbtn {
  top: 46px;
  right: 30px;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
}

.stash-detail-dialog .el-dialog__headerbtn .el-dialog__close {
  font-size: 18px;
  color: #909399;
  transition: color 0.3s ease;
}

.stash-detail-dialog .el-dialog__headerbtn:hover .el-dialog__close {
  color: #f56c6c;
}

.stash-detail-content {
  height: calc(85vh - 120px);
  display: flex;
  flex-direction: column;
}

.stash-header {
  margin-bottom: 20px;
  padding-bottom: 15px;
  border-bottom: 1px solid #ebeef5;
}

.stash-info h3 {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
  color: #409eff;
  
}

.stash-description {
  margin: 0;
  color: #606266;
  font-size: 14px;
  line-height: 1.5;
}

.stash-main-content {
  display: flex;
  flex: 1;
  gap: 20px;
  min-height: 0;
}

.stash-files-panel {
  width: 300px;
  flex-shrink: 0;
  background-color: #fafafa;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  overflow: hidden;
}

.stash-diff-panel {
  flex: 1;
  background-color: #fafafa;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  overflow: hidden;
  min-width: 0;
}

.panel-header {
  padding: 12px 16px;
  background-color: #f5f7fa;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.panel-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
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
  height: 400px;
  overflow: hidden;
}

.file-item {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  border-bottom: 1px solid #f0f0f0;
}

.file-item:hover {
  background-color: #e6f7ff;
}

.file-item.active {
  background-color: #409eff;
  color: white;
}

.file-item.active .file-icon {
  color: white;
}

.file-icon {
  margin-right: 8px;
  color: #606266;
  font-size: 16px;
}

.file-name {
  font-size: 13px;
  
  word-break: break-all;
  line-height: 1.4;
}

.diff-content {
  height: 400px;
  overflow: hidden;
}

.diff-text {
  
  font-size: 12px;
  line-height: 1.6;
  color: #303133;
  background-color: #fff;
  margin: 0;
  padding: 16px;
  white-space: pre-wrap;
  word-break: break-all;
  border: none;
  outline: none;
  /* 确保高亮样式能正确应用 */
  overflow-wrap: break-word;
}

/* Git diff 语法高亮样式 */
.diff-header {
  color: #666666;
  background-color: #f8f8f8;
  padding: 2px 4px;
  border-radius: 3px;
  font-weight: bold;
}

.diff-old-file {
  color: #d73027;
  background-color: #ffeeee;
  padding: 1px 4px;
  font-weight: bold;
}

.diff-new-file {
  color: #1a9641;
  background-color: #eeffee;
  padding: 1px 4px;
  font-weight: bold;
}

.diff-hunk-header {
  color: #0366d6;
  background-color: #f1f8ff;
  padding: 2px 4px;
  font-weight: bold;
  border-radius: 3px;
}

.diff-added {
  color: #22863a;
  background-color: #f0fff4;
  padding: 1px 4px;
  border-left: 3px solid #28a745;
}

.diff-removed {
  color: #d73027;
  background-color: #ffeef0;
  padding: 1px 4px;
  border-left: 3px solid #dc3545;
}

.diff-context {
  color: #586069;
  background-color: transparent;
  padding: 1px 4px;
}

/* 弹窗样式优化 */
.template-dialog .el-dialog__header,
.message-template-dialog .el-dialog__header,
.merge-dialog .el-dialog__header {
  padding: 15px 20px;
  margin-right: 0;
  border-bottom: 1px solid #ebeef5;
  background-color: #f8f9fa;
}

.template-dialog .el-dialog__title,
.message-template-dialog .el-dialog__title,
.merge-dialog .el-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.template-dialog .el-dialog__body,
.message-template-dialog .el-dialog__body,
.merge-dialog .el-dialog__body {
  padding: 20px;
}

.merge-dialog .el-dialog__footer {
  padding: 15px 20px;
  border-top: 1px solid #f0f0f0;
}

.template-dialog .el-dialog__headerbtn,
.message-template-dialog .el-dialog__headerbtn,
.merge-dialog .el-dialog__headerbtn {
  top: 15px;
  right: 20px;
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
</style>
