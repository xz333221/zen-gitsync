<script setup lang="ts">
import { $t } from "@/lang/static";
import { ref, computed, watch, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { ArrowDown, Loading, Setting } from "@element-plus/icons-vue";
import GlobalLoading from "@/components/GlobalLoading.vue";
import SuccessModal from "@/components/SuccessModal.vue";
import { useGlobalLoading } from "@/composables/useGlobalLoading";
import { useSuccessModal } from "@/composables/useSuccessModal";
import { useGitStore } from "@stores/gitStore";
import { useConfigStore } from "@stores/configStore";
import TemplateManager from "@components/TemplateManager.vue";
import GitCommandPreview from "@components/GitCommandPreview.vue";
import GitActionButtons from "@/components/GitActionButtons.vue";
import OptionSwitchCard from "@components/OptionSwitchCard.vue";
import CommandConsole from "@components/CommandConsole.vue";

const gitStore = useGitStore();
const configStore = useConfigStore();
const commitMessage = ref("");
const {
  loadingState,
  show: showLoading,
  hide: hideLoading,
  setText: setLoadingText,
} = useGlobalLoading();
const { successState } = useSuccessModal();
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
// 提交模板相关变量
const descriptionTemplates = ref<string[]>([]);
// 添加对话框可见性变量
const descriptionDialogVisible = ref(false);

// 作用域模板相关变量
const scopeTemplates = ref<string[]>([]);
const scopeDialogVisible = ref(false);

// 默认提交信息设置相关变量
const defaultMessageDialogVisible = ref(false);

// 跳过钩子
const skipHooks = ref(false);

// 回车自动一键提交开关
const autoQuickPushOnEnter = ref(false);

const gitActionButtonsRef = ref<InstanceType<typeof GitActionButtons> | null>(
  null
);

// 添加控制正文和页脚显示的状态变量
const showAdvancedFields = ref(false);

// 提交类型选项（支持国际化）
const commitTypeOptions = computed(() => [
  { value: "feat", label: `feat: ${$t("@76872:新功能")}` },
  { value: "fix", label: `fix: ${$t("@76872:修复bug")}` },
  { value: "docs", label: `docs: ${$t("@76872:文档修改")}` },
  { value: "style", label: `style: ${$t("@76872:样式修改")}` },
  { value: "refactor", label: `refactor: ${$t("@76872:代码重构")}` },
  { value: "test", label: `test: ${$t("@76872:测试代码")}` },
  { value: "chore", label: `chore: ${$t("@76872:构建/工具修改")}` },
]);

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
    return commitMessage.value.trim() !== "";
  } else {
    // 标准化提交模式：必须有提交类型和描述
    return (
      commitType.value.trim() !== "" && commitDescription.value.trim() !== ""
    );
  }
});

// 占位符：普通提交输入框，根据是否开启回车自动一键提交显示提示
const commitMessagePlaceholder = computed(() => {
  const base = `${$t("@76872:输入提交信息 (默认: ")}${
    defaultCommitMessage.value
  })`;
  return autoQuickPushOnEnter.value
    ? `${base}${$t("@76872:（按回车一键推送）")}`
    : base;
});

// 占位符：标准化提交的简短描述输入框，根据是否开启回车自动一键提交显示提示
const descriptionPlaceholder = computed(() => {
  const base = $t("@76872:简短描述（必填）");
  return autoQuickPushOnEnter.value
    ? $t("@76872:简短描述（必填，按回车一键推送）")
    : base;
});

// 计算Git命令预览
const gitCommandPreview = computed(() => {
  // 基本命令
  let command = `git commit -m "${finalCommitMessage.value}"`;

  // 如果跳过钩子开关打开，添加 --no-verify 参数
  if (skipHooks.value) {
    command += " --no-verify";
  }

  return command;
});

// 使用配置信息
function updateFromConfig() {
  const config = configStore.config;
  if (config) {
    placeholder.value = `${$t("@76872:输入提交信息 (默认: ")}${
      config.defaultCommitMessage
    })`;
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
    text: $t("@76872:正在暂存文件..."),
    showProgress: false,
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
          console.log($t("@76872:推送成功，状态已更新"));
        } catch (error) {
          console.error("一键推送后处理失败:", error);
        } finally {
          isUpdatingStatus.value = false;
        }
      }, 1000);
    } catch (error) {
      console.error("一键推送后处理失败:", error);
      isUpdatingStatus.value = false;
    }
  }
}

// 检查文件是否被锁定的同步方法
function isFileLocked(filePath: string): boolean {
  // 标准化路径分隔符，统一使用正斜杠
  const normalizedPath = filePath.replace(/\\/g, "/");
  return configStore.lockedFiles.some((lockedFile) => {
    const normalizedLocked = lockedFile.replace(/\\/g, "/");
    return normalizedPath === normalizedLocked;
  });
}

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
  const hasAnyChangesValue = gitStore.fileList.some(
    (file) => !isFileLocked(file.path)
  );
  const hasConflicts = gitStore.hasConflictedFiles;

  // 检查是否满足推送条件（与QuickPushButton.vue中的isDisabled逻辑一致）
  if (
    !hasAnyChangesValue ||
    !hasUserCommitMessage.value ||
    !gitStore.hasUpstream ||
    hasConflicts
  ) {
    return;
  }

  // 只在按下 Enter 键时处理（不包括 Shift+Enter）
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault(); // 阻止默认的换行行为

    try {
      await gitActionButtonsRef.value?.triggerQuickPush();
    } catch (error) {
      console.error("回车自动一键提交失败:", error);
    }
  }
}

// ...
async function setDefaultFromTemplate(template: string) {
  try {
    const success = await configStore.saveDefaultMessage(template);
    if (success) {
      ElMessage.success($t("@76872:默认提交信息设置成功"));
    }
  } catch (error) {
    ElMessage.error(
      `${$t("@76872:设置默认提交信息失败: ")}${(error as Error).message}`
    );
  }
}

// 监听GitStore状态变化，更新loading文字
watch(
  () => gitStore.isAddingFiles,
  (isAdding) => {
    if (isAdding && loadingState.visible) {
      setLoadingText($t("@76872:正在暂存文件..."));
    }
  }
);

watch(
  () => gitStore.isCommiting,
  (isCommiting) => {
    if (isCommiting && loadingState.visible) {
      setLoadingText($t("@76872:正在提交更改..."));
    }
  }
);

watch(
  () => gitStore.isPushing,
  (isPushing) => {
    if (isPushing && loadingState.visible) {
      // 推送阶段关闭loading，让进度弹窗接管
      hideLoading();
    }
  }
);

onMounted(async () => {
  // 从localStorage加载标准化提交选项
  const savedStandardCommit = localStorage.getItem(
    "zen-gitsync-standard-commit"
  );
  if (savedStandardCommit !== null) {
    isStandardCommit.value = savedStandardCommit === "true";
  }

  // 从localStorage加载跳过钩子选项
  const savedSkipHooks = localStorage.getItem("zen-gitsync-skip-hooks");
  if (savedSkipHooks !== null) {
    skipHooks.value = savedSkipHooks === "true";
  }

  // 从localStorage加载回车自动一键提交选项
  const savedAutoQuickPush = localStorage.getItem(
    "zen-gitsync-auto-quick-push"
  );
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
  if (
    configStore.autoSetDefaultMessage &&
    configStore.defaultCommitMessage &&
    !commitMessage.value
  ) {
    commitMessage.value = configStore.defaultCommitMessage;
  }
});

// 添加提交设置弹窗状态变量
const commitSettingsDialogVisible = ref(false);

// 向父组件暴露方法已移除，配置编辑器已封装到ConfigEditorButton组件中

// 查询描述模板的函数
function queryDescriptionTemplates(
  queryString: string,
  callback: (suggestions: any[]) => void
) {
  const templateResults = queryString
    ? descriptionTemplates.value
        .filter((template) =>
          template.toLowerCase().includes(queryString.toLowerCase())
        )
        .map((template) => ({ value: template }))
    : descriptionTemplates.value.map((template) => ({ value: template }));

  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: "⚙️ 管理模板...", isSettings: true },
  ];
  callback(results);
}

// 查询作用域模板的函数
function queryScopeTemplates(
  queryString: string,
  callback: (suggestions: any[]) => void
) {
  const templateResults = queryString
    ? scopeTemplates.value
        .filter((template) =>
          template.toLowerCase().includes(queryString.toLowerCase())
        )
        .map((template) => ({ value: template }))
    : scopeTemplates.value.map((template) => ({ value: template }));

  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: "⚙️ 管理模板...", isSettings: true },
  ];
  callback(results);
}

// 处理描述选择
function handleDescriptionSelect(item: {
  value: string;
  isSettings?: boolean;
}) {
  if (item.isSettings) {
    openDescriptionSettings();
    // 清空输入框中的设置选项文本
    commitDescription.value = "";
  } else {
    commitDescription.value = item.value;
  }
}

// 处理作用域选择
function handleScopeSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    openScopeSettings();
    // 清空输入框中的设置选项文本
    commitScope.value = "";
  } else {
    commitScope.value = item.value;
  }
}

// 查询提交信息模板的函数
function queryMessageTemplates(
  queryString: string,
  callback: (suggestions: any[]) => void
) {
  const templateResults = queryString
    ? messageTemplates.value
        .filter((template) =>
          template.toLowerCase().includes(queryString.toLowerCase())
        )
        .map((template) => ({ value: template }))
    : messageTemplates.value.map((template) => ({ value: template }));

  // 添加设置选项到下拉列表
  const results = [
    ...templateResults,
    { value: "⚙️ 管理模板...", isSettings: true },
  ];
  callback(results);
}

// 处理提交信息选择
function handleMessageSelect(item: { value: string; isSettings?: boolean }) {
  if (item.isSettings) {
    defaultMessageDialogVisible.value = true;
    // 清空输入框中的设置选项文本
    commitMessage.value = "";
  } else {
    commitMessage.value = item.value;
  }
}
</script>

<template>
  <div class="card app-card" :class="{ 'is-pushing': gitStore.isPushing }">
    <div class="card-header app-card-header">
      <div class="header-left">
        <!-- 提交模式开关 -->
        <OptionSwitchCard
          v-model="isStandardCommit"
          :title="$t('@76872:提交模式')"
          :tooltip="$t('@76872:选择传统或标准化提交格式')"
          :active-text="$t('@76872:标准化')"
          :inactive-text="$t('@76872:普通')"
          active-color="#409eff"
        >
        </OptionSwitchCard>
        <el-button
          v-if="gitStore.userName !== '' && gitStore.userEmail !== ''"
          :icon="Setting"
          @click="commitSettingsDialogVisible = true"
          class="modern-btn btn-icon-24"
        />
      </div>
      <!-- Git操作按钮组 - 移到标题右侧 -->
      <div
        class="header-actions"
        v-if="gitStore.userName !== '' && gitStore.userEmail !== ''"
      >
        <GitActionButtons
          ref="gitActionButtonsRef"
          :has-user-commit-message="hasUserCommitMessage"
          :final-commit-message="finalCommitMessage"
          :skip-hooks="skipHooks"
          @after-commit="
            (success) => {
              if (success) clearCommitFields();
            }
          "
          @after-push="handleQuickPushAfter"
          @before-push="handleQuickPushBefore"
          @clear-fields="clearCommitFields"
        />
      </div>
    </div>

    <div class="card-content app-card-content">
      <div class="layout-container">
        <!-- 如果没有配置Git用户信息，显示提示 -->
        <div
          v-if="gitStore.userName === '' || gitStore.userEmail === ''"
          class="git-config-warning"
        >
          <el-alert
            :title="$t('@76872:Git用户信息未配置')"
            type="warning"
            :closable="false"
            show-icon
          >
            <p>
              {{
                $t(
                  "@76872:您需要配置Git用户名和邮箱才能提交代码。请使用以下命令配置："
                )
              }}
            </p>
            <pre class="config-command">
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"</pre
            >
          </el-alert>
        </div>

        <!-- 正常的提交区域，仅在Git用户信息已配置时显示 -->
        <template v-else>
          <!-- 左侧：提交表单 -->
          <div class="commit-section">
            <GitCommandPreview
              :command="gitCommandPreview"
              :title="$t('@76872:提交命令预览：')"
              placeholder='git commit -m "<提交信息>"'
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
                  <el-select
                    v-model="commitType"
                    :placeholder="$t('@76872:提交类型')"
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
              <div
                class="advanced-options-toggle"
                @click="showAdvancedFields = !showAdvancedFields"
              >
                <span>{{
                  showAdvancedFields
                    ? $t("@76872:收起")
                    : $t("@76872:正文及页脚")
                }}</span>
                <el-icon
                  class="toggle-icon"
                  :class="{ 'is-active': showAdvancedFields }"
                >
                  <arrow-down />
                </el-icon>
              </div>

              <!-- 使用过渡效果包装高级字段 -->
              <div v-show="showAdvancedFields" class="advanced-fields">
                <el-input
                  v-model="commitBody"
                  type="textarea"
                  :rows="4"
                  :placeholder="
                    $t('@76872:正文（可选）：详细描述本次提交的内容和原因')
                  "
                  class="body-input"
                  clearable
                />

                <el-input
                  v-model="commitFooter"
                  :placeholder="$t('@76872:页脚（可选）：如 Closes #123')"
                  class="footer-input"
                  clearable
                />
              </div>
            </div>

            <!-- 自定义指令执行控制台 -->
            <CommandConsole />
          </div>
        </template>
      </div>
    </div>
  </div>

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

  <!-- 状态更新指示器 -->
  <transition name="el-fade-in-linear">
    <div v-if="isUpdatingStatus" class="status-updating-indicator">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ $t("@76872:更新状态中...") }}</span>
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
      </OptionSwitchCard>

      <!-- 回车自动提交开关 -->
      <OptionSwitchCard
        v-model="autoQuickPushOnEnter"
        :title="$t('@76872:回车自动提交')"
        :tooltip="$t('@76872:输入提交信息后按回车直接执行一键推送')"
        active-color="#67c23a"
        icon-class="success"
      >
      </OptionSwitchCard>

      <!-- Push完成后自动关闭弹窗 -->
      <OptionSwitchCard
        v-model="configStore.autoClosePushModal"
        :title="$t('@76872:Push完成自动关闭')"
        :tooltip="$t('@76872:推送成功后自动关闭进度弹窗')"
        active-color="#409eff"
        icon-class="info"
      >
      </OptionSwitchCard>

      <!-- 自动设置默认提交信息 -->
      <OptionSwitchCard
        v-model="configStore.autoSetDefaultMessage"
        :title="$t('@76872:自动填充默认提交信息')"
        :tooltip="$t('@76872:打开页面或提交完成后自动填充默认提交信息')"
        active-color="#67c23a"
        icon-class="success"
      >
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
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Monaco, Inconsolata,
    "Roboto Mono", "Droid Sans Mono", Consolas, "Courier New", monospace;
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
  background: linear-gradient(
    135deg,
    var(--bg-container-hover) 0%,
    #fff2e6 100%
  );
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


.git-config-warning {
  width: 100%;
}

.config-command {
  background-color: #2d2d2d;
  color: #f8f8f2;
  font-family: "Courier New", Courier, monospace;
  padding: 8px;
  border-radius: 4px;
  margin-top: 8px;
  white-space: pre;
}

/* 推送时的动画效果 */
@keyframes pushing-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(103, 194, 58, 0.4);
  }
  70% {
    box-shadow: 0 0 0 15px rgba(103, 194, 58, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(103, 194, 58, 0);
  }
}

@keyframes pushing-border {
  0% {
    border-color: #67c23a;
  }
  50% {
    border-color: #85ce61;
  }
  100% {
    border-color: #67c23a;
  }
}

.card.is-pushing {
  animation: pushing-border 1.5s infinite ease-in-out;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
}

/* 一键推送所有按钮动画 */
@keyframes one-click-push-glow {
  0% {
    box-shadow: 0 0 5px rgba(103, 194, 58, 0.5);
  }
  50% {
    box-shadow: 0 0 20px rgba(103, 194, 58, 0.8);
  }
  100% {
    box-shadow: 0 0 5px rgba(103, 194, 58, 0.5);
  }
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
  color: #409eff;
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


.commit-section {
  flex: 1;
  width: 100%;
  min-width: 0; /* 防止子元素撑开 */
}

/* 配置编辑器加载动画 */
.is-loading {
  animation: rotating 2s linear infinite;
}

@keyframes rotating {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.save-btn {
  border-radius: 6px;
  font-weight: 500;
  min-width: 100px;
  transition: all 0.3s ease;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(144, 147, 153, 0.3);
  }
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

/* 提交设置弹窗样式 */
.commit-settings-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
