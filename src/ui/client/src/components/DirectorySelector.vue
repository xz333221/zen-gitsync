<script setup lang="ts">
import { $t } from '@/lang/static'
import CommonDialog from "@components/CommonDialog.vue";
import DirectoryBrowserDialog from "@components/DirectoryBrowserDialog.vue";
import { ElMessage } from "element-plus";
import { Folder, FolderOpened, Clock, Monitor } from "@element-plus/icons-vue";
import { ref, computed, watch, onMounted } from "vue";
import { useConfigStore } from "@/stores/configStore";
import { useGitStore } from "@/stores/gitStore";
import IconButton from "@components/IconButton.vue";
import SvgIcon from "@components/SvgIcon/index.vue";
import { getFolderNameFromPath } from "@/utils/path";

const props = withDefaults(defineProps<{
  variant?: 'default' | 'header'
}>(), {
  variant: 'default'
})

// 使用 store
const configStore = useConfigStore();
const gitStore = useGitStore();

// 从 store 中获取当前目录
const currentDirectory = computed(() => configStore.currentDirectory);

// 获取当前文件夹名称（用于显示）
const currentFolderName = computed(() => getFolderNameFromPath(currentDirectory.value));

// 对话框与状态
const isDirectoryDialogVisible = ref(false);
const newDirectoryPath = ref("");
const isChangingDirectory = ref(false);
const recentDirectories = ref<string[]>([]);
const isBrowserDialogVisible = ref(false);

// npm脚本相关
const hasNpmScripts = ref(false);
let checkNpmScriptsTimer: ReturnType<typeof setTimeout> | null = null;

// 定义emits
const emit = defineEmits<{
  toggleNpmPanel: []
}>();

// 打开切换目录对话框
function onOpenDialog() {
  newDirectoryPath.value = currentDirectory.value;
  isDirectoryDialogVisible.value = true;
  getRecentDirectories();
}

// 在资源管理器中打开当前目录
async function onOpenExplorer() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning("当前目录路径为空");
      return;
    }
    const response = await fetch("/api/open_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success("已在文件管理器中打开目录");
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开目录失败: ')}${(error as Error).message}`);
  }
}

// 用 VSCode 打开当前目录
async function onOpenInVscode() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning('当前目录路径为空');
      return;
    }
    const response = await fetch('/api/open-directory-with-vscode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success('已用 VSCode 打开目录');
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`打开失败: ${(error as Error).message}`);
  }
}

// 在终端中打开当前目录
async function onOpenTerminal() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning("当前目录路径为空");
      return;
    }
    const response = await fetch("/api/open_terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success("已在终端中打开目录");
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开终端失败: ')}${(error as Error).message}`);
  }
}

// npm脚本检查已移至NpmScriptsPanel中，点击按钮时按需加载

// 切换npm脚本面板
function onToggleNpmPanel() {
  emit('toggleNpmPanel');
}

// 获取最近访问的目录
async function getRecentDirectories() {
  try {
    const response = await fetch("/api/recent_directories");
    const result = await response.json();
    if (result.success && Array.isArray(result.directories)) {
      recentDirectories.value = result.directories;
    }
  } catch (error) {
    console.error("获取最近目录失败:", error);
  }
}


// 保存最近使用的目录
async function saveRecentDirectory(directory: string) {
  try {
    await fetch("/api/save_recent_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: directory }),
    });
  } catch (error) {
    console.error("保存最近目录失败:", error);
  }
}

// 切换目录
async function changeDirectory() {
  if (!newDirectoryPath.value) {
    ElMessage.warning("目录路径不能为空");
    return;
  }
  try {
    isChangingDirectory.value = true;
    const response = await fetch("/api/change_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: newDirectoryPath.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success("已切换工作目录");
      isDirectoryDialogVisible.value = false;
      await saveRecentDirectory(result.directory);
      await getRecentDirectories();
      
      // 立即清空文件列表和提交历史，避免显示旧目录的数据
      gitStore.log = [];
      gitStore.fileList = [];
      gitStore.status = {
        staged: [],
        unstaged: [],
        untracked: []
      };
      gitStore.currentPage = 1;
      gitStore.totalCommits = 0;
      
      // 清空npm脚本状态
      hasNpmScripts.value = false;
      
      // 直接更新 store 状态
      configStore.setCurrentDirectory(result.directory);
      gitStore.isGitRepo = result.isGitRepo;
      
      // 切换目录后强制重新加载配置
      await configStore.loadConfig(true);
      
      if (result.isGitRepo) {
        // 并行加载基本信息
        await Promise.all([
          gitStore.getCurrentBranch(),
          gitStore.getAllBranches(),
          gitStore.getUserInfo(),
          gitStore.getRemoteUrl()
        ]);
        
        // 并行加载提交历史和文件状态，避免串行导致的延迟
        Promise.all([
          gitStore.refreshLog(),
          gitStore.fetchStatus()
        ]);
      } else {
        ElMessage.warning($t('@67CE7:当前目录不是Git仓库，部分功能将不可用'));
        gitStore.$reset();
      }
    } else {
      ElMessage.error(result.error || "切换目录失败");
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:切换目录失败: ')}${(error as Error).message}`);
  } finally {
    isChangingDirectory.value = false;
  }
}

// 检查NPM脚本
async function checkNpmScripts() {
  // 清除之前的定时器
  if (checkNpmScriptsTimer) {
    clearTimeout(checkNpmScriptsTimer);
  }
  
  // 延迟500ms执行，避免频繁调用
  checkNpmScriptsTimer = setTimeout(async () => {
    if (!currentDirectory.value) return;
    
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 30000); // 30秒超时
      
      const response = await fetch('/api/scan-npm-scripts', {
        signal: abortController.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error('扫描NPM脚本失败');
      }
      
      const data = await response.json();
      hasNpmScripts.value = data && data.packages && data.packages.length > 0;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('NPM脚本扫描超时');
      } else {
        console.error('检查NPM脚本失败:', error);
      }
      hasNpmScripts.value = false;
    }
  }, 500);
}

// 监听目录变化，自动检查NPM脚本
watch(currentDirectory, () => {
  checkNpmScripts();
});

// 组件挂载时检查NPM脚本
onMounted(() => {
  checkNpmScripts();
});

// 浏览目录
async function browseDirectory() {
  isBrowserDialogVisible.value = true;
}

// 目录浏览器选定回调
function onBrowserSelect(path: string) {
  newDirectoryPath.value = path;
}
</script>

<template>
<div id="directory-selector" class="directory-selector" :class="[`directory-selector--${props.variant}`]">
    <div class="directory-display cursor-pointer" :title="currentDirectory" @click="onOpenDialog">
      {{ currentFolderName }}
    </div>
    <div class="directory-actions flex">
      <IconButton
        :tooltip="$t('@67CE7:在资源管理器中打开')"
        size="large"
        @click="onOpenExplorer"
      >
        <el-icon><FolderOpened /></el-icon>
      </IconButton>
      <IconButton
        tooltip="在终端中打开"
        size="large"
        @click="onOpenTerminal"
      >
        <el-icon><Monitor /></el-icon>
      </IconButton>
      <IconButton
        tooltip="用 VSCode 打开"
        size="large"
        @click="onOpenInVscode"
      >
        <svg-icon icon-class="vscode" />
      </IconButton>
      <IconButton
        v-if="hasNpmScripts"
        tooltip="NPM 脚本"
        size="large"
        custom-class="npm-btn"
        @click="onToggleNpmPanel"
      >
        <svg-icon icon-class="npm" />
      </IconButton>
    </div>
  </div>

  <!-- 切换目录对话框 -->
  <CommonDialog
    v-model="isDirectoryDialogVisible"
    :title="$t('@67CE7:切换工作目录')"
    size="medium"
    :destroy-on-close="true"
    :append-to-body="true"
    custom-class="directory-dialog"
  >
    <div class="directory-content">
      <el-form label-position="top">
        <el-form-item>
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Folder /></el-icon>
              <span>{{ $t('@67CE7:目录路径') }}</span>
            </div>
          </template>
          <div class="directory-input-group">
            <el-input
              v-model="newDirectoryPath"
              :placeholder="$t('@67CE7:请输入目录路径')"
              class="modern-input"
              size="large"
            />
            <button type="button" class="browse-btn" @click="browseDirectory">
              <el-icon><Folder /></el-icon>
              <span>{{ $t('@67CE7:浏览') }}</span>
            </button>
          </div>
        </el-form-item>
        <el-form-item v-if="recentDirectories.length > 0">
          <template #label>
            <div class="form-label">
              <el-icon class="label-icon"><Clock /></el-icon>
              <span>{{ $t('@67CE7:常用目录') }}</span>
            </div>
          </template>
          <div class="recent-directories">
            <div
              v-for="(dir, index) in recentDirectories"
              :key="index"
              class="recent-dir-item"
              @click="newDirectoryPath = dir"
            >
              <el-icon class="dir-icon"><Folder /></el-icon>
              <span class="dir-path" :title="dir">{{ dir }}</span>
            </div>
          </div>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <div class="footer-actions">
          <button
            type="button"
            class="dialog-cancel-btn"
            @click="isDirectoryDialogVisible = false"
          >
            {{ $t('@67CE7:取消') }}
          </button>
          <button
            type="button"
            class="dialog-confirm-btn"
            @click="changeDirectory()"
            :disabled="isChangingDirectory"
          >
            <el-icon v-if="!isChangingDirectory"><Folder /></el-icon>
            <el-icon class="is-loading" v-else>
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path
                  fill="currentColor"
                  d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"
                />
              </svg>
            </el-icon>
            <span>{{ $t('@67CE7:切换') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>

  <!-- 目录浏览器弹窗 -->
  <DirectoryBrowserDialog
    v-model="isBrowserDialogVisible"
    :initial-path="newDirectoryPath || currentDirectory"
    @select="onBrowserSelect"
  />
</template>

<style scoped>
.directory-selector {
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  border-radius: var(--radius-md);
  padding: 0px;
  gap: 10px;
  /* border: 1px solid var(--border-component);
  box-shadow: var(--shadow-sm); */
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.directory-selector:hover {
  background: var(--border-component);
}

.directory-selector--header {
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid rgba(59, 130, 246, 0.16);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98) 0%, rgba(248, 250, 252, 1) 100%);
  box-shadow:
    0 14px 34px rgba(15, 23, 42, 0.14),
    0 4px 12px rgba(15, 23, 42, 0.08),
    0 0 0 1px rgba(255, 255, 255, 0.75) inset;
}

.directory-selector--header:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.96) 0%, rgba(241, 245, 249, 1) 100%);
  box-shadow:
    0 16px 38px rgba(15, 23, 42, 0.16),
    0 6px 14px rgba(15, 23, 42, 0.1),
    0 0 0 1px rgba(255, 255, 255, 0.82) inset,
    0 0 0 3px rgba(59, 130, 246, 0.08);
}

.directory-selector--header .directory-display {
  font-size: 18px;
}

.directory-selector--header .directory-actions {
  flex-shrink: 0;
  padding-left: 8px;
  border-left: 1px solid rgba(59, 130, 246, 0.12);
}

[data-theme="dark"] .directory-selector--header {
  background: linear-gradient(180deg, rgba(28, 33, 48, 0.92) 0%, rgba(22, 27, 40, 0.96) 100%);
  border-color: rgba(147, 197, 253, 0.12);
  box-shadow:
    0 16px 36px rgba(0, 0, 0, 0.34),
    0 6px 14px rgba(0, 0, 0, 0.24),
    0 0 0 1px rgba(255, 255, 255, 0.03) inset;
}

[data-theme="dark"] .directory-selector--header:hover {
  background: linear-gradient(180deg, rgba(33, 39, 56, 0.96) 0%, rgba(24, 29, 44, 0.98) 100%);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.4),
    0 8px 16px rgba(0, 0, 0, 0.28),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 0 0 3px rgba(96, 165, 250, 0.08);
}

.directory-display {
  flex: 1;
  min-width: 0;
  padding-left: var(--spacing-base);
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: var(--font-size-2xl);
  font-weight: 600;
  letter-spacing: var(--letter-spacing-tight, -0.4px);
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 对话框样式（复用 App.vue 中样式） */
.directory-content {
  padding: var(--spacing-base) 0;
}

.form-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  
  font-weight: 500;
  color: var(--color-text-title);
}

.label-icon {
  font-size: var(--font-size-md);
  color: var(--color-gray-500);
}

.directory-input-group {
  width: 100%;
  display: flex;
  gap: var(--spacing-base);
  align-items: stretch;
}

.directory-input-group .modern-input {
  flex: 1;
}

.browse-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--spacing-lg);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-height: 40px;
}

.browse-btn:hover {
  background: rgba(59, 130, 246, 0.08);
}

.browse-btn:active {
  background: rgba(59, 130, 246, 0.15);
}

.recent-directories {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-base);
}

.recent-dir-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: 10px var(--spacing-md);
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s ease;
}

.recent-dir-item:hover {
  background: var(--bg-input-hover);
  border-color: var(--border-card-hover);
  transform: translateX(2px);
}

.dir-icon {
  font-size: var(--font-size-md);
  color: var(--color-primary);
  flex-shrink: 0;
  margin-right: 0;
}

.dir-path {
  font-size: var(--font-size-sm);
  color: var(--color-text-title);
  font-family: "Courier New", monospace;
  word-break: break-all;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  flex: 1;
  min-width: 0;
}

/* dialog-footer、footer-actions、dialog-cancel-btn、dialog-confirm-btn 基础样式已移至 @/styles/common.scss */

/* 加载动画 */
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
</style>

