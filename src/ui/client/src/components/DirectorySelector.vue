<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<script setup lang="ts">
import { $t } from '@/lang/static'
import CommonDialog from "@components/CommonDialog.vue";
import { FilePickerModal as FilePicker } from 'local-file-picker/client';
import { ElMessage, ElPopover } from "element-plus";
import { Folder, FolderOpened, Clock, Monitor, Warning } from "@element-plus/icons-vue";
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useConfigStore } from "@/stores/configStore";
import { useGitStore } from "@/stores/gitStore";
import { useLocaleStore } from "@/stores/localeStore";
import { useToolsStore } from "@/stores/toolsStore";
import { storeToRefs } from "pinia";
import IconButton from "@components/IconButton.vue";
import SvgIcon from "@components/SvgIcon/index.vue";
import claudeCodeIcon from "@/assets/icons/svg/claudecode-color.svg";
import { getFolderNameFromPath } from "@/utils/path";

const props = withDefaults(defineProps<{
  variant?: 'default' | 'header'
}>(), {
  variant: 'default'
})

// 使用 store
const configStore = useConfigStore();
const gitStore = useGitStore();
const toolsStore = useToolsStore();
const { currentLocale } = storeToRefs(useLocaleStore());

// 从 store 中获取当前目录
const currentDirectory = computed(() => configStore.currentDirectory);

// 获取当前文件夹名称（用于显示）
const currentFolderName = computed(() => getFolderNameFromPath(currentDirectory.value));

// 当前是否为深色主题
const isDark = computed(() => {
  const t = configStore.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
})

// 右键复制目录路径
async function onCopyDirectory() {
  if (!currentDirectory.value) return;
  try {
    await navigator.clipboard.writeText(currentDirectory.value);
    ElMessage.success($t('@67CE7:已复制目录路径'));
  } catch {
    ElMessage.error($t('@67CE7:复制失败'));
  }
}

// 对话框与状态
const isDirectoryDialogVisible = ref(false);
const newDirectoryPath = ref("");
const isChangingDirectory = ref(false);
const recentDirectories = ref<{ path: string; exists: boolean }[]>([]);
const isBrowserDialogVisible = ref(false);

// 定义emits
defineEmits<{
  toggleNpmPanel: []
  toggleCustomCmdsPanel: []
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
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch("/api/open_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success($t('@67CE7:已在文件管理器中打开目录'));
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
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch('/api/open-directory-with-vscode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success($t('@67CE7:已用 VSCode 打开目录'));
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 用 Claude Code 打开当前目录
// permissionMode 可选：透传到 claude CLI（例：'acceptEdits' = 完全批准）
async function onOpenInClaudeCode(permissionMode?: string) {
  // 触发时也顺手关掉右键菜单
  closeClaudeMenu()
  try {
    if (!currentDirectory.value) {
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch('/api/open-directory-with-claude-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: currentDirectory.value,
        ...(permissionMode ? { permissionMode } : {})
      }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success(result.message || $t('@67CE7:已用 Claude Code 打开目录'));
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 用 Codex 打开当前目录
async function onOpenInCodex() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch('/api/open-directory-with-codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success(result.message || $t('@67CE7:已用 Codex 打开目录'));
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 用 OpenCode 打开当前目录
async function onOpenInOpencode() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch('/api/open-directory-with-opencode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success(result.message || $t('@67CE7:已用 OpenCode 打开目录'));
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 右键菜单（el-popover manual 模式）—— 避开 el-dropdown 在 el-tooltip 嵌套下的 contextmenu 失效问题
const claudeMenuVisible = ref(false)
const claudeTriggerRef = ref<HTMLElement | null>(null)

function openClaudeMenu() {
  // @contextmenu.prevent 已经阻止了浏览器默认菜单
  claudeMenuVisible.value = !claudeMenuVisible.value
}
function pickClaudeMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions') {
  claudeMenuVisible.value = false
  if (mode === 'default') {
    onOpenInClaudeCode()
  } else {
    onOpenInClaudeCode(mode)
  }
}
// 关闭菜单（在选完菜单项、左键点击 trigger、或点击外部时调用）
function closeClaudeMenu() {
  if (claudeMenuVisible.value) claudeMenuVisible.value = false
}

// manual trigger 下"点外面关闭"要自己挂 document 监听：
// - target 在 trigger 内 → 不关（避免和右键 toggle / 左键 click 冲突）
// - target 在 popover 内容内（teleport 到 body）→ 不关
// - 否则 → 关闭
function onDocumentMouseDown(e: MouseEvent) {
  if (!claudeMenuVisible.value) return
  const target = e.target as Node | null
  if (!target) return
  if (claudeTriggerRef.value && claudeTriggerRef.value.contains(target)) return
  const popoverEl = document.querySelector('.claude-menu-popover')
  if (popoverEl && popoverEl.contains(target)) return
  claudeMenuVisible.value = false
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  // 监听全局事件:非 Git 仓库空态里的"打开其他目录"按钮通过这个事件弹出对话框,
  // 复用此处唯一的对话框实例,避免在 GitStatus.vue 再造一份。
  window.addEventListener('zen-gitsync:open-directory-dialog', onOpenDialog as EventListener)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  window.removeEventListener('zen-gitsync:open-directory-dialog', onOpenDialog as EventListener)
})

// 在终端中打开当前目录
async function onOpenTerminal() {
  try {
    if (!currentDirectory.value) {
      ElMessage.warning($t('@67CE7:当前目录路径为空'));
      return;
    }
    const response = await fetch("/api/open_terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentDirectory.value }),
    });
    const result = await response.json();
    if (result.success) {
      ElMessage.success($t('@67CE7:已在终端中打开目录'));
    } else if (result.error) {
      ElMessage.error(result.error);
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开终端失败: ')}${(error as Error).message}`);
  }
}

// npm脚本检查已移至NpmScriptsPanel中，点击按钮时按需加载

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

// 删除最近目录
async function removeRecentDirectory(dirPath: string, event: MouseEvent) {
  event.stopPropagation();
  try {
    const response = await fetch('/api/remove_recent_directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    const result = await response.json();
    if (result.success) {
      await getRecentDirectories();
    }
  } catch (error) {
    console.error('删除目录失败:', error);
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
    ElMessage.warning($t('@67CE7:目录路径不能为空'));
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
      ElMessage.success($t('@67CE7:已切换工作目录'));
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
      

      // 直接更新 store 状态
      configStore.setCurrentDirectory(result.directory);
      gitStore.isGitRepo = result.isGitRepo;

      // 切换目录后强制重新加载配置
      await configStore.loadConfig(true);

      // 重新加载配置后 layout 已按当前项目挑选(layoutsByProject[cwd]),
      // 需要派发 ui-layout-reset 让 App.vue 把新的 ui.layout 写回 DOM(grid-template)。
      // App.vue 只在初始 mount 时调过一次 loadLayoutRatios,切项目不会自动重应用。
      window.dispatchEvent(new Event('ui-layout-reset'));
      
      if (result.isGitRepo) {
        // 并行加载基本信息
        // 切目录时强制刷分支状态(force=true),hasUpstream / upstreamBranch
        // / branchAhead / branchBehind 否则会保留上一个项目的脏值
        // (上次 getBranchStatus 调用缓存在 5s 内不会重拉,见 branchStatus.js)
        await Promise.all([
          gitStore.getCurrentBranch(),
          gitStore.getAllBranches(),
          gitStore.getUserInfo(),
          gitStore.getRemoteUrl(),
          gitStore.getBranchStatus(true)
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
      ElMessage.error(result.error || $t('@67CE7:切换目录失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:切换目录失败: ')}${(error as Error).message}`);
  } finally {
    isChangingDirectory.value = false;
  }
}

// 新开 cmd 标签并在目标路径执行 g ui
async function openNewTabGui() {
  if (!newDirectoryPath.value) {
    ElMessage.warning($t('@67CE7:目录路径不能为空'));
    return;
  }
  try {
    const response = await fetch('/api/open-new-tab-gui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newDirectoryPath.value }),
    });
    const result = await response.json();
    if (!result.success) {
      ElMessage.error(result.error || $t('@67CE7:打开失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 检测是否 Mac(用于 title 提示)
const isMac = computed(() => {
  if (typeof navigator === 'undefined') return false
  // 优先用 userAgentData(Chrome 新 API),fallback 到 platform
  const uaData = (navigator as any).userAgentData
  if (uaData?.platform) return /mac/i.test(uaData.platform)
  return /mac/i.test(navigator.platform || '')
})

// 在常用目录卡片上 Ctrl/Cmd + 点击 → 直接用新标签打开
async function openRecentDirInNewTab(dirPath: string) {
  if (!dirPath) return;
  try {
    const response = await fetch('/api/open-new-tab-gui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    });
    const result = await response.json();
    if (!result.success) {
      ElMessage.error(result.error || $t('@67CE7:打开失败'));
    }
  } catch (error) {
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${(error as Error).message}`);
  }
}

// 常用目录卡片点击: Ctrl/Cmd 点击 = 新标签打开,普通点击 = 填到输入框
function onRecentDirClick(item: { path: string; exists: boolean }, event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    if (!item.exists) {
      ElMessage.warning($t('@67CE7:目录不存在,无法打开'));
      return;
    }
    openRecentDirInNewTab(item.path);
  } else {
    newDirectoryPath.value = item.path;
  }
}

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
    <button
      type="button"
      class="directory-display"
      :title="$t('@67CE7:切换工作目录') + '\n' + currentDirectory"
      :aria-label="$t('@67CE7:切换工作目录: {path}', { path: currentDirectory })"
      @click="onOpenDialog"
      @contextmenu.prevent="onCopyDirectory"
    >
      {{ currentFolderName }}
    </button>
    <div class="directory-actions flex">
      <IconButton
        :tooltip="$t('@67CE7:切换工作目录')"
        :aria-label="$t('@67CE7:切换工作目录')"
        size="large"
        @click="onOpenDialog"
      >
        <el-icon aria-hidden="true"><Folder /></el-icon>
      </IconButton>
      <IconButton
        :tooltip="$t('@67CE7:在资源管理器中打开')"
        :aria-label="$t('@67CE7:在资源管理器中打开')"
        size="large"
        @click="onOpenExplorer"
      >
        <el-icon aria-hidden="true"><FolderOpened /></el-icon>
      </IconButton>
      <IconButton
        :tooltip="$t('@67CE7:在终端中打开')"
        :aria-label="$t('@67CE7:在终端中打开')"
        size="large"
        @click="onOpenTerminal"
      >
        <el-icon aria-hidden="true"><Monitor /></el-icon>
      </IconButton>
      <IconButton
        v-if="toolsStore.vscodeAvailable"
        :tooltip="$t('@67CE7:用 VSCode 打开')"
        :aria-label="$t('@67CE7:用 VSCode 打开')"
        size="large"
        @click="onOpenInVscode"
      >
        <svg-icon icon-class="vscode" />
      </IconButton>
      <IconButton
        v-if="toolsStore.codexAvailable"
        :tooltip="$t('@67CE7:用 Codex 打开')"
        :aria-label="$t('@67CE7:用 Codex 打开')"
        size="large"
        @click="onOpenInCodex"
      >
        <svg-icon icon-class="codex" />
      </IconButton>
      <IconButton
        v-if="toolsStore.opencodeAvailable"
        :tooltip="$t('@67CE7:用 OpenCode 打开')"
        :aria-label="$t('@67CE7:用 OpenCode 打开')"
        size="large"
        @click="onOpenInOpencode"
      >
        <svg-icon icon-class="opencode" />
      </IconButton>
      <!--
        用 Claude Code 打开：左键 = 默认；右键 = 弹出菜单（默认 / 完全批准）。
        用 el-popover + manual trigger 自己接管右键事件，绕开 el-dropdown contextmenu
        在 IconButton(el-tooltip) 嵌套下的失效问题。
      -->
      <el-popover
        v-if="toolsStore.claudeAvailable"
        :visible="claudeMenuVisible"
        :trigger="('manual' as any)"
        placement="bottom-end"
        :width="220"
        :show-arrow="false"
        popper-class="claude-menu-popover"
      >
        <template #reference>
          <span
            ref="claudeTriggerRef"
            class="claude-code-trigger"
            @contextmenu.prevent.stop="openClaudeMenu"
          >
            <IconButton
              :tooltip="$t('@67CE7:用 Claude Code 打开（完全批准）')"
              :aria-label="$t('@67CE7:用 Claude Code 打开（完全批准）')"
              size="large"
              @click="onOpenInClaudeCode('bypassPermissions')"
            >
              <img
                :src="claudeCodeIcon"
                :alt="$t('@67CE7:Claude Code')"
                class="claude-code-btn__icon"
              />
            </IconButton>
          </span>
        </template>
        <ul class="claude-menu" role="menu" :aria-label="$t('@67CE7:Claude Code 启动模式')">
          <li
            class="claude-menu__item"
            role="menuitem"
            tabindex="-1"
            @click="pickClaudeMode('default')"
            @keydown.enter.prevent="pickClaudeMode('default')"
            @keydown.space.prevent="pickClaudeMode('default')"
          >
            <span class="claude-menu__label">{{ $t('@67CE7:用 Claude Code 打开') }}</span>
            <span class="claude-menu__hint">{{ $t('@67CE7:默认权限') }}</span>
          </li>
          <li
            class="claude-menu__item claude-menu__item--accent"
            role="menuitem"
            tabindex="-1"
            @click="pickClaudeMode('acceptEdits')"
            @keydown.enter.prevent="pickClaudeMode('acceptEdits')"
            @keydown.space.prevent="pickClaudeMode('acceptEdits')"
          >
            <span class="claude-menu__label">{{ $t('@67CE7:用 Claude Code 打开') }}</span>
            <span class="claude-menu__hint">批准文件编辑</span>
          </li>
          <li
            class="claude-menu__item claude-menu__item--danger"
            role="menuitem"
            @click="pickClaudeMode('bypassPermissions')"
          >
            <span class="claude-menu__label">
              用 Claude Code 打开
              <el-icon class="claude-menu__warn"><Warning /></el-icon>
            </span>
            <span class="claude-menu__hint">真·完全批准（含 Shell）</span>
          </li>
        </ul>
      </el-popover>
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
              v-for="(item, index) in recentDirectories"
              :key="index"
              class="recent-dir-item"
              :class="{ 'recent-dir-item--missing': !item.exists }"
              :title="(isMac ? '按住 ⌘ 点击用新标签打开' : '按住 Ctrl 点击用新标签打开') + '\n' + item.path"
              @click="onRecentDirClick(item, $event)"
            >
              <el-icon class="dir-icon"><Folder /></el-icon>
              <span class="dir-path" :title="item.path">{{ item.path }}</span>
              <span v-if="!item.exists" class="dir-missing-badge">不存在</span>
              <button
                type="button"
                class="dir-delete-btn"
                title="从常用目录中移除"
                @click="removeRecentDirectory(item.path, $event)"
              >
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" width="12" height="12">
                  <path fill="currentColor" d="M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z"/>
                </svg>
              </button>
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
          <button
            type="button"
            class="dialog-newtab-btn"
            @click="openNewTabGui()"
          >
            <span>使用新标签打开</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>

  <!-- 目录浏览器弹窗 -->
  <FilePicker
    :visible="isBrowserDialogVisible"
    mode="directory"
    :theme="isDark ? 'dark' : 'light'"
    :locale="currentLocale"
    @close="isBrowserDialogVisible = false"
    @confirm="(paths: string[]) => { onBrowserSelect(paths[0]); isBrowserDialogVisible = false }"
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
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
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
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 8px;
  transition: background 0.15s, color 0.15s;
  /* 按钮重置:继承 div 视觉,但移除浏览器默认样式 */
  border: none;
  background: transparent;
  text-align: left;
  appearance: none;
}

.directory-display:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.directory-display:hover {
  background: rgba(59, 130, 246, 0.1);
  color: var(--color-primary, #3b82f6);
}

[data-theme="dark"] .directory-display:hover {
  background: rgba(96, 165, 250, 0.12);
  color: #60a5fa;
}

.claude-code-btn__icon {
  width: 22px;
  height: 22px;
  display: block;
  object-fit: contain;
  flex-shrink: 0;
  -webkit-user-drag: none;
}

/* 右键菜单触发器：包裹 IconButton，统一处理 contextmenu */
.claude-code-trigger {
  display: inline-flex;
  align-items: center;
}

/* 右键弹出的菜单（el-popover 内容） */
.claude-menu {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary);
}

.claude-menu__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.15s ease;
}

.claude-menu__item:hover {
  background-color: rgba(64, 158, 255, 0.12);
}

.claude-menu__item:active {
  background-color: rgba(64, 158, 255, 0.2);
}

.claude-menu__label {
  font-weight: 500;
  color: var(--text-primary);
}

.claude-menu__hint {
  font-size: 11px;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
}

.claude-menu__item--accent .claude-menu__hint {
  color: var(--color-primary, #409eff);
  font-weight: 600;
}

.claude-menu__item--danger .claude-menu__label {
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.claude-menu__warn {
  color: #e6a23c;
  font-size: 13px;
  vertical-align: middle;
}

.claude-menu__item--danger .claude-menu__hint {
  color: #e6a23c;
  font-weight: 600;
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
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: 10px var(--spacing-md);
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.recent-dir-item:hover {
  background: var(--bg-input-hover);
  border-color: var(--border-card-hover);
}

.recent-dir-item:active {
  background: var(--bg-input-active, var(--bg-input-hover));
  transform: scale(0.98);
}

.recent-dir-item--missing {
  opacity: 0.45;
  border-style: dashed;
}

.recent-dir-item--missing .dir-icon {
  color: var(--color-text-secondary, #888);
}

.dir-missing-badge {
  font-size: 10px;
  color: #f87171;
  border: 1px solid #f87171;
  border-radius: 3px;
  padding: 1px 4px;
  flex-shrink: 0;
  line-height: 1.4;
}

.dir-delete-btn {
  position: absolute;
  top: -8px;
  right: -8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: var(--bg-input, #fff);
  border: 1px solid var(--border-card);
  border-radius: 50%;
  color: var(--color-text-secondary, #888);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
  z-index: 1;
}

.recent-dir-item:hover .dir-delete-btn {
  opacity: 1;
}

.dir-delete-btn:hover {
  background: #fee2e2;
  border-color: #f87171;
  color: #f87171;
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

