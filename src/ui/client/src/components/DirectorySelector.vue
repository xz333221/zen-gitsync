<script setup lang="ts">
import { $t } from '@/lang/static'
import CommonDialog from "@components/CommonDialog.vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Folder, FolderOpened, Clock, Monitor } from "@element-plus/icons-vue";
import { ref, h, computed, watch, onMounted } from "vue";
import { useConfigStore } from "@/stores/configStore";
import { useGitStore } from "@/stores/gitStore";

// 使用 store
const configStore = useConfigStore();
const gitStore = useGitStore();

// 从 store 中获取当前目录
const currentDirectory = computed(() => configStore.currentDirectory);

// 对话框与状态
const isDirectoryDialogVisible = ref(false);
const newDirectoryPath = ref("");
const isChangingDirectory = ref(false);
const recentDirectories = ref<string[]>([]);

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
  try {
    const response = await fetch("/api/browse_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPath: newDirectoryPath.value || currentDirectory.value,
      }),
    });
    const result = await response.json();
    if (result.success) {
      selectDirectoryDialog(result);
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:浏览目录失败: ')}${(error as Error).message}`);
  }
}

// 打开目录选择弹窗（使用 MessageBox）
function selectDirectoryDialog(directoryData: any) {
  if (!directoryData || !directoryData.items) return;
  ElMessageBox.alert(
    h("div", { class: "directory-browser" }, [
      h("div", { class: "current-path" }, [
        h("span", { class: "path-label" }, "当前路径: "),
        h("span", { class: "path-value" }, directoryData.path),
      ]),
      h("div", { class: "directory-list" }, [
        directoryData.parentPath
          ? h(
              "div",
              {
                class: "directory-item parent-dir",
                onClick: () => selectDirectory(directoryData.parentPath),
              },
              [
                h(
                  "span",
                  { class: "dir-icon" },
                  h(
                    "svg",
                    {
                      class: "folder-icon",
                      viewBox: "0 0 24 24",
                      width: "20",
                      height: "20",
                      style: { fill: "#E6A23C" },
                    },
                    [
                      h("path", {
                        d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
                      }),
                    ]
                  )
                ),
                h("span", { class: "dir-name" }, "返回上级目录"),
              ]
            )
          : null,
        ...directoryData.items.map((item: any) =>
          h(
            "div",
            {
              class: "directory-item",
              onClick: () => selectDirectory(item.path),
            },
            [
              h(
                "span",
                { class: "dir-icon" },
                h(
                  "svg",
                  {
                    class: "folder-icon",
                    viewBox: "0 0 24 24",
                    width: "20",
                    height: "20",
                    style: { fill: "#409EFF" },
                  },
                  [
                    h("path", {
                      d: "M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
                    }),
                  ]
                )
              ),
              h("span", { class: "dir-name" }, item.name),
            ]
          )
        ),
      ]),
    ]),
    "浏览并选择目录",
    {
      confirmButtonText: "使用当前目录",
      customClass: "directory-browser-dialog",
      callback: (action: string) => {
        if (action === "confirm") {
          newDirectoryPath.value = directoryData.path;
        }
      },
    }
  );
}

// 选择目录后刷新对话框
async function selectDirectory(dirPath: string) {
  try {
    ElMessageBox.close();
    setTimeout(async () => {
      try {
        const response = await fetch("/api/browse_directory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPath: dirPath }),
        });
        const result = await response.json();
        if (result.success) {
          selectDirectoryDialog(result);
        } else if (result.error) {
          ElMessage.error(result.error);
        }
      } catch (error) {
        ElMessage.error(`${$t('@67CE7:浏览目录失败: ')}${(error as Error).message}`);
      }
    }, 100);
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:处理目录选择时出错: ')}${(error as Error).message}`);
  }
}
</script>

<template>
  <div id="directory-selector" class="directory-selector">
    <div class="directory-display cursor-pointer" :title="currentDirectory" @click="onOpenDialog">
      {{ currentDirectory }}
    </div>
    <div class="directory-actions flex">
      <el-tooltip
        :content="$t('@67CE7:在资源管理器中打开')"
        placement="top"
        effect="dark"
        :show-after="200"
      >
        <button class="modern-btn btn-icon-28" @click="onOpenExplorer">
          <el-icon class="btn-icon"><FolderOpened /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip
        content="在终端中打开"
        placement="top"
        effect="dark"
        :show-after="200"
      >
        <button class="modern-btn btn-icon-28" @click="onOpenTerminal">
          <el-icon class="btn-icon"><Monitor /></el-icon>
        </button>
      </el-tooltip>
      <el-tooltip
        v-if="hasNpmScripts"
        content="NPM 脚本"
        placement="top"
        effect="dark"
        :show-after="200"
      >
        <button class="modern-btn btn-icon-28 npm-btn" @click="onToggleNpmPanel">
          <img src="@/assets/images/npm-logo.png" alt="npm" class="btn-icon" style="width: 16px; height: 16px;" />
        </button>
      </el-tooltip>
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
      <div class="directory-footer">
        <div class="footer-actions">
          <button
            type="button"
            class="footer-btn cancel-btn"
            @click="isDirectoryDialogVisible = false"
          >
            {{ $t('@67CE7:取消') }}
          </button>
          <button
            type="button"
            class="footer-btn primary-btn"
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
</template>

<style scoped>
.directory-selector {
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  border-radius: 4px;
  padding: 0px;
  gap: 8px;
  /* border: 1px solid var(--border-component);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05); */
  flex-shrink: 0;
  transition: all 0.2s ease;
}

.directory-selector:hover {
  background: var(--border-component);
}

.directory-display {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
  background-color: var(--bg-container);
  /* padding: 4px 8px; */
  border-radius: 3px;
  border-left: 3px solid #409eff;
  border: 1px solid var(--border-component);
  flex: 1;
  min-width: 0;
}

/* 对话框样式（复用 App.vue 中样式） */
.directory-content {
  padding: 8px 0;
}

.form-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--color-text-title);
}

.label-icon {
  font-size: 16px;
  color: #6b7280;
}

.directory-input-group {
  width: 100%;
  display: flex;
  gap: 8px;
  align-items: stretch;
}

.directory-input-group .modern-input {
  flex: 1;
}

.browse-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 16px;
  border: none;
  border-radius: 6px;
  background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  min-height: 40px;
}

.browse-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(52, 152, 219, 0.35);
}

.browse-btn:active {
  transform: translateY(0);
}

.recent-directories {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.recent-dir-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.recent-dir-item:hover {
  background: var(--bg-input-hover);
  border-color: var(--border-card-hover);
  transform: translateX(2px);
}

.dir-icon {
  font-size: 16px;
  color: #3498db;
  flex-shrink: 0;
  margin-right: 0;
}

.dir-path {
  font-size: 13px;
  color: var(--color-text-title);
  font-family: "Courier New", monospace;
  word-break: break-all;
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  flex: 1;
  min-width: 0;
}
.directory-footer {
  display: flex;
  justify-content: flex-end;
  padding: 0;
}

/* footer-actions 和 footer-btn 基础样式已移至 @/styles/common.scss */

.footer-btn {
  font-size: 13px; /* 此组件需要稍小的字号 */
}

.primary-btn {
  background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
  color: white;
  box-shadow: 0 2px 6px rgba(52, 152, 219, 0.25);
}
.primary-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(52, 152, 219, 0.35);
}
.primary-btn:active {
  transform: translateY(0);
}

/* 目录浏览器 MessageBox 全局类名的内容容器（仍可利用） */
.directory-browser {
  width: 100%;
  height: 400px;
  overflow: auto;
}
.current-path {
  padding: 10px;
  background-color: var(--bg-panel);
  border-radius: 4px;
  margin-bottom: 10px;
  border: 1px solid var(--border-card);
  display: flex;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
}
.path-label {
  font-weight: bold;
  margin-right: 5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.path-value {
  font-family: monospace;
  word-break: break-all;
  flex: 1;
  min-width: 0;
  background-color: var(--bg-container);
  padding: 5px 8px;
  border-radius: 3px;
  border: 1px solid var(--border-card);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
  width: 100%;
}
.directory-list {
  list-style: none !important;
  padding: 0;
  margin: 0;
  border: 1px solid var(--border-card);
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  background-color: var(--bg-container);
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}
.directory-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-card);
  cursor: pointer;
  display: flex;
  align-items: center;
  transition: all 0.2s ease;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  list-style: none !important;
}
.directory-item:hover {
  background-color: #ecf5ff;
}
.directory-item:last-child {
  border-bottom: none;
}
.parent-dir {
  background-color: var(--bg-panel);
  font-weight: 500;
}
.dir-name {
  display: flex;
  align-items: center;
  font-size: 14px;
  line-height: 1.4;
}
.folder-icon {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
  transition: all 0.2s ease;
}

.directory-item:hover .folder-icon {
  transform: scale(1.1);
}

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
<!-- 添加全局样式，确保能影响body下的弹窗 -->
<style lang="scss">
/* 目录浏览器全局样式（使用嵌套写法） */
.directory-browser-dialog {
  border-radius: 8px;
  overflow: hidden;

  .el-message-box__header {
    background-color: var(--bg-panel);
    padding: 15px 20px;
    border-bottom: 1px solid var(--border-card);
    position: relative;
  }

  .el-message-box__title {
    color: #409EFF;
    font-weight: 500;
    font-size: 18px;
  }

  .el-message-box__headerbtn {
    position: absolute;
    top: 15px;
    right: 15px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background-color: rgba(0, 0, 0, 0.05);
    transition: all 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      background-color: rgba(0, 0, 0, 0.1);
      transform: rotate(90deg);

      .el-message-box__close {
        color: #409EFF;
      }
    }

    .el-message-box__close {
      color: var(--text-secondary);
      font-weight: bold;
      font-size: 16px;
    }
  }

  .el-message-box__content {
    padding: 20px;
  }

  .el-message-box__btns {
    padding: 10px 20px 15px;
    border-top: 1px solid var(--border-card);
  }

  /* 对话框内部内容区域 */
  .directory-browser {
    width: 100%;
    height: 400px;
    overflow: auto;
  }

  .current-path {
    padding: 10px;
    background-color: var(--bg-panel);
    border-radius: 4px;
    margin-bottom: 10px;
    border: 1px solid var(--border-card);
    display: flex;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
  }

  .path-label {
    font-weight: bold;
    margin-right: 5px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .path-value {
    font-family: monospace;
    word-break: break-all;
    flex: 1;
    min-width: 0;
    background-color: var(--bg-container);
    padding: 5px 8px;
    border-radius: 3px;
    border: 1px solid var(--border-card);
    box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.05);
    width: 100%;
  }

  .directory-list {
    list-style: none !important;
    padding: 0;
    margin: 0;
    border: 1px solid var(--border-card);
    border-radius: 4px;
    max-height: 300px;
    overflow-y: auto;
    background-color: var(--bg-container);
    display: flex;
    flex-direction: column;
    width: 100%;
    box-sizing: border-box;
  }

  .directory-item {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-card);
    cursor: pointer;
    display: flex;
    align-items: center;
    transition: all 0.2s ease;
    position: relative;
    width: 100%;
    box-sizing: border-box;
    list-style: none !important; // 确保列表项没有项目符号

    &:hover {
      background-color: #ecf5ff;
    }

    &:last-child {
      border-bottom: none;
    }

    .dir-icon {
      margin-right: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      flex-shrink: 0;
    }

    .dir-name {
      display: flex;
      align-items: center;
      font-size: 14px;
      line-height: 1.4;
    }

    .folder-icon {
      filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1));
      transition: all 0.2s ease;
    }

    &:hover .folder-icon {
      transform: scale(1.1);
    }
  }

  .parent-dir {
    background-color: var(--bg-panel);
    font-weight: 500;
  }
}
</style>
