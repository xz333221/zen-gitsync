<template>
  <CommonDialog
    v-model="visible"
    :title="$t('@42BB9:设置')"
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
      <!-- 左侧标签页切换 -->
      <div class="settings-tabs">
        <div
          class="tab-item"
          :class="{ active: activeTab === 'general' }"
          @click="activeTab = 'general'"
        >
          <span>{{ $t('@42BB9:通用设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'git' }"
          @click="activeTab = 'git'"
        >
          <span>{{ $t('@42BB9:Git 全局设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'commit' }"
          @click="activeTab = 'commit'"
        >
          <span>{{ $t('@42BB9:提交设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'config' }"
          @click="onClickConfigTab"
        >
          <span>{{ $t('@42BB9:编辑配置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'editor' }"
          @click="activeTab = 'editor'"
        >
          <span>{{ $t('@42BB9:编辑器设置') }}</span>
        </div>
      </div>

      <!-- 右侧内容区域 -->
      <div class="settings-panels">
        <!-- 通用设置面板 -->
        <div v-show="activeTab === 'general'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:通用配置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:自定义应用的外观和语言') }}</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:外观') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:主题') }}</label>
                <el-select v-model="tempTheme" class="modern-input" size="default">
                  <el-option :label="$t('@42BB9:浅色')" value="light" />
                  <el-option :label="$t('@42BB9:深色')" value="dark" />
                  <el-option :label="$t('@42BB9:跟随系统')" value="auto" />
                </el-select>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:语言') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:界面语言') }}</label>
                <el-select v-model="tempLocale" class="modern-input" size="default">
                  <el-option label="简体中文" value="zh-CN" />
                  <el-option label="English" value="en-US" />
                </el-select>
              </div>
            </div>
          </div>

          <!-- AI 模型配置 -->
          <div class="settings-section">
            <div class="section-title model-section-title">
              <span>{{ $t('@42BB9:AI 模型配置') }}</span>
              <button class="add-model-btn" @click="startAddModel">+ {{ $t('@42BB9:添加模型') }}</button>
            </div>

            <div class="model-list">
              <div v-if="aiModels.length === 0" class="model-empty">{{ $t('@42BB9:暂未配置模型') }}</div>
              <div v-for="m in aiModels" :key="m.id" class="model-card">
                <div class="model-info">
                  <div class="model-name-row">
                    <span class="model-name">{{ m.name }}</span>
                    <span v-if="m.isDefault" class="model-default-badge">{{ $t('@42BB9:默认') }}</span>
                  </div>
                  <div class="model-meta">{{ m.model }} · {{ m.baseURL }}</div>
                </div>
                <div class="model-actions">
                  <button v-if="!m.isDefault" class="model-btn" @click="handleSetDefaultModel(m.id)">{{ $t('@42BB9:设为默认') }}</button>
                  <button class="model-btn" @click="startEditModel(m)">{{ $t('@42BB9:编辑') }}</button>
                  <button class="model-btn model-btn--danger" @click="handleDeleteModel(m.id)">{{ $t('@42BB9:删除') }}</button>
                </div>
              </div>
            </div>

            <!-- 新增 / 编辑表单 -->
            <div v-if="editingModelId !== undefined" class="model-form">
              <div class="model-form-title">{{ editingModelId === null ? $t('@42BB9:添加模型') : $t('@42BB9:编辑模型') }}</div>
              <div class="model-form-grid">
                <div class="model-form-row">
                  <label class="model-form-label">{{ $t('@42BB9:接口地址') }} <span class="req">*</span></label>
                  <el-select
                    v-model="modelEditForm.baseURL"
                    filterable
                    allow-create
                    :placeholder="$t('@42BB9:选择或输入接口地址')"
                    class="modern-input"
                    style="width:100%"
                    @change="onBaseURLChange"
                  >
                    <el-option v-for="p in providerPresets" :key="p.url" :label="p.url" :value="p.url">
                      <div style="line-height:1.3;padding:3px 0">
                        <div style="font-size:13px;font-weight:500">{{ p.name }}</div>
                        <div style="font-size:11px;opacity:0.6;margin-top:2px">{{ p.url }}</div>
                      </div>
                    </el-option>
                  </el-select>
                </div>
                <div class="model-form-row">
                  <label class="model-form-label">{{ $t('@42BB9:模型名称') }} <span class="req">*</span></label>
                  <el-select
                    v-model="modelEditForm.model"
                    filterable
                    allow-create
                    :placeholder="$t('@42BB9:选择或输入模型名称')"
                    class="modern-input"
                    style="width:100%"
                    @change="onModelChange"
                  >
                    <el-option v-for="mn in currentModelOptions" :key="mn" :label="mn" :value="mn" />
                  </el-select>
                </div>
                <div class="model-form-row">
                  <label class="model-form-label">API Key</label>
                  <el-input v-model="modelEditForm.apiKey" type="password" show-password :placeholder="$t('@42BB9:输入 API Key')" class="modern-input" size="default" />
                </div>
              </div>
              <div class="model-form-actions">
                <div class="model-test-result" v-if="modelTestResult !== null">
                  <span :class="['model-test-badge', modelTestResult.ok ? 'model-test-badge--ok' : 'model-test-badge--fail']">
                    {{ modelTestResult.ok ? '✅' : '❌' }}
                    {{ modelTestResult.ok ? modelTestResult.reply : modelTestResult.error }}
                  </span>
                </div>
                <button type="button" class="dialog-cancel-btn" @click="cancelEditModel">{{ $t('@42BB9:取消') }}</button>
                <button type="button" class="model-test-btn" :disabled="modelTesting" @click="handleTestModel">
                  <span v-if="modelTesting" class="model-test-spin"></span>
                  {{ modelTesting ? $t('@42BB9:测试中...') : $t('@42BB9:测试') }}
                </button>
                <button type="button" class="dialog-confirm-btn" :disabled="modelSaving" @click="handleSaveModelForm">
                  {{ $t('@42BB9:保存模型') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Git 全局设置面板 -->
        <div v-show="activeTab === 'git'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
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

        <!-- 提交设置面板 -->
        <div v-show="activeTab === 'commit'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@76872:提交设置') }}</p>
                <p class="info-desc">{{ $t('@76872:这些设置实时生效') }}</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@76872:提交格式与行为') }}</span>
            </div>
            <div class="settings-grid commit-settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:标准化提交') }}</label>
                <el-switch v-model="configStore.isStandardCommit" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:跳过钩子检查') }}
                  <el-tooltip :content="$t('@76872:添加 --no-verify 参数')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.skipHooks" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:回车自动提交') }}
                  <el-tooltip :content="$t('@76872:输入提交信息后按回车直接执行一键推送')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoQuickPushOnEnter" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:Push完成自动关闭') }}
                  <el-tooltip :content="$t('@76872:推送成功后自动关闭进度弹窗')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoClosePushModal" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:自动填充默认提交信息') }}
                  <el-tooltip :content="$t('@76872:打开页面或提交完成后自动填充默认提交信息')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoSetDefaultMessage" />
              </div>
            </div>
          </div>
        </div>

        <!-- 编辑配置 JSON 面板 -->
        <div v-show="activeTab === 'config'" class="settings-panel config-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:编辑当前项目的配置文件') }}</p>
                <p class="info-desc">{{ $t('@42BB9:直接编辑 JSON，支持所有配置项') }}</p>
              </div>
            </div>
          </div>
          <div class="config-json-editor-wrap">
            <el-input
              v-model="configEditorText"
              type="textarea"
              spellcheck="false"
              autocomplete="off"
              :placeholder="$t('@42BB9:加载中...')"
              class="config-json-editor"
            />
          </div>
          <div class="config-panel-actions">
            <button type="button" class="dialog-cancel-btn system-config-btn" @click="openSystemConfigFile">
              {{ $t('@42BB9:打开系统配置文件') }}
            </button>
          </div>
        </div>

        <!-- 编辑器设置面板 -->
        <div v-show="activeTab === 'editor'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:编辑器设置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:自定义编辑器行为') }}</p>
              </div>
            </div>
          </div>
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:文件编辑') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:自动保存') }}</label>
                <el-switch v-model="tempEditorAutoSave" />
              </div>
              <div class="setting-row setting-row--hint" v-if="tempEditorAutoSave">
                <span class="setting-hint">{{ $t('@42BB9:失去焦点时自动保存当前文件') }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <template #footer v-if="activeTab !== 'commit'">
      <div class="user-settings-footer">
        <div></div>
        <div class="footer-actions">
          <button type="button" class="dialog-cancel-btn" @click="visible = false" :disabled="isLoading">
            {{ hasChanges ? $t('@42BB9:取消') : $t('@42BB9:关闭') }}
          </button>
          <button v-if="hasChanges" type="button" class="dialog-confirm-btn" @click="handleSave" :disabled="isLoading">
            <el-icon><Check /></el-icon>
            <span>{{ activeTab === 'config' ? $t('@42BB9:保存配置') : $t('@42BB9:保存设置') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, InfoFilled } from '@element-plus/icons-vue'
import CommonDialog from './CommonDialog.vue'
import { useGitStore } from '@/stores/gitStore'
import { useLocaleStore } from '@/stores/localeStore'
import { useConfigStore, type ModelInfo } from '@/stores/configStore'
import { type SupportLocale } from '@/locales'

const gitStore = useGitStore()
const localeStore = useLocaleStore()
const configStore = useConfigStore()

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = ref(false)
const isLoading = ref(false)
const activeTab = ref<'general' | 'git' | 'commit' | 'config' | 'editor'>('general')

// 通用设置
const tempTheme = ref<'light' | 'dark' | 'auto'>('light')
const tempLocale = ref<SupportLocale>('zh-CN')

// 编辑器设置
const tempEditorAutoSave = ref(false)

// AI 模型配置
const aiModels = ref<ModelInfo[]>([])
const editingModelId = ref<string | null | undefined>(undefined) // undefined=隐藏, null=新增, string=编辑
const modelEditForm = ref({ id: '', name: '', apiKey: '', baseURL: '', model: '' })
const modelSaving = ref(false)
const modelTesting = ref(false)
const modelTestResult = ref<{ ok: boolean; reply?: string; error?: string } | null>(null)

interface ProviderPreset { name: string; url: string; models: string[] }
const providerPresets: ProviderPreset[] = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1', models: ['gpt-5.5', 'gpt-5.5-turbo', 'gpt-5.5-xhigh', 'gpt-4.1', 'gpt-4o'] },
  { name: 'Anthropic (Claude)', url: 'https://api.anthropic.com/v1', models: ['claude-opus-4-7-20250416', 'claude-sonnet-4-7-20250416', 'claude-sonnet-4-20250514'] },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'] },
  { name: 'Google (Gemini)', url: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-3.1-pro', 'gemini-3.1-ultra', 'gemini-2.5-pro'] },
  { name: 'xAI (Grok)', url: 'https://api.x.ai/v1', models: ['grok-4.1', 'grok-4.20'] },
  { name: 'Meta (Llama)', url: 'https://api.llama-api.com/v1', models: ['llama-4-maverick', 'llama-4-scout', 'llama-3.1-70b'] },
  { name: 'Mistral AI', url: 'https://api.mistral.ai/v1', models: ['mistral-medium-3', 'mistral-small-4', 'mistral-large-2'] },
  { name: 'MiniMax', url: 'https://api.minimaxi.com/v1', models: ['minimax-m2.7', 'minimax-m2.5', 'minimax-m1', 'abab7-chat'] },
  { name: 'Moonshot (Kimi)', url: 'https://api.moonshot.cn/v1', models: ['kimi-k2.6', 'kimi-k2', 'moonshot-v1-128k'] },
  { name: '智谱 (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-5.1', 'glm-4-plus', 'glm-4-air'] },
  { name: '阿里 (Qwen)', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3.6-max', 'qwen3.6-plus', 'qwen-plus', 'qwen-max'] },
  { name: 'Cohere', url: 'https://api.cohere.com/v2', models: ['command-r-plus-4', 'command-r-4'] },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1', models: ['llama-3.1-70b-versatile', 'llama-3.1-8b-instant'] },
  { name: 'Together AI', url: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-4-Maverick', 'Qwen/Qwen3-72B'] },
  { name: 'Ollama (本地)', url: 'http://localhost:11434/v1', models: ['qwen2.5', 'llama3.1', 'mistral', 'deepseek-r1:7b'] },
]

const currentModelOptions = computed(() => {
  const matched = providerPresets.find(p => p.url === modelEditForm.value.baseURL)
  const pool = matched ? matched.models : providerPresets.flatMap(p => p.models)
  return [...new Set(pool)]
})

const hasChanges = computed(() => {
  if (activeTab.value === 'config') return true
  if (activeTab.value === 'general') {
    return tempTheme.value !== initTheme || tempLocale.value !== initLocale || editingModelId.value !== undefined
  }
  if (activeTab.value === 'git') {
    return (
      tempUserName.value !== initUserName ||
      tempUserEmail.value !== initUserEmail ||
      cfgAutoSetupRemote.value !== initAutoSetupRemote ||
      cfgPullRebase.value !== initPullRebase ||
      cfgFetchPrune.value !== initFetchPrune ||
      cfgCoreAutoCrlf.value !== initCoreAutoCrlf ||
      (cfgInitDefaultBranch.value || '').trim() !== initInitDefaultBranch
    )
  }
  if (activeTab.value === 'editor') {
    return tempEditorAutoSave.value !== configStore.editorAutoSave
  }
  return false
})

function onBaseURLChange(val: string) {
  const matched = providerPresets.find(p => p.url === val)
  if (matched && !modelEditForm.value.model) {
    modelEditForm.value.model = matched.models[0] || ''
  }
}

function onModelChange(_val: string) {
  // reserved for future use
}

function startAddModel() {
  editingModelId.value = null
  modelEditForm.value = { id: '', name: '', apiKey: '', baseURL: '', model: '' }
  modelTestResult.value = null
}

function startEditModel(m: ModelInfo) {
  editingModelId.value = m.id
  modelEditForm.value = { id: m.id, name: m.name, apiKey: '', baseURL: m.baseURL, model: m.model }
  modelTestResult.value = null
}

function cancelEditModel() {
  editingModelId.value = undefined
  modelTestResult.value = null
}

async function handleTestModel() {
  const f = modelEditForm.value
  if (!f.baseURL.trim() || !f.model.trim()) {
    ElMessage.warning($t('@42BB9:请先填写接口地址和模型名称'))
    return
  }
  modelTesting.value = true
  modelTestResult.value = null
  try {
    const resp = await fetch('/api/config/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL: f.baseURL.trim(), model: f.model.trim(), apiKey: f.apiKey })
    })
    const data = await resp.json()
    if (data.success) {
      modelTestResult.value = { ok: true, reply: data.reply || 'ok' }
    } else {
      modelTestResult.value = { ok: false, error: data.error || $t('@42BB9:测试失败') }
    }
  } catch (e: any) {
    modelTestResult.value = { ok: false, error: e.message }
  } finally {
    modelTesting.value = false
  }
}

async function handleSaveModelForm() {
  const f = modelEditForm.value
  if (!f.baseURL.trim() || !f.model.trim()) {
    ElMessage.warning($t('@42BB9:请填写所有必填字段'))
    return
  }
  const wasAdding = editingModelId.value === null
  // 自动生成 id 和 name
  const provider = providerPresets.find(p => p.url === f.baseURL.trim())
  const autoName = provider ? `${provider.name} / ${f.model.trim()}` : f.model.trim()
  const autoId = wasAdding
    ? `${(provider?.name || 'custom').toLowerCase().replace(/[^a-z0-9]/g, '-')}-${f.model.trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20)}-${Date.now().toString(36)}`
    : editingModelId.value!
  let updated: ModelInfo[]
  if (wasAdding) {
    const isFirst = aiModels.value.length === 0
    updated = [...aiModels.value, { id: autoId, name: autoName, apiKey: f.apiKey, baseURL: f.baseURL.trim(), model: f.model.trim(), isDefault: isFirst }]
  } else {
    updated = aiModels.value.map(m =>
      m.id === editingModelId.value
        ? { ...m, name: autoName, apiKey: f.apiKey || m.apiKey, baseURL: f.baseURL.trim(), model: f.model.trim() }
        : m
    )
  }
  modelSaving.value = true
  try {
    const ok = await configStore.saveModels(updated)
    if (ok) {
      aiModels.value = updated
      editingModelId.value = undefined
      ElMessage.success(wasAdding ? $t('@42BB9:已添加模型') : $t('@42BB9:已更新模型'))
    }
  } finally {
    modelSaving.value = false
  }
}

async function handleDeleteModel(modelId: string) {
  const updated = aiModels.value.filter(m => m.id !== modelId)
  const ok = await configStore.saveModels(updated)
  if (ok) {
    aiModels.value = updated
    ElMessage.success($t('@42BB9:已删除模型'))
  }
}

async function handleSetDefaultModel(modelId: string) {
  const updated = aiModels.value.map(m => ({ ...m, isDefault: m.id === modelId }))
  const ok = await configStore.saveModels(updated)
  if (ok) {
    aiModels.value = updated
    ElMessage.success($t('@42BB9:已设置默认模型'))
  }
}

// Git 设置
const tempUserName = ref('')
const tempUserEmail = ref('')

// 配置编辑器
const configEditorText = ref('')
const configEditorSaving = ref(false)

// 常用全局 Git 配置
const cfgAutoSetupRemote = ref(false)
const cfgPullRebase = ref<'false' | 'true' | 'merges'>('false')
const cfgFetchPrune = ref(false)
const cfgCoreAutoCrlf = ref<'true' | 'input' | 'false'>('true')
const cfgInitDefaultBranch = ref('main')

// ===== 提交设置（由 configStore 统一管理，实时持久化） =====
// commitIsStandard → configStore.isStandardCommit
// commitSkipHooks → configStore.skipHooks
// commitAutoQuickPush → configStore.autoQuickPushOnEnter

// 初始值（用于仅保存变更项）
let initUserName = ''
let initUserEmail = ''
let initAutoSetupRemote = false
let initPullRebase: 'false' | 'true' | 'merges' = 'false'
let initFetchPrune = false
let initCoreAutoCrlf: 'true' | 'input' | 'false' = 'true'
let initInitDefaultBranch = 'main'
let initTheme: 'light' | 'dark' | 'auto' = 'light'
let initLocale: SupportLocale = 'zh-CN'

// 同步 v-model
watch(() => props.modelValue, async (val) => {
  visible.value = val
  if (val) {
    // 打开时加载数据
    tempUserName.value = gitStore.userName
    tempUserEmail.value = gitStore.userEmail
    configEditorText.value = '' // 延迟加载，点击 tab 时才加载
    
    // 加载通用设置
    tempTheme.value = configStore.theme
    tempLocale.value = configStore.locale
    aiModels.value = [...configStore.models]
    editingModelId.value = undefined
    // 加载编辑器设置
    tempEditorAutoSave.value = configStore.editorAutoSave
    
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
    initTheme = tempTheme.value
    initLocale = tempLocale.value
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

// 保存通用设置
async function saveGeneralSettings() {
  const settings: { theme?: 'light' | 'dark' | 'auto', locale?: SupportLocale } = {}
  
  // 保存主题设置（如果与初始值不同或需要强制保存）
  if (tempTheme.value !== initTheme) {
    settings.theme = tempTheme.value
    initTheme = tempTheme.value
  }
  
  // 保存语言设置（如果与初始值不同）
  if (tempLocale.value !== initLocale) {
    settings.locale = tempLocale.value
    localeStore.changeLocale(tempLocale.value)
    initLocale = tempLocale.value
  }
  
  // 只要有设置项就保存（包括主题或语言）
  if (settings.theme !== undefined || settings.locale !== undefined) {
    const saved = await configStore.saveGeneralSettings(settings)
    if (saved) {
      ElMessage.success($t('@42BB9:通用设置已保存'))
    }
    return saved
  }
  
  return true
}

// 保存设置
async function handleSave() {  // 配置编辑 tab 单独处理
  // 模型表单尚未保存时拦截
  if (editingModelId.value !== undefined) {
    ElMessage.warning($t('@42BB9:模型尚未保存，请先保存或取消模型编辑'))
    return
  }
  if (activeTab.value === 'config') {
    await saveConfigJson()
    return
  }
  // 编辑器设置直接写入 store（localStorage 自动持久化）
  if (activeTab.value === 'editor') {
    configStore.editorAutoSave = tempEditorAutoSave.value
    ElMessage.success($t('@42BB9:编辑器设置已保存'))
    visible.value = false
    return
  }
  // 保存通用设置
  const generalSaved = await saveGeneralSettings()
  if (!generalSaved) return
  
  // 保存 Git 设置
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
    visible.value = false
  }
}

// 点击配置 tab：加载配置 JSON
async function onClickConfigTab() {
  activeTab.value = 'config'
  if (configEditorText.value) return
  try {
    const formatResp = await fetch('/api/config/check-file-format')
    const formatData = await formatResp.json()
    if (!formatData.success) {
      ElMessage.warning(formatData.message || $t('@42BB9:配置文件格式可能有问题'))
    }
    configEditorText.value = JSON.stringify(configStore.config, null, 2)
  } catch {
    ElMessage.error($t('@42BB9:加载配置失败'))
  }
}

// 保存配置 JSON
async function saveConfigJson() {
  let parsed: any
  try {
    parsed = JSON.parse(configEditorText.value)
  } catch (e: any) {
    ElMessage.error(`${$t('@42BB9:JSON 解析失败: ')}${e.message || e}`)
    return
  }
  try {
    configEditorSaving.value = true
    const resp = await fetch('/api/config/saveAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    })
    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@42BB9:保存失败: ')}${data.error || $t('@42BB9:未知错误')}`)
      return
    }
    await configStore.loadConfig()
    ElMessage.success($t('@42BB9:配置已保存'))
    visible.value = false
  } catch (err: any) {
    ElMessage.error(`${$t('@42BB9:保存配置失败: ')}${err.message || err}`)
  } finally {
    configEditorSaving.value = false
  }
}

// 打开系统配置文件
async function openSystemConfigFile() {
  try {
    const resp = await fetch('/api/config/open-file', { method: 'POST' })
    const data = await resp.json()
    if (data.success) {
      ElMessage.success($t('@42BB9:已用系统程序打开配置文件'))
    } else {
      ElMessage.error(data.error || $t('@42BB9:打开文件失败'))
    }
  } catch (err: any) {
    ElMessage.error(`${$t('@42BB9:打开文件失败: ')}${err.message || err}`)
  }
}
</script>

<style scoped>
/* 用户设置对话框样式 */
.user-settings-content {
  display: flex;
  gap: var(--spacing-lg);
  min-height: 400px;
}

/* 左侧标签页 - 现代化侧边栏设计 */
.settings-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 180px;
  flex-shrink: 0;
  padding: var(--spacing-sm);
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
}

.tab-item {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.2s ease;
  color: var(--el-text-color-regular);
  font-size: var(--font-size-sm);
  position: relative;
  user-select: none;
}

.tab-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 0;
  background: var(--color-primary);
  border-radius: 0 3px 3px 0;
  transition: height 0.2s ease;
}

.tab-item:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--el-text-color-primary);
}

.tab-item:hover::before {
  height: 50%;
}

.tab-item.active {
  background: rgba(64, 158, 255, 0.08);
  color: var(--color-primary);
  font-weight: 600;
}

.tab-item.active::before {
  height: 60%;
}

.tab-item .el-icon {
  font-size: var(--font-size-md);
}

/* 右侧面板 */
.settings-panels {
  flex: 1;
  min-width: 0;
}

.settings-panel {
  height: 100%;
}

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
  margin-bottom: var(--spacing-lg);
  font-weight: 600;
  color: var(--color-text-title);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md) var(--spacing-xl);
}

.setting-row {
  display: grid;
  grid-template-columns: 160px 1fr;
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


::deep(.settings-grid .el-switch) {
  --el-switch-on-color: var(--color-primary);
  --el-switch-off-color: var(--el-border-color);
}

::deep(.settings-grid .el-select) {
  width: 100%;
}

::deep(.settings-grid .el-input) {
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

::deep(.modern-input .el-input__wrapper) {
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-input);
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
  background: var(--bg-container);
}

::deep(.modern-input .el-input__wrapper:hover) {
  border-color: var(--color-gray-300);
  box-shadow: var(--shadow-md);
}

::deep(.modern-input.is-focus .el-input__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

::deep(.modern-input .el-input__inner) {
  
  color: var(--text-title);
  font-weight: 400;
}

::deep(.modern-input .el-input__inner::placeholder) {
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

/* 配置编辑面板 */
.config-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.config-json-editor-wrap {
  flex: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1.5px solid var(--border-color-medium);
  transition: border-color 0.2s ease;
  min-height: 280px;
}

.config-json-editor-wrap:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

:deep(.config-json-editor) {
  height: 100%;
  .el-textarea__inner {
    height: 280px;
    min-height: 280px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.6;
    border: none;
    box-shadow: none;
    resize: none;
    border-radius: var(--radius-lg);
  }
}

.config-panel-actions {
  display: flex;
  justify-content: flex-start;
}

.system-config-btn {
  background: var(--bg-panel);
  color: var(--text-secondary);
  border: 1px solid var(--border-color-medium);
}

.system-config-btn:hover {
  background: var(--bg-panel-hover);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* footer-actions、dialog-cancel-btn、dialog-confirm-btn 基础样式已移至 @/styles/common.scss */

/* 提交设置 - 单列布局 */
.commit-settings-grid {
  grid-template-columns: 1fr !important;
}

.commit-settings-grid .setting-label {
  text-align: left;
  padding-right: 0;
}

/* AI 模型配置 */
.model-section-title {
  justify-content: space-between;
}

.add-model-btn {
  font-size: var(--font-size-xs);
  padding: 4px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-primary);
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}

.add-model-btn:hover {
  background: var(--color-primary);
  color: #fff;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.model-empty {
  font-size: var(--font-size-sm);
  color: var(--el-text-color-secondary);
  padding: 12px 0;
}

.model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  transition: border-color 0.2s;
}

.model-card:hover {
  border-color: var(--color-primary);
}

.model-info {
  flex: 1;
  min-width: 0;
}

.model-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.model-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-title);
}

.model-default-badge {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: rgba(64, 158, 255, 0.12);
  color: var(--color-primary);
  font-weight: 500;
}

.model-meta {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.model-btn {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: all 0.2s;
}

.model-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.model-btn--danger:hover {
  border-color: var(--el-color-danger);
  color: var(--el-color-danger);
}

.model-form {
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  margin-top: 4px;
}

.model-form-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-title);
  margin-bottom: 14px;
}

.model-form-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}

.model-form-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: var(--spacing-md);
  align-items: center;
}

.model-form-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--el-text-color-regular);
  text-align: right;
  padding-right: var(--spacing-base);
}

.model-form-label .req {
  color: var(--el-color-danger);
  margin-left: 2px;
}

.model-form-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.model-test-result {
  flex: 1;
  min-width: 0;
}

.model-test-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--radius-lg);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-test-badge--ok {
  background: rgba(103, 194, 58, 0.12);
  color: #4caf50;
  border: 1px solid rgba(103, 194, 58, 0.3);
}

.model-test-badge--fail {
  background: rgba(245, 108, 108, 0.1);
  color: var(--el-color-danger);
  border: 1px solid rgba(245, 108, 108, 0.25);
}

.model-test-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.2s;
}

.model-test-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.model-test-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes model-spin {
  to { transform: rotate(360deg); }
}

.model-test-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: model-spin 0.7s linear infinite;
}

.preset-option-name {
  display: block;
  font-size: var(--font-size-sm);
  color: var(--color-text-title);
  font-weight: 500;
}

.preset-option-url {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 1px;
}

:deep(.el-select-dropdown__item) {
  height: auto;
  padding: 6px 12px;
  line-height: 1.3;
}
</style>
