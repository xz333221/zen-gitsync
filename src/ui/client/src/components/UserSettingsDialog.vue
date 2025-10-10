<template>
  <CommonDialog
    v-model="visible"
    title="Git 用户设置"
    size="large"
    :destroy-on-close="true"
    custom-class="user-settings-dialog"
    @update:model-value="handleVisibleChange"
  >
    <div
      class="user-settings-content"
      v-loading="isLoading"
      element-loading-text="正在加载配置..."
      element-loading-background="rgba(0, 0, 0, 0.15)"
    >
      <div class="info-section">
        <div class="info-card">
          <div class="info-icon">
            <el-icon><InfoFilled /></el-icon>
          </div>
          <div class="info-content">
            <p class="info-title">全局配置</p>
            <p class="info-desc">这些设置将影响全局 Git 配置，对所有 Git 仓库生效</p>
          </div>
        </div>
      </div>
      <el-form class="user-form" :model="{ tempUserName, tempUserEmail }" label-position="top">
        <div class="basic-info-grid">
          <el-form-item class="form-item">
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><User /></el-icon>
                <span>用户名</span>
              </div>
            </template>
            <el-input 
              v-model="tempUserName" 
              placeholder="请输入 Git 用户名" 
              class="modern-input"
              size="large"
            />
          </el-form-item>

          <el-form-item class="form-item">
            <template #label>
              <div class="form-label">
                <el-icon class="label-icon"><Message /></el-icon>
                <span>邮箱地址</span>
              </div>
            </template>
            <el-input 
              v-model="tempUserEmail" 
              placeholder="请输入 Git 邮箱地址" 
              class="modern-input"
              size="large"
            />
          </el-form-item>
        </div>
        
        <!-- 高级设置：常用全局 Git 配置 -->
        <div class="settings-section">
          <div class="section-title">
            <el-icon class="title-icon"><Setting /></el-icon>
            <span>高级配置</span>
          </div>
          <div class="settings-grid">
            <div class="setting-row">
              <label class="setting-label">自动设置上游</label>
              <el-switch v-model="cfgAutoSetupRemote" />
            </div>

            <div class="setting-row">
              <label class="setting-label">拉取策略</label>
              <el-select v-model="cfgPullRebase" class="modern-input" size="default">
                <el-option label="merge (默认)" value="false" />
                <el-option label="rebase" value="true" />
                <el-option label="rebase(保留合并)" value="merges" />
              </el-select>
            </div>

            <div class="setting-row">
              <label class="setting-label">自动清理远程分支</label>
              <el-switch v-model="cfgFetchPrune" />
            </div>

            <div class="setting-row">
              <label class="setting-label">换行符处理</label>
              <el-select v-model="cfgCoreAutoCrlf" class="modern-input" size="default">
                <el-option label="true (Windows)" value="true" />
                <el-option label="input" value="input" />
                <el-option label="false" value="false" />
              </el-select>
            </div>

            <div class="setting-row">
              <label class="setting-label">默认初始化分支</label>
              <el-input v-model="cfgInitDefaultBranch" placeholder="例如: main" class="modern-input" size="default" />
            </div>
          </div>
        </div>

      </el-form>
    </div>
    
    <template #footer>
      <div class="user-settings-footer">
        <button type="button" class="footer-btn danger-btn" @click="handleClear" :disabled="isLoading">
          <el-icon><Delete /></el-icon>
          <span>清除配置</span>
        </button>
        <div class="footer-actions">
          <button type="button" class="footer-btn cancel-btn" @click="visible = false" :disabled="isLoading">
            取消
          </button>
          <button type="button" class="footer-btn primary-btn" @click="handleSave" :disabled="isLoading">
            <el-icon><Check /></el-icon>
            <span>保存设置</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { User, Message, InfoFilled, Setting, Delete, Check } from '@element-plus/icons-vue'
import CommonDialog from './CommonDialog.vue'
import { useGitStore } from '@/stores/gitStore'

const gitStore = useGitStore()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = ref(false)
const isLoading = ref(false)
const tempUserName = ref('')
const tempUserEmail = ref('')

// 常用全局 Git 配置
const cfgAutoSetupRemote = ref(false)
const cfgPullRebase = ref<'false' | 'true' | 'merges'>('false')
const cfgFetchPrune = ref(false)
const cfgCoreAutoCrlf = ref<'true' | 'input' | 'false'>('true')
const cfgInitDefaultBranch = ref('main')

// 同步 v-model
watch(() => props.modelValue, async (val) => {
  visible.value = val
  if (val) {
    // 打开时加载数据
    tempUserName.value = gitStore.userName
    tempUserEmail.value = gitStore.userEmail
    try {
      isLoading.value = true
      await loadGlobalGitConfigs()
    } finally {
      isLoading.value = false
    }
  }
}, { immediate: true })

function handleVisibleChange(val: boolean) {
  emit('update:modelValue', val)
}

// 读取单个全局配置
async function getGlobalConfig(key: string): Promise<string> {
  try {
    const res = await fetch('/api/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `git config --global --get ${key}` })
    })
    const data = await res.json()
    if (data.success) {
      return String(data.stdout || '').trim()
    }
  } catch (e) {
    // ignore
  }
  return ''
}

// 设置单个全局配置
async function setGlobalConfig(key: string, value: string) {
  const res = await fetch('/api/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: `git config --global ${key} ${value}` })
  })
  const data = await res.json()
  if (!data.success) throw new Error(data.error || `设置 ${key} 失败`)
}

// 加载常用配置
async function loadGlobalGitConfigs() {
  const [autoSetup, pullRebase, fetchPrune, autocrlf, defBranch] = await Promise.all([
    getGlobalConfig('push.autoSetupRemote'),
    getGlobalConfig('pull.rebase'),
    getGlobalConfig('fetch.prune'),
    getGlobalConfig('core.autocrlf'),
    getGlobalConfig('init.defaultBranch')
  ])

  cfgAutoSetupRemote.value = (autoSetup || 'false').toLowerCase() === 'true'
  const pr = (pullRebase || 'false').toLowerCase()
  cfgPullRebase.value = (pr === 'true' || pr === 'merges') ? pr as any : 'false'
  cfgFetchPrune.value = (fetchPrune || 'false').toLowerCase() === 'true'
  const ac = (autocrlf || 'true').toLowerCase()
  cfgCoreAutoCrlf.value = (ac === 'true' || ac === 'input') ? ac as any : 'false'
  cfgInitDefaultBranch.value = defBranch || 'main'
}

// 保存常用配置
async function saveGlobalGitConfigs() {
  try {
    await setGlobalConfig('push.autoSetupRemote', cfgAutoSetupRemote.value ? 'true' : 'false')
    await setGlobalConfig('pull.rebase', cfgPullRebase.value)
    await setGlobalConfig('fetch.prune', cfgFetchPrune.value ? 'true' : 'false')
    await setGlobalConfig('core.autocrlf', cfgCoreAutoCrlf.value)
    if (cfgInitDefaultBranch.value && cfgInitDefaultBranch.value.trim()) {
      await setGlobalConfig('init.defaultBranch', cfgInitDefaultBranch.value.trim())
    }
    ElMessage.success('全局 Git 配置已保存')
    return true
  } catch (e) {
    ElMessage.error((e as Error).message)
    return false
  }
}

// 保存设置
async function handleSave() {
  if (!tempUserName.value || !tempUserEmail.value) {
    ElMessage.warning('用户名和邮箱不能为空')
    return
  }

  const userSaved = await gitStore.restoreUserConfig(tempUserName.value, tempUserEmail.value)
  const cfgSaved = await saveGlobalGitConfigs()
  if (userSaved && cfgSaved) {
    visible.value = false
  }
}

// 清除配置
async function handleClear() {
  const success = await gitStore.clearUserConfig()
  if (success) {
    tempUserName.value = ''
    tempUserEmail.value = ''
  }
}
</script>

<style scoped>
/* 用户设置对话框样式 */
.user-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.basic-info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.form-item {
  margin-bottom: 0;
}

/* 用户设置-高级配置布局 */
.settings-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid var(--el-border-color-light);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-title);
}

.section-title .title-icon {
  font-size: 16px;
  color: #409eff;
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 20px;
}

.setting-row {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  align-items: center;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  text-align: right;
  padding-right: 8px;
}

:deep(.form-item .el-form-item__label) {
  padding: 0 0 8px 0;
  font-weight: 500;
  color: var(--color-text-title);
}

:deep(.settings-grid .el-switch) {
  --el-switch-on-color: #409eff;
  --el-switch-off-color: var(--el-border-color);
}

:deep(.settings-grid .el-select) {
  width: 100%;
}

:deep(.settings-grid .el-input) {
  width: 100%;
}

/* 深色主题适配 */
html.dark .info-card {
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.12) 0%, rgba(64, 158, 255, 0.06) 100%);
  border-color: rgba(64, 158, 255, 0.25);
}

html.dark .info-card:hover {
  border-color: rgba(64, 158, 255, 0.35);
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.15);
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

:deep(.modern-input .el-input__wrapper) {
  border-radius: 8px;
  border: 1px solid var(--border-input);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  transition: all 0.2s ease;
  background: var(--bg-container);
}

:deep(.modern-input .el-input__wrapper:hover) {
  border-color: #d1d5db;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input.is-focus .el-input__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input .el-input__inner) {
  font-size: 14px;
  color: var(--text-title);
  font-weight: 400;
}

:deep(.modern-input .el-input__inner::placeholder) {
  color: #9ca3af;
  font-weight: 400;
}

.info-section {
  margin-bottom: 8px;
}

.info-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.08) 0%, rgba(64, 158, 255, 0.04) 100%);
  border: 1px solid rgba(64, 158, 255, 0.2);
  border-radius: 12px;
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
}

.info-card:hover {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.1);
}

.info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
  background: linear-gradient(135deg, #409eff 0%, #3a8ee6 100%);
}

.info-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #409eff;
  flex-shrink: 0;
  margin-top: 0;
}

.info-icon .el-icon {
  font-size: 20px;
}

.info-content {
  flex: 1;
}

.info-title {
  margin: 0 0 6px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-title);
  letter-spacing: 0.3px;
}

.info-desc {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.user-settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}

.footer-actions {
  display: flex;
  gap: 8px;
}

.footer-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.footer-btn:hover {
  transform: translateY(-1px);
}

.danger-btn {
  background: transparent;
  color: #f56c6c;
  border: 1px solid rgba(245, 108, 108, 0.3);
}

.danger-btn:hover {
  background: rgba(245, 108, 108, 0.1);
  border-color: #f56c6c;
}

.cancel-btn {
  background: var(--bg-container);
  color: var(--el-text-color-regular);
  border: 1px solid var(--el-border-color);
}

.cancel-btn:hover {
  background: var(--el-fill-color-light);
  border-color: var(--el-border-color-hover);
}

.primary-btn {
  background: linear-gradient(135deg, #409eff 0%, #3a8ee6 100%);
  color: white;
  box-shadow: 0 2px 4px rgba(64, 158, 255, 0.3);
}

.primary-btn:hover {
  box-shadow: 0 4px 8px rgba(64, 158, 255, 0.4);
}
</style>
