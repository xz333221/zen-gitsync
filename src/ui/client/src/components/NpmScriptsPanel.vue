<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { FolderOpened } from '@element-plus/icons-vue';
import { $t } from '@/lang/static';
import NpmSettingsDialog from './NpmSettingsDialog.vue';

interface PackageInfo {
  path: string;
  relativePath: string;
  name: string;
  scripts: Record<string, string>;
  repository?: {
    type: string;
    url: string;
  } | string;
}

// Props
const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: []
}>();

// 状态
const packages = ref<PackageInfo[]>([]);
const isLoading = ref(false);
const expandedPackages = ref<Set<string>>(new Set());

// 设置对话框
const showSettingsDialog = ref(false);
const selectedPackagePath = ref('');
const selectedPackageInfo = ref<PackageInfo | null>(null);

function openSettings(pkg: PackageInfo) {
  selectedPackagePath.value = pkg.path;
  selectedPackageInfo.value = pkg;
  showSettingsDialog.value = true;
}

function closeSettings() {
  showSettingsDialog.value = false;
  selectedPackagePath.value = '';
  selectedPackageInfo.value = null;
}

// 设置完成后刷新
function handleSettingsComplete() {
  closeSettings();
  loadNpmScripts();
}

// 解析repository URL
function getRepositoryUrl(repository: PackageInfo['repository']): string | null {
  if (!repository) return null;
  
  if (typeof repository === 'string') {
    return repository;
  }
  
  if (typeof repository === 'object' && repository.url) {
    let url = repository.url;
    // 移除 git+ 前缀
    url = url.replace(/^git\+/, '');
    // 移除 .git 后缀
    url = url.replace(/\.git$/, '');
    return url;
  }
  
  return null;
}

// 打开仓库链接
function openRepository(pkg: PackageInfo) {
  const url = getRepositoryUrl(pkg.repository);
  if (url) {
    window.open(url, '_blank');
  }
}

// 高度调节
const panelHeight = ref(300);
const isResizing = ref(false);
const startY = ref(0);
const startHeight = ref(0);

function startResize(e: MouseEvent) {
  isResizing.value = true;
  startY.value = e.clientY;
  startHeight.value = panelHeight.value;
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  e.preventDefault();
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value) return;
  const deltaY = startY.value - e.clientY;
  const newHeight = Math.max(200, Math.min(600, startHeight.value + deltaY));
  panelHeight.value = newHeight;
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
}

// 加载npm脚本
async function loadNpmScripts() {
  const startTime = Date.now();
  console.log('[NPM面板] 开始加载npm脚本...');
  
  try {
    isLoading.value = true;
    
    // 创建 AbortController 用于超时控制
    const abortController = new AbortController();
    const SCAN_TIMEOUT = 30000; // 30秒超时
    
    // 设置超时定时器
    const timeoutId = setTimeout(() => {
      abortController.abort();
      console.warn(`[NPM面板] 超时${SCAN_TIMEOUT}ms，中断请求`);
    }, SCAN_TIMEOUT);
    
    console.log(`[NPM面板] 发起请求到后端（超时${SCAN_TIMEOUT}ms）...`);
    const fetchStartTime = Date.now();
    const response = await fetch('/api/scan-npm-scripts', {
      signal: abortController.signal
    });
    
    // 清除超时定时器
    clearTimeout(timeoutId);
    const fetchTime = Date.now() - fetchStartTime;
    console.log(`[NPM面板] 后端响应完成，耗时${fetchTime}ms`);
    
    const parseStartTime = Date.now();
    const result = await response.json();
    const parseTime = Date.now() - parseStartTime;
    console.log(`[NPM面板] JSON解析完成，耗时${parseTime}ms`);
    
    if (result.success) {
      // 如果扫描被取消，不更新数据
      if (result.cancelled) {
        console.log(`[NPM面板] 扫描被取消，总耗时${Date.now() - startTime}ms`);
        return;
      }
      
      packages.value = result.packages;
      // // 默认展开所有包
      // packages.value.forEach(pkg => {
      //   expandedPackages.value.add(pkg.path);
      // });
      
      console.log(`[NPM面板] 加载完成，找到${packages.value.length}个package.json，共${result.totalScripts}个脚本，总耗时${Date.now() - startTime}ms`);
      
      // 如果没有找到任何脚本，显示提示
      if (packages.value.length === 0) {
        console.log('[NPM面板] 未找到包含scripts的package.json');
      }
    } else {
      console.error(`[NPM面板] 加载失败，耗时${Date.now() - startTime}ms`);
      ElMessage.error($t('@NPM01:加载npm脚本失败'));
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      // 超时
      console.warn(`[NPM面板] 请求超时被中断，耗时${Date.now() - startTime}ms`);
      ElMessage.warning('NPM脚本扫描超时，请稍后重试');
    } else {
      console.error(`[NPM面板] 加载失败，耗时${Date.now() - startTime}ms，错误:`, error);
      // 不弹出错误提示，避免打扰用户
    }
  } finally {
    isLoading.value = false;
  }
}

// 切换包展开状态
function togglePackage(packagePath: string) {
  if (expandedPackages.value.has(packagePath)) {
    expandedPackages.value.delete(packagePath);
  } else {
    expandedPackages.value.add(packagePath);
  }
}

// 执行npm脚本
async function runScript(packagePath: string, scriptName: string) {
  try {
    const response = await fetch('/api/run-npm-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packagePath, scriptName })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(`${$t('@NPM01:已在新终端中执行')}: ${scriptName}`);
    } else {
      ElMessage.error(result.error || $t('@NPM01:执行脚本失败'));
    }
  } catch (error) {
    console.error('执行npm脚本失败:', error);
    ElMessage.error(`${$t('@NPM01:执行脚本失败')}: ${(error as Error).message}`);
  }
}

// 监听visible变化，面板打开时加载数据
watch(() => props.visible, (newValue) => {
  if (newValue) {
    loadNpmScripts();
  }
}, { immediate: true });
</script>

<template>
  <div v-if="visible" class="npm-scripts-panel">
    <!-- 调节高度的拖拽条 -->
    <div class="resize-handle" @mousedown="startResize"></div>
    
    <div class="panel-header">
      <div class="header-left">
        <img src="@/assets/images/npm-logo.png" alt="npm" class="npm-icon" />
        <span class="panel-title">{{ $t('@NPM01:NPM 脚本') }}</span>
      </div>
      <div class="header-right">
        <el-tooltip :content="$t('@NPM01:刷新')" placement="bottom" :show-after="300">
          <button class="refresh-btn" @click="loadNpmScripts" :disabled="isLoading">
            <el-icon :class="{ 'is-rotating': isLoading }">
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path fill="currentColor" d="M784.512 230.272v-50.56a32 32 0 1 1 64 0v149.056a32 32 0 0 1-32 32H667.52a32 32 0 1 1 0-64h92.992A320 320 0 1 0 524.8 833.152a320 320 0 0 0 320-320h64a384 384 0 0 1-384 384 384 384 0 0 1-384-384 384 384 0 0 1 643.712-282.88z"/>
              </svg>
            </el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@NPM01:关闭')" placement="bottom" :show-after="300">
          <button class="close-btn" @click="emit('close')">
            <el-icon>
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path fill="currentColor" d="M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z"/>
              </svg>
            </el-icon>
          </button>
        </el-tooltip>
      </div>
    </div>

    <div v-if="isLoading" class="loading-container">
      <el-icon class="is-loading loading-icon">
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"/>
        </svg>
      </el-icon>
      <p class="loading-text">{{ $t('@NPM01:正在扫描项目中的 npm 脚本...') }}</p>
    </div>

    <div v-else-if="packages.length === 0" class="empty-container">
      <svg class="empty-icon" viewBox="0 0 1024 1024" width="64" height="64">
        <path fill="currentColor" d="M832 384H576V128H192v768h640V384zm-26.496-64L640 154.496V320h165.504zM160 64h480l256 256v608a32 32 0 0 1-32 32H160a32 32 0 0 1-32-32V96a32 32 0 0 1 32-32z"/>
      </svg>
      <p class="empty-text">{{ $t('@NPM01:当前项目中未找到包含 scripts 的 package.json') }}</p>
    </div>

    <div v-else class="packages-container" :style="{ maxHeight: panelHeight + 'px' }">
      <div 
        v-for="pkg in packages" 
        :key="pkg.path" 
        class="package-item"
      >
        <div 
          class="package-header"
          @click="togglePackage(pkg.path)"
        >
          <el-icon class="expand-icon" :class="{ expanded: expandedPackages.has(pkg.path) }">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M340.864 149.312a30.592 30.592 0 0 0 0 42.752L652.736 512 340.864 831.872a30.592 30.592 0 0 0 0 42.752 29.12 29.12 0 0 0 41.728 0L714.24 534.336a32 32 0 0 0 0-44.672L382.592 149.376a29.12 29.12 0 0 0-41.728 0z"/>
            </svg>
          </el-icon>
          <el-icon class="folder-icon">
            <FolderOpened />
          </el-icon>
          <div class="package-info">
            <span class="package-name">{{ pkg.name }}</span>
            <span class="package-path">{{ pkg.relativePath }}</span>
          </div>
          <el-tooltip 
            v-if="getRepositoryUrl(pkg.repository)"
            :content="getRepositoryUrl(pkg.repository)!"
            placement="bottom" 
            :show-after="300"
          >
            <el-icon class="repo-icon" @click.stop="openRepository(pkg)">
              <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                <path fill="currentColor" d="M458.64 119.072a84.176 84.176 0 0 1 106.72 0l366.912 300.4a32 32 0 0 1-40.544 49.52L524.816 168.592a20.176 20.176 0 0 0-25.632 0L132.272 468.992a32 32 0 1 1-40.544-49.52L458.64 119.072zM304.32 415.184c0-27.2 22-49.568 49.472-49.568h96.048a49.504 49.504 0 0 1 49.456 49.568v96.544c0 27.2-21.984 49.552-49.456 49.552H353.76a49.504 49.504 0 0 1-49.472-49.552V415.2z m64 14.432v67.68h66.976v-67.68H368.32z m-162.976 36.96a32 32 0 0 1 32 32v307.2c0 21.28 17.12 38.224 37.856 38.224h471.52a38.032 38.032 0 0 0 37.84-38.224v-307.2a32 32 0 1 1 64 0v307.2c0 56.304-45.44 102.224-101.856 102.224H275.2c-56.4 0-101.856-45.92-101.856-102.224v-307.2a32 32 0 0 1 32-32z m98.976 168.048c0-27.216 22-49.568 49.472-49.568h96.048a49.504 49.504 0 0 1 49.456 49.568v96.544c0 27.2-21.984 49.552-49.456 49.552H353.76a49.504 49.504 0 0 1-49.472-49.552v-96.544z m64 14.432v67.68h66.976v-67.68H368.32z m154.288-14.432c0-27.216 21.984-49.568 49.472-49.568h96.048a49.504 49.504 0 0 1 49.456 49.568v96.544c0 27.2-21.984 49.552-49.456 49.552h-96.048a49.504 49.504 0 0 1-49.472-49.552v-96.544z m64 14.432v67.68h66.976v-67.68h-66.976z"/>
              </svg>
            </el-icon>
          </el-tooltip>
          <el-icon class="settings-icon" @click.stop="openSettings(pkg)">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M600.704 64a32 32 0 0 1 30.464 22.208l35.2 109.376c14.784 7.232 28.928 15.36 42.432 24.512l112.384-24.192a32 32 0 0 1 34.432 15.36L944.32 364.8a32 32 0 0 1-4.032 37.504l-77.12 85.12a357.12 357.12 0 0 1 0 49.024l77.12 85.248a32 32 0 0 1 4.032 37.504l-88.704 153.6a32 32 0 0 1-34.432 15.296L708.8 803.904c-13.44 9.088-27.648 17.28-42.368 24.512l-35.264 109.376A32 32 0 0 1 600.704 960H423.296a32 32 0 0 1-30.464-22.208L357.696 828.48a351.616 351.616 0 0 1-42.56-24.64l-112.32 24.256a32 32 0 0 1-34.432-15.36L79.68 659.2a32 32 0 0 1 4.032-37.504l77.12-85.248a357.12 357.12 0 0 1 0-48.896l-77.12-85.248A32 32 0 0 1 79.68 364.8l88.704-153.6a32 32 0 0 1 34.432-15.296L315.2 220.096c13.568-9.152 27.776-17.408 42.56-24.64l35.2-109.312A32 32 0 0 1 423.232 64H600.64zm-23.424 64H446.72l-36.352 113.088-24.512 11.968a294.113 294.113 0 0 0-34.816 20.096l-22.656 15.36-116.224-25.088-65.28 113.152 79.68 88.192-1.92 27.136a293.12 293.12 0 0 0 0 40.192l1.92 27.136-79.808 88.192 65.344 113.152 116.224-25.024 22.656 15.296a294.113 294.113 0 0 0 34.816 20.096l24.512 11.968L446.72 896h130.688l36.48-113.152 24.448-11.904a288.282 288.282 0 0 0 34.752-20.096l22.592-15.296 116.288 25.024 65.28-113.152-79.744-88.192 1.92-27.136a293.12 293.12 0 0 0 0-40.256l-1.92-27.136 79.808-88.128-65.344-113.152-116.288 24.96-22.592-15.232a287.616 287.616 0 0 0-34.752-20.096l-24.448-11.904L577.344 128zM512 320a192 192 0 1 1 0 384 192 192 0 0 1 0-384zm0 64a128 128 0 1 0 0 256 128 128 0 0 0 0-256z"/>
            </svg>
          </el-icon>
        </div>

        <div 
          v-if="expandedPackages.has(pkg.path)" 
          class="scripts-list"
        >
          <div 
            v-for="(command, scriptName) in pkg.scripts"
            :key="scriptName"
            class="script-item"
            @click="runScript(pkg.path, scriptName)"
          >
            <div class="script-left">
              <el-icon class="play-icon">
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
                  <path fill="currentColor" d="M719.4 499.1l-296.1-215A15.9 15.9 0 0 0 398 297v430c0 13.1 14.8 20.5 25.3 12.9l296.1-215a15.9 15.9 0 0 0 0-25.8zm-257.6 134V390.9L628.5 512 461.8 633.1z"/>
                </svg>
              </el-icon>
              <span class="script-name">{{ scriptName }}</span>
            </div>
            <span class="script-command">{{ command }}</span>
          </div>
        </div>
      </div>
    </div>
    
    <!-- 设置对话框 -->
    <NpmSettingsDialog 
      v-if="selectedPackageInfo"
      :visible="showSettingsDialog"
      :package-info="selectedPackageInfo"
      @close="closeSettings"
      @complete="handleSettingsComplete"
    />
  </div>
</template>

<style scoped>
.npm-scripts-panel {
  position: relative;
  background: var(--bg-container);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-lg);
  margin-top: var(--spacing-md);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  cursor: ns-resize;
  z-index: 10;
  transition: background 0.2s ease;
}

.resize-handle::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 40px;
  height: 3px;
  border-radius: var(--radius-xs);
  background: transparent;
  transition: background 0.2s ease;
}

.resize-handle:hover::before {
  background: rgba(102, 126, 234, 0.4);
}

.resize-handle:active::before {
  background: rgba(102, 126, 234, 0.7);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px var(--spacing-md);
  background: var(--bg-input);
  border-bottom: 1px solid var(--border-card);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.npm-icon {
  width: 18px;
  height: 18px;
  object-fit: contain;
}

.panel-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text);
}

.package-count {
  font-size: 11px;
  color: var(--text-secondary);
  padding: var(--spacing-xs) 6px;
  background: var(--bg-container);
  border-radius: 10px;
  border: 1px solid var(--border-card);
}

.header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.refresh-btn,
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.refresh-btn:hover,
.close-btn:hover {
  background: var(--bg-container);
  color: var(--color-text);
}

.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.is-rotating {
  animation: rotating 1s linear infinite;
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.loading-container,
.empty-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px var(--spacing-2xl);
  gap: var(--spacing-md);
}

.loading-icon {
  font-size: 32px;
  color: #667eea;
}

.loading-text,
.empty-text {
  
  color: var(--text-secondary);
  margin: 0;
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: var(--spacing-base);
}

.packages-container {
  padding: var(--spacing-base);
  overflow-y: auto;
  transition: max-height 0.1s ease;
}

.package-item {
  margin-bottom: var(--spacing-base);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  overflow: hidden;
  transition: all 0.2s ease;
}

.package-item:last-child {
  margin-bottom: 0;
}

.package-header {
  display: flex;
  align-items: center;
  padding: var(--spacing-base) var(--spacing-md);
  background: var(--bg-input);
  cursor: pointer;
  transition: all 0.2s ease;
  gap: var(--spacing-base);
}

.package-header:hover {
  background: var(--bg-input-hover);
}

.expand-icon {
  
  color: var(--text-secondary);
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.folder-icon {
  font-size: var(--font-size-lg);
  color: #667eea;
}

.package-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  /* flex-direction: column; */
  flex: 1;
  min-width: 0;
}

.package-name {
  
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  flex-shrink: 0;
}

.package-path {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.repo-icon,
.settings-icon {
  font-size: var(--font-size-md);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  margin-left: var(--spacing-base);
  flex-shrink: 0;
  opacity: 0;
}

.package-header:hover .repo-icon,
.package-header:hover .settings-icon {
  opacity: 1;
}

.repo-icon:hover {
  color: #667eea;
  transform: scale(1.1);
}

.settings-icon:hover {
  color: #667eea;
  transform: rotate(30deg);
}

.script-count {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  padding: var(--spacing-xs) var(--spacing-base);
  background: rgba(102, 126, 234, 0.1);
  border-radius: 10px;
}

.scripts-list {
  background: var(--bg-container);
  border-top: 1px solid var(--border-card);
  max-height: 300px;
  overflow-y: auto;
  overflow-x: hidden;
}

.script-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 22px 6px var(--spacing-xl);
  cursor: pointer;
  transition: all 0.2s ease;
  gap: var(--spacing-md);
  border-bottom: 1px solid var(--border-card);
}

.script-item:last-child {
  border-bottom: none;
}

.script-item:hover {
  background: var(--bg-input);
}

.script-item:hover .play-icon {
  color: #667eea;
  transform: scale(1.1);
}

.script-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  min-width: 0;
  flex-shrink: 0;
}

.play-icon {
  font-size: var(--font-size-md);
  color: var(--text-secondary);
  transition: all 0.2s ease;
}

.script-name {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
  font-family: monospace;
}

.script-command {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  text-align: right;
}

/* 滚动条样式 */
.packages-container::-webkit-scrollbar {
  width: 8px;
}

.packages-container::-webkit-scrollbar-track {
  background: var(--bg-input);
  border-radius: var(--radius-base);
}

.packages-container::-webkit-scrollbar-thumb {
  background: var(--border-card);
  border-radius: var(--radius-base);
  transition: background 0.2s ease;
}

.packages-container::-webkit-scrollbar-thumb:hover {
  background: var(--border-card-hover);
}

/* 脚本列表滚动条样式 */
.scripts-list::-webkit-scrollbar {
  width: 6px;
}

.scripts-list::-webkit-scrollbar-track {
  background: var(--bg-input);
  border-radius: var(--radius-base);
}

.scripts-list::-webkit-scrollbar-thumb {
  background: var(--border-card);
  border-radius: var(--radius-base);
  transition: background 0.2s ease;
}

.scripts-list::-webkit-scrollbar-thumb:hover {
  background: var(--border-card-hover);
}
</style>
