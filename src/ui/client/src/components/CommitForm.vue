<script setup lang="ts">
import { ref, onMounted, defineEmits, computed, watch } from "vue";
import { ElMessage } from "element-plus";
import { Setting } from "@element-plus/icons-vue";

const emit = defineEmits(["commit-success", "push-success"]);
const commitMessage = ref("");
const commitBtnText = ref("提交");
const pushBtnText = ref("推送到远程");
const isCommitting = ref(false);
const isPushing = ref(false);
// 添加提交并推送的状态变量
const isCommitAndPushing = ref(false);
const commitAndPushBtnText = ref("提交并推送");
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

// 作用域模板相关变量
const scopeTemplates = ref<string[]>([]);
const scopeDialogVisible = ref(false);
const newScopeTemplate = ref("");

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
  } catch (error) {
    ElMessage({
      message: "模板保存失败: " + (error as Error).message,
      type: "error",
    });
  }
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
  } catch (error) {
    ElMessage({
      message: "作用域模板保存失败: " + (error as Error).message,
      type: "error",
    });
  }
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


// 从localStorage加载标准化提交设置
function loadCommitPreference() {
  const savedPreference = localStorage.getItem("zen-gitsync-standard-commit");
  if (savedPreference !== null) {
    isStandardCommit.value = savedPreference === "true";
  }

  // 加载跳过钩子设置
  const savedSkipHooks = localStorage.getItem("zen-gitsync-skip-hooks");
  if (savedSkipHooks !== null) {
    skipHooks.value = savedSkipHooks === "true";
  }
}

// 提交更改
async function commitChanges() {
  const message = finalCommitMessage.value;
  if (!message && isStandardCommit.value && !commitDescription.value) {
    ElMessage({
      message: "请输入提交描述",
      type: "warning",
    });
    return;
  }

  try {
    isCommitting.value = true;
    commitBtnText.value = "提交中...";

    // 先执行 git add .
    const addResponse = await fetch("/api/add", {
      method: "POST",
    });
    
    const addResult = await addResponse.json();
    if (!addResult.success) {
      ElMessage({
        message: "添加文件失败: " + addResult.error,
        type: "error",
      });
      return;
    }

    const response = await fetch("/api/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        // 添加一个标志，表示消息包含换行符
        hasNewlines: message.includes("\n"),
        // 添加 no-verify 选项
        noVerify: skipHooks.value,
      }),
    });

    const result = await response.json();
    if (result.success) {
      // 清空输入
      if (isStandardCommit.value) {
        commitDescription.value = "";
        commitBody.value = "";
        commitFooter.value = "";
      } else {
        commitMessage.value = "";
      }

      ElMessage({
        message: "提交成功!",
        type: "success",
      });
      // 发出提交成功事件
      emit("commit-success");
    } else {
      ElMessage({
        message: "提交失败: " + result.error,
        type: "error",
      });
    }
  } catch (error) {
    ElMessage({
      message: "提交失败: " + (error as Error).message,
      type: "error",
    });
  } finally {
    isCommitting.value = false;
    commitBtnText.value = "提交";
  }
}

// 推送更改
async function pushChanges() {
  try {
    isPushing.value = true;
    pushBtnText.value = "推送中...";

    const response = await fetch("/api/push", {
      method: "POST",
    });

    const result = await response.json();
    if (result.success) {
      ElMessage({
        message: "推送成功!",
        type: "success",
      });
      // 发出推送成功事件
      emit("push-success");
    } else {
      ElMessage({
        message: "推送失败: " + result.error,
        type: "error",
      });
    }
  } catch (error) {
    ElMessage({
      message: "推送失败: " + (error as Error).message,
      type: "error",
    });
  } finally {
    isPushing.value = false;
    pushBtnText.value = "推送到远程";
  }
}

// 提交并推送更改
async function commitAndPush() {
  const message = finalCommitMessage.value;
  if (!message && isStandardCommit.value && !commitDescription.value) {
    ElMessage({
      message: "请输入提交描述",
      type: "warning",
    });
    return;
  }

  try {
    isCommitAndPushing.value = true;
    commitAndPushBtnText.value = "处理中...";

    // 先执行 git add .
    const addResponse = await fetch("/api/add", {
      method: "POST",
    });
    
    const addResult = await addResponse.json();
    if (!addResult.success) {
      ElMessage({
        message: "添加文件失败: " + addResult.error,
        type: "error",
      });
      return;
    }

    // 再提交
    const commitResponse = await fetch("/api/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message,
        // 添加一个标志，表示消息包含换行符
        hasNewlines: message.includes("\n"),
        // 添加 no-verify 选项
        noVerify: skipHooks.value,
      }),
    });

    const commitResult = await commitResponse.json();
    if (!commitResult.success) {
      ElMessage({
        message: "提交失败: " + commitResult.error,
        type: "error",
      });
      return;
    }

    // 清空输入
    if (isStandardCommit.value) {
      commitDescription.value = "";
      commitBody.value = "";
      commitFooter.value = "";
    } else {
      commitMessage.value = "";
    }

    // 再推送
    const pushResponse = await fetch("/api/push", {
      method: "POST",
    });

    const pushResult = await pushResponse.json();
    if (pushResult.success) {
      commitMessage.value = "";
      ElMessage({
        message: "提交并推送成功!",
        type: "success",
      });
      // 发出提交和推送成功事件
      emit("commit-success");
      emit("push-success");
    } else {
      ElMessage({
        message: "推送失败: " + pushResult.error,
        type: "error",
      });
    }
  } catch (error) {
    ElMessage({
      message: "操作失败: " + (error as Error).message,
      type: "error",
    });
  } finally {
    isCommitAndPushing.value = false;
    commitAndPushBtnText.value = "提交并推送";
  }
}


onMounted(() => {
  loadConfig();
  loadCommitPreference();
});
</script>

<template>
  <div class="card">
    <h2>提交更改</h2>

    <div class="commit-options">
      <div class="commit-mode-toggle">
        <el-switch
          v-model="isStandardCommit"
          active-text="标准化提交"
          inactive-text="普通提交"
        />
      </div>

      <div class="no-verify-toggle">
        <el-tooltip content="跳过 Git 钩子检查 (--no-verify)" placement="top">
          <el-switch v-model="skipHooks" active-text="跳过钩子 (--no-verify)" />
        </el-tooltip>
      </div>
    </div>

    <!-- 普通提交表单 -->
    <div v-if="!isStandardCommit" class="commit-form">
      <el-input v-model="commitMessage" :placeholder="placeholder" clearable />
      <el-button
        type="primary"
        @click="commitChanges"
        :loading="isCommitting"
        >{{ commitBtnText }}</el-button
      >
    </div>

    <!-- 标准化提交表单 -->
    <div v-else class="standard-commit-form">
      <div class="standard-commit-header">
        <el-select
          v-model="commitType"
          placeholder="提交类型"
          class="type-select"
          clearable
        >
          <el-option
            v-for="item in commitTypeOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
          />
        </el-select>

        <div class="scope-container">
          <el-input
            v-model="commitScope"
            placeholder="作用域（可选）"
            class="scope-input"
            clearable
          />
          <el-button
            type="primary"
            :icon="Setting"
            circle
            size="small"
            class="settings-button"
            @click="openScopeSettings"
          >
          </el-button>
        </div>

        <div class="description-container">
          <el-input
            v-model="commitDescription"
            placeholder="简短描述（必填）"
            class="description-input"
            clearable
          />
          <el-button
            type="primary"
            :icon="Setting"
            circle
            size="small"
            class="settings-button"
            @click="openDescriptionSettings"
          >
          </el-button>
        </div>
      </div>

      <el-input
        v-model="commitBody"
        type="textarea"
        :rows="4"
        placeholder="正文（可选）：详细描述本次提交的内容和原因"
        class="body-input"
        clearable
      />

      <el-input
        v-model="commitFooter"
        placeholder="页脚（可选）：如 Closes #123"
        class="footer-input"
        clearable
      />

      <div class="preview-section">
        <div class="preview-title">预览：</div>
        <pre class="preview-content">{{ finalCommitMessage }}</pre>
      </div>

      <el-button
        type="primary"
        @click="commitChanges"
        :loading="isCommitting"
        >{{ commitBtnText }}</el-button
      >
    </div>

    <div class="button-group">
      <el-button type="success" @click="pushChanges" :loading="isPushing">{{
        pushBtnText
      }}</el-button>
      <el-button
        type="warning"
        @click="commitAndPush"
        :loading="isCommitAndPushing"
        >{{ commitAndPushBtnText }}</el-button
      >
    </div>

    <!-- 简短描述设置弹窗 -->
    <el-dialog
      title="简短描述模板设置"
      v-model="descriptionDialogVisible"
      width="80vw"
      style="height: 80vh"
    >
      <div class="template-container">
        <div class="template-form">
          <el-input
            v-model="newTemplateName"
            placeholder="输入新模板内容"
            class="template-input"
            clearable
          />
          <el-button
            type="primary"
            @click="saveDescriptionTemplate"
            :disabled="!newTemplateName.trim()"
            >添加模板</el-button
          >
        </div>

        <div class="template-list">
          <h3>已保存模板</h3>
          <el-empty
            v-if="descriptionTemplates.length === 0"
            description="暂无保存的模板"
          />
          <el-card
            v-for="(template, index) in descriptionTemplates"
            :key="index"
            class="template-item"
          >
            <!-- 两端对齐 -->
            <el-row justify="space-between" align="middle" style="width: 100%">
              <div class="template-content">{{ template }}</div>
              <div class="template-actions">
                <el-button
                  type="primary"
                  size="small"
                  @click="useTemplate(template)"
                  >使用</el-button
                >
                <el-button
                  type="danger"
                  size="small"
                  @click="deleteDescriptionTemplate(template)"
                  >删除</el-button
                >
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
      width="80%"
      style="height: 80vh"
    >
      <div class="template-container">
        <div class="template-form">
          <el-input
            v-model="newScopeTemplate"
            placeholder="输入新作用域模板"
            class="template-input"
            clearable
          />
          <el-button
            type="primary"
            @click="saveScopeTemplate"
            :disabled="!newScopeTemplate.trim()"
            >添加模板</el-button
          >
        </div>

        <div class="template-list">
          <h3>已保存作用域</h3>
          <el-empty
            v-if="scopeTemplates.length === 0"
            description="暂无保存的作用域"
          />
          <el-card
            v-for="(template, index) in scopeTemplates"
            :key="index"
            class="template-item"
          >
            <el-row justify="space-between" align="middle" style="width: 100%">
              <div class="template-content">{{ template }}</div>
              <div class="template-actions">
                <el-button
                  type="primary"
                  size="small"
                  @click="useScopeTemplate(template)"
                  >使用</el-button
                >
                <el-button
                  type="danger"
                  size="small"
                  @click="deleteScopeTemplate(template)"
                  >删除</el-button
                >
              </div>
            </el-row>
          </el-card>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style scoped>
.commit-form {
  display: flex;
  margin-bottom: 15px;
  gap: 10px;
}
.button-group {
  display: flex;
  gap: 10px;
}
.commit-mode-toggle {
  margin-bottom: 15px;
}
.standard-commit-form {
  display: flex;
  flex-direction: column;
  gap: 15px;
  margin-bottom: 15px;
}
.standard-commit-header {
  display: flex;
  gap: 10px;
  width: 100%;
}
.type-select {
  width: 120px;
  flex-shrink: 0;
}
.scope-container {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-grow: 0;
  width: 200px;
}
.scope-input {
  flex-grow: 1;
}
.description-container {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-grow: 1;
}
.description-input {
  flex-grow: 1;
  min-width: 200px;
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
</style>
