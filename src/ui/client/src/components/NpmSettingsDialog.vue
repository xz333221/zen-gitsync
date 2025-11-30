<script setup lang="ts">
import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { $t } from '@/lang/static';
import CommonDialog from './CommonDialog.vue';

interface PackageInfo {
  path: string;
  relativePath: string;
  name: string;
  scripts: Record<string, string>;
  version?: string;
}

const props = defineProps<{
  visible: boolean;
  packageInfo: PackageInfo;
}>();

const emit = defineEmits<{
  close: [];
  complete: [];
}>();

// 功能选项卡
const activeTab = ref('version');

// 版本号增加
const versionType = ref<'major' | 'minor' | 'patch'>('patch');
const isUpdatingVersion = ref(false);

// 脚本管理
const scriptName = ref('');
const scriptCommand = ref('');
const isAddingScript = ref(false);
const editingScriptName = ref(''); // 正在编辑的脚本名称
const isDeletingScript = ref(false);
const isPinningScript = ref(false); // 正在置顶
const isEditMode = ref(false); // 是否处于编辑模式
const scriptNameError = ref('');

// 校验脚本名称
function validateScriptName(name: string): boolean {
  if (!name.trim()) {
    scriptNameError.value = '';
    return false;
  }
  
  // npm脚本名称规则：
  // 1. 不能包含空格
  // 2. 只能包含字母、数字、连字符、冒号、下划线、点号
  // 3. 不能以数字开头
  const validPattern = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;
  
  if (name.includes(' ')) {
    scriptNameError.value = $t('@NPM01:脚本名称不能包含空格');
    return false;
  }
  
  if (!validPattern.test(name)) {
    scriptNameError.value = $t('@NPM01:脚本名称只能包含字母、数字、连字符、冒号、下划线和点号，且不能以数字开头');
    return false;
  }
  
  scriptNameError.value = '';
  return true;
}

// 监听脚本名称变化
function handleScriptNameInput() {
  if (scriptName.value.trim()) {
    validateScriptName(scriptName.value);
  } else {
    scriptNameError.value = '';
  }
}

// 选项
const versionOptions = [
  { label: $t('@NPM01:主版本号 (major)'), value: 'major', desc: '1.0.0 → 2.0.0' },
  { label: $t('@NPM01:次版本号 (minor)'), value: 'minor', desc: '1.0.0 → 1.1.0' },
  { label: $t('@NPM01:修订号 (patch)'), value: 'patch', desc: '1.0.0 → 1.0.1' },
];


// 增加版本号
async function updateVersion() {
  try {
    isUpdatingVersion.value = true;
    
    const response = await fetch('/api/update-npm-version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packagePath: props.packageInfo.path,
        versionType: versionType.value
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(`${$t('@NPM01:版本号已更新')}: ${result.oldVersion} → ${result.newVersion}`);
      emit('complete');
    } else {
      ElMessage.error(result.error || $t('@NPM01:更新版本号失败'));
    }
  } catch (error) {
    console.error('更新版本号失败:', error);
    ElMessage.error($t('@NPM01:更新版本号失败'));
  } finally {
    isUpdatingVersion.value = false;
  }
}

// 添加或更新脚本
async function saveScript() {
  if (!scriptName.value.trim()) {
    ElMessage.warning($t('@NPM01:请输入脚本名称'));
    return;
  }
  
  // 校验脚本名称格式
  if (!validateScriptName(scriptName.value)) {
    ElMessage.warning(scriptNameError.value || $t('@NPM01:脚本名称格式不正确'));
    return;
  }

  if (!scriptCommand.value.trim()) {
    ElMessage.warning($t('@NPM01:请输入脚本命令'));
    return;
  }

  try {
    isAddingScript.value = true;
    
    const apiUrl = isEditMode.value ? '/api/update-npm-script' : '/api/add-npm-script';
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packagePath: props.packageInfo.path,
        scriptName: scriptName.value.trim(),
        scriptCommand: scriptCommand.value.trim(),
        oldScriptName: isEditMode.value ? editingScriptName.value : undefined
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success(isEditMode.value ? $t('@NPM01:脚本已更新') : $t('@NPM01:脚本已添加'));
      cancelEdit();
      emit('complete');
    } else {
      ElMessage.error(result.error || (isEditMode.value ? $t('@NPM01:更新脚本失败') : $t('@NPM01:添加脚本失败')));
    }
  } catch (error) {
    console.error('保存脚本失败:', error);
    ElMessage.error(isEditMode.value ? $t('@NPM01:更新脚本失败') : $t('@NPM01:添加脚本失败'));
  } finally {
    isAddingScript.value = false;
  }
}

// 编辑脚本
function editScript(name: string, command: string) {
  isEditMode.value = true;
  editingScriptName.value = name;
  scriptName.value = name;
  scriptCommand.value = command;
  scriptNameError.value = '';
}

// 取消编辑
function cancelEdit() {
  isEditMode.value = false;
  editingScriptName.value = '';
  scriptName.value = '';
  scriptCommand.value = '';
  scriptNameError.value = '';
}

// 置顶脚本
async function pinScript(name: string) {
  try {
    isPinningScript.value = true;
    
    const response = await fetch('/api/pin-npm-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packagePath: props.packageInfo.path,
        scriptName: name
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success($t('@NPM01:脚本已置顶'));
      emit('complete');
    } else {
      ElMessage.error(result.error || $t('@NPM01:置顶脚本失败'));
    }
  } catch (error) {
    console.error('置顶脚本失败:', error);
    ElMessage.error($t('@NPM01:置顶脚本失败'));
  } finally {
    isPinningScript.value = false;
  }
}

// 删除脚本
async function deleteScript(name: string) {
  try {
    await ElMessageBox.confirm(
      $t('@NPM01:确定要删除脚本') + ` "${name}" ` + $t('@NPM01:吗？'),
      $t('@NPM01:删除脚本'),
      {
        confirmButtonText: $t('@NPM01:确定'),
        cancelButtonText: $t('@NPM01:取消'),
        type: 'warning'
      }
    );

    isDeletingScript.value = true;
    
    const response = await fetch('/api/delete-npm-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packagePath: props.packageInfo.path,
        scriptName: name
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      ElMessage.success($t('@NPM01:脚本已删除'));
      emit('complete');
    } else {
      ElMessage.error(result.error || $t('@NPM01:删除脚本失败'));
    }
  } catch (error) {
    if (error !== 'cancel') {
      console.error('删除脚本失败:', error);
      ElMessage.error($t('@NPM01:删除脚本失败'));
    }
  } finally {
    isDeletingScript.value = false;
  }
}

// 关闭对话框时重置
function handleClose() {
  activeTab.value = 'version';
  versionType.value = 'patch';
  cancelEdit();
  emit('close');
}
</script>

<template>
  <CommonDialog
    :model-value="visible"
    :title="packageInfo.name + ' - ' + $t('@NPM01:NPM 设置')"
    size="medium"
    @close="handleClose"
  >
    <div class="settings-content">
      <!-- 包信息 -->
      <div class="package-info-bar">
        <span class="info-label">{{ $t('@NPM01:包名称') }}:</span>
        <span class="info-value">{{ packageInfo.name }}</span>
        <span class="info-path">{{ packageInfo.relativePath }}</span>
      </div>

      <!-- 功能选项卡 -->
      <el-tabs v-model="activeTab" class="settings-tabs">
        <!-- 版本号增加 -->
        <el-tab-pane :label="$t('@NPM01:版本号管理')" name="version">
          <div class="tab-content">
            <div class="current-version">
              <span class="version-label">{{ $t('@NPM01:当前版本') }}:</span>
              <span class="version-value">{{ packageInfo.version }}</span>
            </div>

            <div class="version-options">
              <label class="option-label">{{ $t('@NPM01:选择要增加的版本号类型') }}:</label>
              <el-radio-group v-model="versionType" class="version-radio-group">
                <el-radio
                  v-for="option in versionOptions"
                  :key="option.value"
                  :value="option.value"
                  border
                  class="version-radio"
                >
                  <div class="radio-content">
                    <span class="radio-label">{{ option.label }}</span>
                    <span class="radio-desc">{{ option.desc }}</span>
                  </div>
                </el-radio>
              </el-radio-group>
            </div>

            <el-button
              type="primary"
              :loading="isUpdatingVersion"
              @click="updateVersion"
              class="action-button"
            >
              {{ $t('@NPM01:更新版本号') }}
            </el-button>
          </div>
        </el-tab-pane>

        <!-- 脚本管理 -->
        <el-tab-pane :label="$t('@NPM01:脚本管理')" name="script">
          <div class="tab-content script-management">
            <!-- 现有脚本列表 -->
            <div class="scripts-list-section">
              <div class="section-header">
                <span class="section-title">{{ $t('@NPM01:当前脚本列表') }}</span>
                <span class="script-count">{{ Object.keys(packageInfo.scripts || {}).length }} {{ $t('@NPM01:个脚本') }}</span>
              </div>
              
              <div v-if="Object.keys(packageInfo.scripts || {}).length === 0" class="empty-scripts">
                <el-empty :description="$t('@NPM01:暂无脚本')" :image-size="80" />
              </div>
              
              <div v-else class="script-items">
                <div 
                  v-for="(command, name) in packageInfo.scripts" 
                  :key="name"
                  class="script-item-card"
                >
                  <div class="script-item-content">
                    <div class="script-name-tag">
                      <el-icon class="script-icon"><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M160 224a64 64 0 0 0-64 64v448a64 64 0 0 0 64 64h704a64 64 0 0 0 64-64V288a64 64 0 0 0-64-64H160zm0-64h704a128 128 0 0 1 128 128v448a128 128 0 0 1-128 128H160A128 128 0 0 1 32 736V288a128 128 0 0 1 128-128z"/><path fill="currentColor" d="m448 327.872 163.2 160-163.2 160-45.248-46.08L502.4 487.872l-99.648-99.84L448 327.872z"/></svg></el-icon>
                      <span class="name-text">{{ name }}</span>
                    </div>
                    <div class="script-command">
                      <code>{{ command }}</code>
                    </div>
                  </div>
                  <div class="script-item-actions">
                    <el-button
                      size="small"
                      text
                      class="pin-button"
                      @click="pinScript(name)"
                      :loading="isPinningScript"
                      title="置顶"
                    >
                      <svg-icon icon-class="pin" class-name="pin-icon" />
                    </el-button>
                    <el-button
                      size="small"
                      type="primary"
                      text
                      @click="editScript(name, command)"
                      :disabled="isEditMode && editingScriptName === name"
                      :title="$t('@NPM01:编辑')"
                    >
                      <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M832 512a32 32 0 1 1 64 0v352a32 32 0 0 1-32 32H160a32 32 0 0 1-32-32V160a32 32 0 0 1 32-32h352a32 32 0 0 1 0 64H192v640h640V512z"/><path fill="currentColor" d="m469.952 554.24 52.8-7.552L847.104 222.4a32 32 0 1 0-45.248-45.248L477.44 501.44l-7.552 52.8zm422.4-422.4a96 96 0 0 1 0 135.808l-331.84 331.84a32 32 0 0 1-18.112 9.088l-139.456 19.904a32 32 0 0 1-36.224-36.224l19.904-139.456a32 32 0 0 1 9.024-18.112l331.904-331.84a96 96 0 0 1 135.808 0z"/></svg></el-icon>
                    </el-button>
                    <el-button
                      size="small"
                      type="danger"
                      text
                      @click="deleteScript(name)"
                      :loading="isDeletingScript"
                      :title="$t('@NPM01:删除')"
                    >
                      <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M160 256H96a32 32 0 0 1 0-64h256V95.936a32 32 0 0 1 32-32h256a32 32 0 0 1 32 32V192h256a32 32 0 1 1 0 64h-64v672a32 32 0 0 1-32 32H192a32 32 0 0 1-32-32V256zm448-64v-64H416v64h192zM224 896h576V256H224v640zm192-128a32 32 0 0 1-32-32V416a32 32 0 0 1 64 0v320a32 32 0 0 1-32 32zm192 0a32 32 0 0 1-32-32V416a32 32 0 0 1 64 0v320a32 32 0 0 1-32 32z"/></svg></el-icon>
                    </el-button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 添加/编辑脚本表单 -->
            <div class="script-form-section">
              <div class="section-header">
                <span class="section-title">{{ isEditMode ? $t('@NPM01:编辑脚本') : $t('@NPM01:添加新脚本') }}</span>
                <el-button v-if="isEditMode" size="small" text @click="cancelEdit">
                  {{ $t('@NPM01:取消编辑') }}
                </el-button>
              </div>
              
              <div class="form-group">
                <div class="form-item">
                  <label class="form-label">{{ $t('@NPM01:脚本名称') }}:</label>
                  <el-input
                    v-model="scriptName"
                    :placeholder="$t('@NPM01:例如: build, dev, test')"
                    :disabled="isEditMode"
                    clearable
                    @input="handleScriptNameInput"
                  />
                  <div v-if="scriptNameError" class="error-tip">
                    <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896zm0 832a384 384 0 1 0 0-768 384 384 0 0 0 0 768zm48-176a48 48 0 1 1-96 0 48 48 0 0 1 96 0zm-48-464a32 32 0 0 1 32 32v288a32 32 0 0 1-64 0V288a32 32 0 0 1 32-32z"/></svg></el-icon>
                    <span>{{ scriptNameError }}</span>
                  </div>
                  <div v-else-if="scriptName.trim() && !isEditMode" class="success-tip">
                    <el-icon><svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M512 64a448 448 0 1 1 0 896 448 448 0 0 1 0-896zm-55.808 536.384-99.52-99.584a38.4 38.4 0 1 0-54.336 54.336l126.72 126.72a38.272 38.272 0 0 0 54.336 0l262.4-262.464a38.4 38.4 0 1 0-54.272-54.336L456.192 600.384z"/></svg></el-icon>
                    <span>{{ $t('@NPM01:脚本名称格式正确') }}</span>
                  </div>
                </div>

                <div class="form-item">
                  <label class="form-label">{{ $t('@NPM01:脚本命令') }}:</label>
                  <el-input
                    v-model="scriptCommand"
                    :placeholder="$t('@NPM01:例如: vite build, vite dev')"
                    clearable
                  />
                </div>
              </div>

              <el-button
                type="primary"
                :loading="isAddingScript"
                :disabled="!scriptName.trim() || !scriptCommand.trim()"
                @click="saveScript"
                class="action-button"
              >
                {{ isEditMode ? $t('@NPM01:更新脚本') : $t('@NPM01:添加脚本') }}
              </el-button>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </CommonDialog>
</template>

<style scoped>
.settings-content {
  padding: var(--spacing-sm) 0;
}

.package-info-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-xl);
}

.info-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
}

.info-value {
  
  font-weight: 600;
  color: var(--color-text);
}

.info-path {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: monospace;
  margin-left: auto;
}

.settings-tabs {
  margin-top: var(--spacing-lg);
}

.script-management {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.scripts-list-section,
.script-form-section {
  border: 1px solid var(--border-component);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  background: var(--bg-panel);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-md);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-card);
}

.section-title {
  
  font-weight: 600;
  color: var(--color-text);
}

.script-count {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  background: var(--bg-input);
  padding: var(--spacing-xs) var(--spacing-base);
  border-radius: var(--radius-base);
}

.empty-scripts {
  padding: var(--spacing-xl) 0;
}

.script-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 400px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: var(--spacing-sm);
}

.script-item-card {
  display: grid;
  grid-template-columns: 1fr 0fr;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-base);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  background: var(--bg-container);
  transition: all 0.3s ease;

  &:hover {
    border-color: var(--color-primary);
    box-shadow: var(--shadow-md);
    grid-template-columns: 1fr auto;
  }
  
  &:hover .script-item-actions {
    opacity: 1;
  }
}

.script-item-content {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 6px;
}

.script-name-tag {
  display: flex;
  align-items: center;
  gap: 6px;
}

.script-icon {
  
  color: var(--color-primary);
}

.name-text {
  
  font-weight: 600;
  color: var(--color-text);
  font-family: monospace;
}

.script-command {
  padding: 6px 10px;
  background: var(--bg-input);
  border-radius: var(--radius-base);
  border: 1px solid var(--border-card);
  
  code {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    word-break: break-all;
  }
}

.script-item-actions {
  display: flex;
  gap: var(--spacing-base);
  flex-shrink: 0;
  opacity: 0;
  overflow: hidden;
  transition: opacity 0.3s ease;
}

.script-item-actions .el-button {
  min-width: auto;
  padding: var(--spacing-sm) var(--spacing-base);
}

.pin-icon {
  width: 14px;
  height: 14px;
  display: block;
}

.pin-button {
  color: var(--text-tertiary);
}

.pin-button:hover {
  color: var(--color-primary);
}

/* 滚动条样式 */
.script-items::-webkit-scrollbar {
  width: 6px;
}

.script-items::-webkit-scrollbar-track {
  background: var(--bg-input);
  border-radius: var(--radius-base);
}

.script-items::-webkit-scrollbar-thumb {
  background: var(--border-card);
  border-radius: var(--radius-base);
  transition: background 0.2s ease;
}

.script-items::-webkit-scrollbar-thumb:hover {
  background: var(--border-card-hover);
}

[data-theme="dark"] .pin-button {
  color: var(--text-placeholder);
}

[data-theme="dark"] .pin-button:hover {
  color: #79bbff;
}

.current-version {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--bg-input);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-xl);
}

.version-label {
  
  font-weight: 600;
  color: var(--color-text);
}

.version-value {
  font-size: var(--font-size-md);
  font-weight: 700;
  color: #667eea;
  font-family: monospace;
}

.version-options {
  margin-bottom: var(--spacing-2xl);
}

.option-label {
  display: block;
  
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: var(--spacing-md);
}

.version-radio-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.version-radio {
  width: 100%;
  margin: 0 !important;
  padding: var(--spacing-md) var(--spacing-lg);
}

.version-radio :deep(.el-radio__label) {
  width: 100%;
  padding-left: var(--spacing-base);
}

.radio-content {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.radio-label {
  
  font-weight: 600;
  color: var(--color-text);
}

.radio-desc {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  font-family: monospace;
}

.script-form {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-base);
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.form-item {
  display: flex;
  align-items: center;
  gap: 6px;
}

.form-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  flex-shrink: 0;
  color: var(--color-text);
}

.action-button {
  margin-top: var(--spacing-base);
  width: 100%;
  height: 36px;
  
  font-weight: 600;
}

.error-tip,
.success-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-base);
  font-size: var(--font-size-sm);
}

.error-tip {
  color: var(--color-danger);
  background: rgba(245, 108, 108, 0.1);
  border: 1px solid rgba(245, 108, 108, 0.2);
}

.error-tip .el-icon {
  
  flex-shrink: 0;
}

.success-tip {
  color: var(--color-success);
  background: rgba(103, 194, 58, 0.1);
  border: 1px solid rgba(103, 194, 58, 0.2);
}

.success-tip .el-icon {
  
  flex-shrink: 0;
}

/* 深色主题适配 */


:deep(.el-tabs__item) {
  color: var(--text-secondary);
}

:deep(.el-tabs__item.is-active) {
  color: #667eea;
}

:deep(.el-tabs__active-bar) {
  background-color: #667eea;
}

:deep(.el-radio.is-bordered.is-checked) {
  border-color: #667eea;
}
</style>
