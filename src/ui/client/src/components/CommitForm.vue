<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Setting, Edit, Check, Upload, RefreshRight, Delete, Position, Download, Connection, ArrowDown } from "@element-plus/icons-vue";
import { useGitStore } from "../stores/gitStore";
import { useConfigStore } from "../stores/configStore";

const gitStore = useGitStore();
const configStore = useConfigStore();
const commitMessage = ref("");
const showPushSuccess = ref(false);
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
const { isGitPulling, isGitFetching } = gitStore;  // 从store获取状态

// 提交模板相关变量
const descriptionTemplates = ref<string[]>([]);
// 添加对话框可见性变量
const descriptionDialogVisible = ref(false);
const newTemplateName = ref("");
// 添加模板编辑相关变量
const isEditingDescription = ref(false);
const originalDescriptionTemplate = ref("");
const editingDescriptionIndex = ref(-1);

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
      
      // 手动更新分支状态
      gitStore.getBranchStatus();
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
    // 显示推送成功提示
    showPushSuccessIndicator();
    
    // 手动更新分支状态
    gitStore.getBranchStatus();
  } catch (error) {
    ElMessage({
      message: `推送失败: ${(error as Error).message}`,
      type: 'error',
    });
  } finally {
  }
}

// 处理git pull操作
async function handleGitPull() {
  try {
    await gitStore.gitPull();
    // 刷新状态
    await gitStore.fetchStatus();
  } catch (error) {
    ElMessage({
      message: `拉取失败: ${(error as Error).message}`,
      type: 'error',
    });
  } finally {
  }
}

// 处理git fetch --all操作
async function handleGitFetchAll() {
  try {
    await gitStore.gitFetchAll();
    // 刷新状态
    await gitStore.fetchStatus();
  } catch (error) {
    ElMessage({
      message: `获取远程分支信息失败: ${(error as Error).message}`,
      type: 'error',
    });
  } finally {
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
    await gitStore.addCommitAndPush(finalCommitMessage.value, skipHooks.value);

    // 清空提交信息
    clearCommitFields();

    // 显示成功动画
    showPushSuccessIndicator();

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

// 根据Git状态计算按钮禁用状态
const hasUnstagedChanges = computed(() => {
  return gitStore.fileList.some(file => ['modified', 'deleted', 'untracked'].includes(file.type));
});

// 计算未暂存文件数量
const unstagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file => ['modified', 'deleted', 'untracked'].includes(file.type)).length;
});

// 计算已暂存文件数量
const stagedFilesCount = computed(() => {
  return gitStore.fileList.filter(file => file.type === 'added').length;
});

const hasStagedChanges = computed(() => {
  return stagedFilesCount.value > 0;
});

const hasAnyChanges = computed(() => {
  return gitStore.fileList.length > 0;
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
  return gitStore.hasUpstream && (needsPush.value || (hasStagedChanges.value && finalCommitMessage.value.trim()));
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
</script>

<template>
  <div class="card" :class="{ 'is-pushing': gitStore.isPushing }">
    <div class="card-header">
      <h2>提交更改</h2>
    </div>

    <!-- 添加推送中指示器 -->
    <transition name="el-fade-in-linear">
      <div v-if="gitStore.isPushing" class="pushing-indicator">
        <div class="pushing-spinner">
          <svg viewBox="0 0 50 50" class="circular">
            <circle class="path" cx="25" cy="25" r="20" fill="none" />
          </svg>
        </div>
        <div class="pushing-text">正在推送...</div>
      </div>
    </transition>

    <!-- 添加推送成功指示器 -->
    <transition name="el-fade-in-linear">
      <div v-if="showPushSuccess" class="push-success-indicator">
        <el-icon class="push-success-icon"><Check /></el-icon>
        <div class="push-success-text">推送成功!</div>
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
                  <el-tooltip content="跳过 Git 钩子检查 (--no-verify)" placement="top">
                    <el-switch v-model="skipHooks" active-text="跳过钩子 (--no-verify)" />
                  </el-tooltip>
                </div>
              </div>
            </div>

            <!-- 普通提交表单 -->
            <div v-if="!isStandardCommit" class="commit-form">
              <div class="description-container">
                <el-input 
                  v-model="commitMessage" 
                  :placeholder="placeholder" 
                  type="textarea"
                  :rows="6"
                  resize="none"
                  class="commit-message-input"
                />
                <div class="input-actions">
                  <el-button type="primary" :icon="Setting" circle size="small" class="settings-button"
                    @click="openDefaultMessageSettings">
                  </el-button>
                </div>
              </div>
              
              <!-- 添加Git命令预览区域 -->
              <div class="preview-section">
                <div class="preview-title">Git提交命令预览：</div>
                <pre class="preview-content code-command">git commit -m "{{ finalCommitMessage || '<提交信息>' }}"{{ skipHooks ? ' --no-verify' : '' }}</pre>
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
                    <el-input v-model="commitScope" placeholder="作用域（可选）" class="scope-input" clearable />
                    <el-button type="primary" :icon="Setting" circle size="small" class="settings-button"
                      @click="openScopeSettings">
                    </el-button>
                  </div>
                </div>

                <div class="description-container">
                  <el-input v-model="commitDescription" placeholder="简短描述（必填）" class="description-input" clearable />
                  <el-button type="primary" :icon="Setting" circle size="small" class="settings-button"
                    @click="openDescriptionSettings">
                  </el-button>
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
                <div class="preview-title">提交信息预览：</div>
                <pre class="preview-content">{{ finalCommitMessage }}</pre>

                <div class="preview-title" style="margin-top: 10px;">Git提交命令预览：</div>
                <pre class="preview-content code-command">{{ gitCommandPreview }}</pre>
              </div>
            </div>
          </div>

          <!-- 右侧：操作区域 -->
          <div class="actions-section">
            <h3>Git 操作</h3>
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
                        :style="needsPush ? {backgroundColor: '#67c23a !important', borderColor: '#67c23a !important'} : {}"
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
                        :loading="gitStore.       isGitPulling"
                        :disabled="!gitStore.hasUpstream"
                        class="action-button"
                        :style="needsPull ? {color: 'white', backgroundColor: '#E6A23C', borderColor: '#E6A23C'} : {}"
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
                        一键推送
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
            </div>
          </div>
        </template>
      </div>

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
  height: 36px;
}

.card-header h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  color: #303133;
}

.card-content {
  padding: 15px;
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
  min-width: 0; /* 防止子元素撑开 */
}

.actions-section {
  width: 100%;
  flex-shrink: 0;
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
  padding: 8px 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  border-left: 3px solid #409EFF;
  flex: 1;
}


.action-group:nth-child(2) {
  border-left-color: #E6A23C;
}

.action-group:nth-child(3) {
  border-left-color: #909399;
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
  gap: 15px;
  margin-bottom: 15px;
}

.standard-commit-header {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

/* 一键推送按钮动画 */
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

.pushing-spinner {
  margin-bottom: 16px;
}

.pushing-text {
  font-size: 20px;
  font-weight: bold;
  text-align: center;
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

/* 弹窗样式优化 */
.template-dialog .el-dialog__header,
.message-template-dialog .el-dialog__header {
  padding: 15px 20px;
  margin-right: 0;
  border-bottom: 1px solid #ebeef5;
  background-color: #f8f9fa;
}

.template-dialog .el-dialog__title,
.message-template-dialog .el-dialog__title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.template-dialog .el-dialog__body,
.message-template-dialog .el-dialog__body {
  padding: 20px;
}

.template-dialog .el-dialog__headerbtn,
.message-template-dialog .el-dialog__headerbtn {
  top: 15px;
  right: 20px;
}

.template-dialog .el-input__inner,
.message-template-dialog .el-input__inner {
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
