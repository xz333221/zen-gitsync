<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { FolderOpened } from '@element-plus/icons-vue';
import { $t } from '@/lang/static';

interface PackageInfo {
  path: string;
  relativePath: string;
  name: string;
  scripts: Record<string, string>;
}

// Props
const props = defineProps<{
  visible: boolean;
}>();

// Emits
const emit = defineEmits<{
  close: []
}>();

// 状态
const packages = ref<PackageInfo[]>([]);
const isLoading = ref(false);
const expandedPackages = ref<Set<string>>(new Set());

// 加载npm脚本
async function loadNpmScripts() {
  try {
    isLoading.value = true;
    const response = await fetch('/api/scan-npm-scripts');
    const result = await response.json();
    
    if (result.success) {
      packages.value = result.packages;
      // 默认展开所有包
      packages.value.forEach(pkg => {
        expandedPackages.value.add(pkg.path);
      });
    } else {
      ElMessage.error($t('@NPM01:加载npm脚本失败'));
    }
  } catch (error) {
    console.error('加载npm脚本失败:', error);
    ElMessage.error(`${$t('@NPM01:加载npm脚本失败')}: ${(error as Error).message}`);
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

// 监听visible变化，加载数据
watch(() => props.visible, (newValue) => {
  if (newValue) {
    loadNpmScripts();
  }
}, { immediate: true });
</script>

<template>
  <div v-if="visible" class="npm-scripts-panel">
    <div class="panel-header">
      <div class="header-left">
        <svg class="npm-icon" viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="M0 0v24h24V0M6.6 19.2V4.8h4.8v9.6h2.4V4.8h4.8v14.4"/>
        </svg>
        <span class="panel-title">{{ $t('@NPM01:NPM 脚本') }}</span>
        <span v-if="!isLoading" class="package-count">({{ packages.length }} {{ $t('@NPM01:个包') }})</span>
      </div>
      <div class="header-right">
        <button class="refresh-btn" @click="loadNpmScripts" :disabled="isLoading">
          <el-icon :class="{ 'is-rotating': isLoading }">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M784.512 230.272v-50.56a32 32 0 1 1 64 0v149.056a32 32 0 0 1-32 32H667.52a32 32 0 1 1 0-64h92.992A320 320 0 1 0 524.8 833.152a320 320 0 0 0 320-320h64a384 384 0 0 1-384 384 384 384 0 0 1-384-384 384 384 0 0 1 643.712-282.88z"/>
            </svg>
          </el-icon>
        </button>
        <button class="close-btn" @click="emit('close')">
          <el-icon>
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
              <path fill="currentColor" d="M764.288 214.592 512 466.88 259.712 214.592a31.936 31.936 0 0 0-45.12 45.12L466.752 512 214.528 764.224a31.936 31.936 0 1 0 45.12 45.184L512 557.184l252.288 252.288a31.936 31.936 0 0 0 45.12-45.12L557.12 512.064l252.288-252.352a31.936 31.936 0 1 0-45.12-45.184z"/>
            </svg>
          </el-icon>
        </button>
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

    <div v-else class="packages-container">
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
          <span class="script-count">{{ Object.keys(pkg.scripts).length }} {{ $t('@NPM01:个脚本') }}</span>
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
  </div>
</template>

<style scoped>
.npm-scripts-panel {
  background: var(--bg-container);
  border: 1px solid var(--border-card);
  border-radius: 8px;
  margin-top: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.npm-icon {
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
}

.package-count {
  font-size: 12px;
  opacity: 0.9;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.refresh-btn,
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.15);
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
}

.refresh-btn:hover,
.close-btn:hover {
  background: rgba(255, 255, 255, 0.25);
  transform: translateY(-1px);
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
  padding: 48px 24px;
  gap: 12px;
}

.loading-icon {
  font-size: 32px;
  color: #667eea;
}

.loading-text,
.empty-text {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 8px;
}

.packages-container {
  padding: 8px;
  max-height: 400px;
  overflow-y: auto;
}

.package-item {
  margin-bottom: 8px;
  border: 1px solid var(--border-card);
  border-radius: 6px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.package-item:last-child {
  margin-bottom: 0;
}

.package-header {
  display: flex;
  align-items: center;
  padding: 12px;
  background: var(--bg-input);
  cursor: pointer;
  transition: all 0.2s ease;
  gap: 8px;
}

.package-header:hover {
  background: var(--bg-input-hover);
}

.expand-icon {
  font-size: 14px;
  color: var(--text-secondary);
  transition: transform 0.2s ease;
}

.expand-icon.expanded {
  transform: rotate(90deg);
}

.folder-icon {
  font-size: 18px;
  color: #667eea;
}

.package-info {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.package-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.package-path {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: monospace;
}

.script-count {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 2px 8px;
  background: rgba(102, 126, 234, 0.1);
  border-radius: 10px;
}

.scripts-list {
  background: var(--bg-container);
  border-top: 1px solid var(--border-card);
}

.script-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 40px;
  cursor: pointer;
  transition: all 0.2s ease;
  gap: 12px;
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
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

.play-icon {
  font-size: 16px;
  color: var(--text-secondary);
  transition: all 0.2s ease;
}

.script-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  font-family: monospace;
}

.script-command {
  font-size: 12px;
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
  border-radius: 4px;
}

.packages-container::-webkit-scrollbar-thumb {
  background: var(--border-card);
  border-radius: 4px;
  transition: background 0.2s ease;
}

.packages-container::-webkit-scrollbar-thumb:hover {
  background: var(--border-card-hover);
}
</style>
