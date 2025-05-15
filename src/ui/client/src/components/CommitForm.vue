<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Setting, Edit } from "@element-plus/icons-vue";
import { useGitLogStore } from "../stores/gitLogStore";
import { useGitStore } from "../stores/gitStore";

const gitLogStore = useGitLogStore();
const gitStore = useGitStore();
const commitMessage = ref("");
const isPushing = ref(false);
// 添加提交并推送的状态变量
const placeholder = ref("输入提交信息...");
// 添加默认提交信息变量
const defaultCommitMessage = ref("");
const isStandardCommit = ref(false);
const commitType = ref("feat");
const commitScope = ref("");
const commitDescription = ref("");
const commitBody = ref("");
const commitFooter = ref("");

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

// 跳过钩子
const skipHooks = ref(false);

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

// 加载配置
async function loadConfig() {
  try {
    const response = await fetch("/api/config/getConfig");
    const config = await response.json();
    placeholder.value = `输入提交信息 (默认: ${config.defaultCommitMessage})`;
    // 保存默认提交信息到变量中，以便后续使用
    defaultCommitMessage.value = config.defaultCommitMessage || "";

    // 加载描述模板
    if (
      config.descriptionTemplates &&
      Array.isArray(config.descriptionTemplates)
    ) {
      descriptionTemplates.value = config.descriptionTemplates;
    }

    // 加载作用域模板
    if (config.scopeTemplates && Array.isArray(config.scopeTemplates)) {
      scopeTemplates.value = config.scopeTemplates;
    }
  } catch (error) {
    console.error("加载配置失败:", error);
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

      // 添加到本地数组
      descriptionTemplates.value.push(newTemplateName.value);

      // 保存到服务器
      const response = await fetch("/api/config/save-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: newTemplateName.value,
          type: "description",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "模板保存成功!",
          type: "success",
        });
        newTemplateName.value = "";
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

// 编辑描述模板
async function updateDescriptionTemplate() {
  try {
    // 先从本地数组中更新
    if (editingDescriptionIndex.value >= 0) {
      // 保存原模板和新模板
      const oldTemplate = originalDescriptionTemplate.value;
      const newTemplate = newTemplateName.value;

      // 更新本地数组
      descriptionTemplates.value[editingDescriptionIndex.value] = newTemplate;

      // 调用API更新服务器
      const response = await fetch("/api/config/update-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oldTemplate,
          newTemplate,
          type: "description",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "模板更新成功!",
          type: "success",
        });

        // 重置编辑状态
        isEditingDescription.value = false;
        originalDescriptionTemplate.value = "";
        editingDescriptionIndex.value = -1;
        newTemplateName.value = "";
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

      // 添加到本地数组
      scopeTemplates.value.push(newScopeTemplate.value);

      // 保存到服务器
      const response = await fetch("/api/config/save-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: newScopeTemplate.value,
          type: "scope",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "作用域模板保存成功!",
          type: "success",
        });
        newScopeTemplate.value = "";
      } else {
        ElMessage({
          message: "作用域模板保存失败: " + result.error,
          type: "error",
        });
      }
    }
  } catch (error) {
    ElMessage({
      message: "作用域模板保存失败: " + (error as Error).message,
      type: "error",
    });
  }
}

// 更新作用域模板
async function updateScopeTemplate() {
  try {
    // 先从本地数组中更新
    if (editingScopeIndex.value >= 0) {
      // 保存原模板和新模板
      const oldTemplate = originalScopeTemplate.value;
      const newTemplate = newScopeTemplate.value;

      // 更新本地数组
      scopeTemplates.value[editingScopeIndex.value] = newTemplate;

      // 调用API更新服务器
      const response = await fetch("/api/config/update-template", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          oldTemplate,
          newTemplate,
          type: "scope",
        }),
      });

      const result = await response.json();
      if (result.success) {
        ElMessage({
          message: "作用域模板更新成功!",
          type: "success",
        });

        // 重置编辑状态
        isEditingScope.value = false;
        originalScopeTemplate.value = "";
        editingScopeIndex.value = -1;
        newScopeTemplate.value = "";
      } else {
        ElMessage({
          message: "作用域模板更新失败: " + result.error,
          type: "error",
        });
      }
    }
  } catch (error) {
    ElMessage({
      message: "作用域模板更新失败: " + (error as Error).message,
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
    // 从本地数组中删除
    const index = descriptionTemplates.value.indexOf(template);
    if (index !== -1) {
      descriptionTemplates.value.splice(index, 1);
    }

    // 从服务器删除
    const response = await fetch("/api/config/delete-template", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template,
        type: "description",
      }),
    });

    const result = await response.json();
    if (result.success) {
      ElMessage({
        message: "模板删除成功!",
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

// 删除作用域模板
async function deleteScopeTemplate(template: string) {
  try {
    // 从本地数组中删除
    const index = scopeTemplates.value.indexOf(template);
    if (index !== -1) {
      scopeTemplates.value.splice(index, 1);
    }

    // 从服务器删除
    const response = await fetch("/api/config/delete-template", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template,
        type: "scope",
      }),
    });

    const result = await response.json();
    if (result.success) {
      ElMessage({
        message: "作用域模板删除成功!",
        type: "success",
      });
    } else {
      ElMessage({
        message: "作用域模板删除失败: " + result.error,
        type: "error",
      });
    }
  } catch (error) {
    ElMessage({
      message: "作用域模板删除失败: " + (error as Error).message,
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
    const result = await gitLogStore.addToStage();
    if (result) {
      // 触发状态更新事件
      gitLogStore.fetchStatus();
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
    const result = await gitLogStore.commitChanges(finalCommitMessage.value, skipHooks.value);

    if (result) {
      // 清空提交信息
      clearCommitFields();

      // 触发成功事件
      gitLogStore.fetchStatus();
      gitLogStore.fetchLog();
    }
  } catch (error) {
    ElMessage({
      message: `提交失败: ${(error as Error).message}`,
      type: "error",
    });
  }
}

// 推送到远程 (git push)
async function pushToRemote() {
  try {
    isPushing.value = true
    // 使用Store推送更改
    const result = await gitLogStore.pushToRemote();

    if (result) {
      // 触发成功事件
      gitStore.getCurrentBranch();
      gitLogStore.fetchLog();
    }
  } catch (error) {
    ElMessage({
      message: `推送失败: ${(error as Error).message}`,
      type: "error",
    });
  } finally {
    isPushing.value = false
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
    await gitLogStore.addAndCommit(finalCommitMessage.value, skipHooks.value);

    // 清空提交信息
    clearCommitFields();

    // 触发成功事件
    gitLogStore.fetchStatus();
    gitLogStore.fetchLog();
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
    await gitLogStore.addCommitAndPush(finalCommitMessage.value, skipHooks.value);


    // 清空提交信息
    clearCommitFields();

    // 触发成功事件
    gitStore.getCurrentBranch();
    gitLogStore.fetchLog();

  } catch (error) {
    ElMessage({
      message: `暂存、提交并推送失败: ${(error as Error).message}`,
      type: "error",
    });
  } finally {
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

    const result = await gitLogStore.resetToRemote(gitStore.currentBranch);
    if (result) {
      // 触发状态更新事件
      gitLogStore.fetchStatus();
      // 更新提交历史
      gitLogStore.fetchLog();
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

onMounted(() => {
  loadConfig();

  // 从 localStorage 中获取标准化提交设置
  const savedStandardCommit = localStorage.getItem("zen-gitsync-standard-commit");
  if (savedStandardCommit !== null) {
    isStandardCommit.value = savedStandardCommit === "true";
  }

  // 从 localStorage 中获取跳过钩子设置
  const savedSkipHooks = localStorage.getItem("zen-gitsync-skip-hooks");
  if (savedSkipHooks !== null) {
    skipHooks.value = savedSkipHooks === "true";
  }
});
</script>

<template>
  <div class="card">
    <h2>提交更改</h2>

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
            <el-input v-model="commitMessage" :placeholder="placeholder" clearable />
          </div>

          <!-- 标准化提交表单 -->
          <div v-else class="standard-commit-form">
            <div class="standard-commit-header">
              <el-select v-model="commitType" placeholder="提交类型" class="type-select" clearable>
                <el-option v-for="item in commitTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>

              <div class="scope-container">
                <el-input v-model="commitScope" placeholder="作用域（可选）" class="scope-input" clearable />
                <el-button type="primary" :icon="Setting" circle size="small" class="settings-button"
                  @click="openScopeSettings">
                </el-button>
              </div>

              <div class="description-container">
                <el-input v-model="commitDescription" placeholder="简短描述（必填）" class="description-input" clearable />
                <el-button type="primary" :icon="Setting" circle size="small" class="settings-button"
                  @click="openDescriptionSettings">
                </el-button>
              </div>
            </div>

            <el-input v-model="commitBody" type="textarea" :rows="4" placeholder="正文（可选）：详细描述本次提交的内容和原因" class="body-input"
              clearable />

            <el-input v-model="commitFooter" placeholder="页脚（可选）：如 Closes #123" class="footer-input" clearable />

            <div class="preview-section">
              <div class="preview-title">提交信息预览：</div>
              <pre class="preview-content">{{ finalCommitMessage }}</pre>

              <div class="preview-title" style="margin-top: 10px;">Git命令预览：</div>
              <pre class="preview-content code-command">{{ gitCommandPreview }}</pre>
            </div>
          </div>
        </div>

        <!-- 右侧：操作区域 -->
        <div class="actions-section">
          <h3>Git 操作</h3>
          <div class="action-groups">
            <div class="action-group">
              <div class="group-title">基础操作</div>
              <div class="group-buttons">
                <el-button 
                  type="primary" 
                  @click="addToStage" 
                  :loading="gitLogStore.isAddingFiles" 
                  class="action-button"
                >
                  暂存更改
                  <span class="command-text">git add .</span>
                </el-button>

                <el-button 
                  type="primary" 
                  @click="commitChanges" 
                  :loading="gitLogStore.isLoadingStatus"
                  class="action-button"
                >
                  提交
                  <span class="command-text">git commit</span>
                </el-button>

                <el-button 
                  type="success" 
                  @click="pushToRemote" 
                  :loading="gitLogStore.isPushing"
                  class="action-button push-button"
                >
                  推送
                  <span class="command-text">git push</span>
                </el-button>
              </div>
            </div>

            <div class="action-group">
              <div class="group-title">组合操作</div>
              <div class="group-buttons">
                <el-button 
                  type="warning" 
                  @click="addAndCommit" 
                  :loading="gitLogStore.isAddingFiles || gitLogStore.isCommiting"
                  class="action-button"
                >
                  暂存并提交
                  <span class="command-text">git add + commit</span>
                </el-button>

                <el-button 
                  type="danger" 
                  @click="addCommitAndPush" 
                  :loading="gitLogStore.isAddingFiles || gitLogStore.isCommiting || gitLogStore.isPushing"
                  class="action-button"
                >
                  一键推送
                  <span class="command-text command-text-long">git add + commit + push</span>
                </el-button>
              </div>
            </div>

            <div class="action-group">
              <div class="group-title">重置操作</div>
              <div class="group-buttons">
                <!-- <el-button 
                  type="info" 
                  @click="resetHead" 
                  :loading="gitLogStore.isResetting" 
                  :icon="Refresh"
                  class="action-button reset-button"
                >
                  重置暂存区
                  <span class="command-text">git reset HEAD</span>
                </el-button> -->

                <el-button 
                  type="info" 
                  @click="resetToRemote" 
                  :loading="gitLogStore.isResetting" 
                  class="action-button reset-button"
                >
                  重置到远程
                  <span class="command-text command-text-long">git reset --hard origin/branch</span>
                </el-button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 简短描述设置弹窗 -->
    <el-dialog title="简短描述模板设置" v-model="descriptionDialogVisible" width="80vw" style="height: 80vh">
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
    <el-dialog title="作用域模板设置" v-model="scopeDialogVisible" width="80%" style="height: 80vh">
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
  </div>
</template>

<style scoped>
.card {
  background-color: white;
  border-radius: 5px;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
  margin-bottom: 20px;
  padding: 20px;
}

.layout-container {
  display: flex;
  gap: 20px;
}

.commit-section {
  flex: 1;
  min-width: 0; /* 防止子元素撑开 */
}

.actions-section {
  width: 300px;
  flex-shrink: 0;
}

.actions-section h3 {
  margin-top: 0;
  margin-bottom: 15px;
  padding-bottom: 10px;
  border-bottom: 1px solid #dcdfe6;
  font-size: 18px;
  color: #303133;
  font-weight: 500;
}

.commit-form {
  display: flex;
  margin-bottom: 15px;
  gap: 10px;
}

.git-actions {
  margin-top: 20px;
}

.action-groups {
  display: flex;
  flex-direction: column;
  gap: 15px;
}

.action-group {
  background-color: #f9f9f9;
  border-radius: 8px;
  padding: 12px 15px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  border-left: 4px solid #409EFF;
  overflow: hidden; /* 确保子元素不会溢出 */
}

.action-group:nth-child(2) {
  border-left-color: #E6A23C;
}

.action-group:nth-child(3) {
  border-left-color: #909399;
}

.group-title {
  font-size: 14px;
  font-weight: bold;
  margin-bottom: 10px;
  color: #606266;
  text-align: left;
  display: block;
  position: relative;
  padding-left: 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  padding-bottom: 8px;
}

.group-buttons {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 2px;
}

.action-button {
  position: relative;
  padding: 14px 0 24px 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: auto;
  text-align: center;
  font-size: 16px;
  border-radius: 6px;
  border: none;
}

.action-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.action-button:active {
  transform: translateY(0);
}

.action-button :deep(.el-button__content) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 40px; /* 添加最小高度确保loading不会改变按钮高度 */
}

.action-button :deep(.el-icon) {
  margin-right: 0;
  margin-bottom: 4px;
  font-size: 18px;
}

/* 添加loading状态的样式 */
.action-button :deep(.el-loading-spinner) {
  position: absolute;
  top: calc(50% - 16px);
  margin-top: 0;
}

.command-text {
  position: absolute;
  bottom: 6px;
  font-size: 14px;
  font-family: monospace;
  width: 100%;
  text-align: center;
  left: 0;
  white-space: nowrap;

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

.type-select {
  width: 100%;
}

.scope-container {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.scope-input {
  flex-grow: 1;
}

.description-container {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.description-input {
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
}

.template-form {
  margin-bottom: 20px;
}

.template-list {
  flex: 1;
  overflow-y: auto;
}

.template-input {
  flex-grow: 1;
}

.template-list {
  overflow-y: auto;
  height: 100%;
}

.template-item {
  margin-bottom: 10px;
}

.template-item:hover {
  background-color: #f5f7fa;
}

.template-content {
  flex-grow: 1;
  margin-right: 10px;
  word-break: break-all;
}

.template-actions {
  display: flex;
  gap: 5px;
  justify-content: flex-end;
  min-width: 120px;
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

@media (max-width: 768px) {
  .layout-container {
    flex-direction: column;
  }

  .actions-section {
    width: 100%;
  }
  
  .group-buttons {
    flex-direction: row;
    flex-wrap: wrap;
  }
  
  .action-button {
    flex: 1;
    min-width: 120px;
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

/* 特定按钮样式 */
.push-button {
  background-color: #67c23a;
  border-color: #67c23a;
}

.push-button:hover {
  background-color: #85ce61;
  border-color: #85ce61;
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
</style>
