<template>
  <CommonDialog
    v-model="visible"
    :title="$t('@42BB9:Git 全局设置')"
    size="large"
    :destroy-on-close="true"
    custom-class="user-settings-dialog"
    @update:model-value="handleVisibleChange"
  >
    <div
      class="user-settings-content"
      v-loading="isLoading"
      :element-loading-text="$t('@42BB9:正在加载配置...')"
      element-loading-background="rgba(0, 0, 0, 0.15)"
    >
      <div class="info-section">
        <div class="info-card">
          <div class="info-icon">
            <el-icon><InfoFilled /></el-icon>
          </div>
          <div class="info-content">
            <p class="info-title">{{ $t('@42BB9:全局配置') }}</p>
            <p class="info-desc">{{ $t('@42BB9:这些设置将影响全局 Git 配置，对所有 Git 仓库生效') }}</p>
          </div>
        </div>
      </div>
      <el-form class="user-form" label-width="auto" :model="{ tempUserName, tempUserEmail }">
        <div class="basic-info-section">
          <div class="basic-info-grid">
            <el-form-item class="form-item" :label="$t('@42BB9:用户名')">
              <el-input 
                v-model="tempUserName" 
                :placeholder="$t('@42BB9:请输入 Git 用户名')" 
                class="modern-input"
              />
            </el-form-item>

            <el-form-item class="form-item" :label="$t('@42BB9:邮箱地址')">
              <el-input 
                v-model="tempUserEmail" 
                :placeholder="$t('@42BB9:请输入 Git 邮箱地址')" 
                class="modern-input"
              />
            </el-form-item>
          </div>
        </div>
        
        <!-- 高级设置：常用全局 Git 配置 -->
        <div class="settings-section">
          <div class="section-title">
            <el-icon class="title-icon"><Setting /></el-icon>
            <span>{{ $t('@42BB9:高级配置') }}</span>
          </div>
          <div class="settings-grid">
            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:自动设置上游') }}
                <el-tooltip :content="$t('@42BB9:首次 git push 时，自动为当前分支创建远程同名分支并建立跟踪关系（等同于 push -u）。')" placement="top" :show-after="200">
                  <el-icon class="qmark"><InfoFilled /></el-icon>
                </el-tooltip>
              </label>
              <el-switch v-model="cfgAutoSetupRemote" />
            </div>

            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:拉取策略') }}</label>
              <el-select v-model="cfgPullRebase" class="modern-input" size="default">
                <el-option :label="$t('@42BB9:merge (默认)')" value="false" />
                <el-option label="rebase" value="true" />
                <el-option :label="$t('@42BB9:rebase(保留合并)')" value="merges" />
              </el-select>
            </div>

            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:自动清理远程分支') }}
                <el-tooltip :content="$t('@42BB9:在 git fetch 时自动 prune，移除已在远程删除但本地仍保留的远程分支引用。')" placement="top" :show-after="200">
                  <el-icon class="qmark"><InfoFilled /></el-icon>
                </el-tooltip>
              </label>
              <el-switch v-model="cfgFetchPrune" />
            </div>

            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:换行符处理') }}</label>
              <el-select v-model="cfgCoreAutoCrlf" class="modern-input" size="default">
                <el-option label="true (Windows)" value="true" />
                <el-option label="input" value="input" />
                <el-option label="false" value="false" />
              </el-select>
            </div>

            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:默认初始化分支') }}
                <el-tooltip :content="$t('@42BB9:新建仓库时（git init）默认创建的分支名，常见为 main 或 master。')" placement="top" :show-after="200">
                  <el-icon class="qmark"><InfoFilled /></el-icon>
                </el-tooltip>
              </label>
              <el-input v-model="cfgInitDefaultBranch" :placeholder="$t('@42BB9:例如: main')" class="modern-input" size="default" />
            </div>
          </div>
        </div>

      </el-form>
    </div>
    
    <template #footer>
      <div class="user-settings-footer">
        <div></div>
        <div class="footer-actions">
          <button type="button" class="dialog-cancel-btn" @click="visible = false" :disabled="isLoading">
            {{ $t('@42BB9:取消') }}
          </button>
          <button type="button" class="dialog-confirm-btn" @click="handleSave" :disabled="isLoading">
            <el-icon><Check /></el-icon>
            <span>{{ $t('@42BB9:保存设置') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { InfoFilled, Setting, Check } from '@element-plus/icons-vue'
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

// 初始值（用于仅保存变更项）
let initUserName = ''
let initUserEmail = ''
let initAutoSetupRemote = false
let initPullRebase: 'false' | 'true' | 'merges' = 'false'
let initFetchPrune = false
let initCoreAutoCrlf: 'true' | 'input' | 'false' = 'true'
let initInitDefaultBranch = 'main'

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
    // 记录初始值
    initUserName = tempUserName.value
    initUserEmail = tempUserEmail.value
    initAutoSetupRemote = cfgAutoSetupRemote.value
    initPullRebase = cfgPullRebase.value
    initFetchPrune = cfgFetchPrune.value
    initCoreAutoCrlf = cfgCoreAutoCrlf.value
    initInitDefaultBranch = cfgInitDefaultBranch.value
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
  if (!data.success) throw new Error(data.error || `${$t('@42BB9:设置 ')}${key}${$t('@42BB9: 失败')}`)
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

// 保存常用配置（仅保存已变更项）
async function saveGlobalGitConfigs() {
  const tasks: Promise<any>[] = []
  try {
    if (cfgAutoSetupRemote.value !== initAutoSetupRemote) {
      tasks.push(setGlobalConfig('push.autoSetupRemote', cfgAutoSetupRemote.value ? 'true' : 'false'))
    }
    if (cfgPullRebase.value !== initPullRebase) {
      tasks.push(setGlobalConfig('pull.rebase', cfgPullRebase.value))
    }
    if (cfgFetchPrune.value !== initFetchPrune) {
      tasks.push(setGlobalConfig('fetch.prune', cfgFetchPrune.value ? 'true' : 'false'))
    }
    if (cfgCoreAutoCrlf.value !== initCoreAutoCrlf) {
      tasks.push(setGlobalConfig('core.autocrlf', cfgCoreAutoCrlf.value))
    }
    const trimmed = (cfgInitDefaultBranch.value || '').trim()
    if (trimmed && trimmed !== initInitDefaultBranch) {
      tasks.push(setGlobalConfig('init.defaultBranch', trimmed))
    }
    if (tasks.length === 0) {
      // 无需保存
      return true
    }
    await Promise.all(tasks)
    ElMessage.success($t('@42BB9:已保存变更的 Git 配置'))
    // 更新初始值为最新
    initAutoSetupRemote = cfgAutoSetupRemote.value
    initPullRebase = cfgPullRebase.value
    initFetchPrune = cfgFetchPrune.value
    initCoreAutoCrlf = cfgCoreAutoCrlf.value
    initInitDefaultBranch = trimmed || initInitDefaultBranch
    return true
  } catch (e) {
    ElMessage.error((e as Error).message)
    return false
  }
}

// 保存设置
async function handleSave() {
  if (!tempUserName.value || !tempUserEmail.value) {
    ElMessage.warning($t('@42BB9:用户名和邮箱不能为空'))
    return
  }

  // 仅在用户信息发生变化时保存
  let userSaved = true
  if (tempUserName.value !== initUserName || tempUserEmail.value !== initUserEmail) {
    userSaved = await gitStore.restoreUserConfig(tempUserName.value, tempUserEmail.value)
    if (userSaved) {
      initUserName = tempUserName.value
      initUserEmail = tempUserEmail.value
    }
  }

  const cfgSaved = await saveGlobalGitConfigs()
  if (userSaved && cfgSaved) {
    if (
      tempUserName.value === initUserName &&
      tempUserEmail.value === initUserEmail
    ) {
      // 若无任何变更，提示但仍可关闭
      // ElMessage.info($t('@42BB9:没有需要保存的变更'))
    }
    visible.value = false
  }
}
</script>

<style scoped>
/* 用户设置对话框样式 */
.user-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.basic-info-section {
  padding-top: 14px;
}

.basic-info-grid {
  display: flex;
  gap: var(--spacing-xl);
  align-items: center;
}

.form-item {
  flex: 1;
  margin-bottom: 0;
}

/* 用户设置-高级配置布局 */
.settings-section {
  margin-top: var(--spacing-base);
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color);
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-lg);
  
  font-weight: 600;
  color: var(--color-text-title);
}

.section-title .title-icon {
  font-size: var(--font-size-md);
  color: var(--color-primary);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md) var(--spacing-xl);
}

.setting-row {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: var(--spacing-md);
  align-items: center;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--el-text-color-regular);
  text-align: right;
  padding-right: var(--spacing-base);
}

.setting-label .qmark {
  margin-left: 6px;
  
  color: var(--el-text-color-secondary);
  vertical-align: -1px;
  cursor: help;
}

.setting-label .qmark:hover {
  color: var(--color-primary);
}


:deep(.settings-grid .el-switch) {
  --el-switch-on-color: var(--color-primary);
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
  box-shadow: var(--shadow-md);
}

html.dark .basic-info-section {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.1);
}

html.dark .basic-info-section:hover {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: var(--shadow-md);
}

html.dark .label-icon {
  color: rgba(255, 255, 255, 0.5);
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
  color: var(--color-primary);
}

:deep(.modern-input .el-input__wrapper) {
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-input);
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
  background: var(--bg-container);
}

:deep(.modern-input .el-input__wrapper:hover) {
  border-color: var(--color-gray-300);
  box-shadow: var(--shadow-md);
}

:deep(.modern-input.is-focus .el-input__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input .el-input__inner) {
  
  color: var(--text-title);
  font-weight: 400;
}

:deep(.modern-input .el-input__inner::placeholder) {
  color: var(--color-gray-400);
  font-weight: 400;
}

.info-section {
  margin-bottom: var(--spacing-base);
}

.info-card {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: linear-gradient(135deg, rgba(64, 158, 255, 0.08) 0%, rgba(64, 158, 255, 0.04) 100%);
  border: 1px solid rgba(64, 158, 255, 0.2);
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
}

.info-card:hover {
  border-color: rgba(64, 158, 255, 0.3);
  box-shadow: var(--shadow-md);
}

.info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
  background: linear-gradient(135deg, var(--color-primary) 0%, #3a8ee6 100%);
}

.info-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  flex-shrink: 0;
  margin-top: 0;
}

.info-icon .el-icon {
  font-size: var(--font-size-xl);
}

.info-content {
  flex: 1;
}

.info-title {
  margin: 0 0 6px 0;
  
  font-weight: 600;
  color: var(--color-text-title);
  letter-spacing: 0.3px;
}

.info-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.user-settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}

/* footer-actions、dialog-cancel-btn、dialog-confirm-btn 基础样式已移至 @/styles/common.scss */
</style>
