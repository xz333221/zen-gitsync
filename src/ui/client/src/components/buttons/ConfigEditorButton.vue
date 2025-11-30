<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref } from 'vue'
import { useConfigStore } from '@stores/configStore'
import { ElMessage } from 'element-plus'
import { Edit, Check, Warning } from '@element-plus/icons-vue'
import CommonDialog from '@components/CommonDialog.vue'
import IconButton from '@components/IconButton.vue'

interface Props {
  variant?: 'icon' | 'text'
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'icon'
})

const configStore = useConfigStore()

// 配置JSON编辑器
const configEditorVisible = ref(false)
const configEditorText = ref('')
const configEditorSaving = ref(false)

// 配置文件格式警告弹窗
const configWarningVisible = ref(false)
const configWarningMessage = ref('')

// 打开配置编辑器
async function openConfigEditor() {
  try {
    // 检查系统配置文件格式
    const formatCheckResp = await fetch('/api/config/check-file-format')
    const formatCheckData = await formatCheckResp.json()
    
    let warningMessage = ''
    if (!formatCheckData.success) {
      warningMessage = formatCheckData.message || $t('@76872:配置文件格式可能有问题')
    }
    
    const cfg = configStore.config
    // 使用当前配置填充编辑器
    configEditorText.value = JSON.stringify(cfg, null, 2)
    
    // 如果有警告信息，先显示提示
    if (warningMessage) {
      configWarningMessage.value = warningMessage
      configWarningVisible.value = true
      return // 停止执行，等待用户选择
    }
    
    configEditorVisible.value = true
  } catch (e) {
    ElMessage.error($t('@76872:加载配置失败'))
  }
}

// 保存完整配置
async function saveFullConfig() {
  try {
    configEditorSaving.value = true
    let parsed: any
    try {
      parsed = JSON.parse(configEditorText.value)
    } catch (e: any) {
      ElMessage.error(`${$t('@76872:JSON 解析失败: ')}${e.message || e}`)
      return
    }

    const resp = await fetch('/api/config/saveAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    })

    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@76872:保存失败: ')}${data.error || $t('@76872:未知错误')}`)
      return
    }

    // 重新加载配置
    await configStore.loadConfig()

    // 尝试刷新Git状态
    try {
      const { useGitStore } = await import('@stores/gitStore')
      const gitStore = useGitStore()
      if (gitStore.fetchStatus) {
        await gitStore.fetchStatus()
      }
    } catch {}
    ElMessage.success($t('@76872:配置已保存'))
    configEditorVisible.value = false
  } catch (err: any) {
    ElMessage.error(`${$t('@76872:保存配置失败: ')}${err.message || err}`)
  } finally {
    configEditorSaving.value = false
  }
}

// 打开系统配置文件
async function openSystemConfigFile() {
  try {
    const resp = await fetch('/api/config/open-file', {
      method: 'POST'
    })
    const data = await resp.json()
    if (data.success) {
      ElMessage.success($t('@76872:已用系统程序打开配置文件'))
    } else {
      ElMessage.error(data.error || $t('@76872:打开文件失败'))
    }
  } catch (err: any) {
    ElMessage.error(`${$t('@76872:打开文件失败: ')}${err.message || err}`)
  }
}

// 处理配置警告弹窗的操作
function handleConfigWarningAction(action: 'cancel' | 'open' | 'continue') {
  configWarningVisible.value = false
  
  if (action === 'continue') {
    // 继续编辑 - 打开JSON编辑器
    configEditorVisible.value = true
  } else if (action === 'open') {
    // 打开系统配置文件
    openSystemConfigFile()
  }
  // 取消则什么都不做
}

// 暴露方法给父组件
defineExpose({ openConfigEditor })
</script>

<template>
  <div class="config-editor-button">
    <!-- 编辑配置按钮 -->
    <IconButton
      v-if="props.variant === 'icon'"
      :tooltip="$t('@F13B4:编辑项目配置')"
      size="large"
      @click="openConfigEditor"
    >
      <el-icon><Edit /></el-icon>
    </IconButton>
    <button
      v-else
      class="action-button"
      @click="openConfigEditor"
    >
      <el-icon><Edit /></el-icon>
      {{ $t('@F13B4:编辑项目配置') }}
    </button>

    <!-- 配置JSON编辑弹窗 -->
    <CommonDialog
      v-model="configEditorVisible"
      :title="$t('@76872:编辑配置 JSON')"
      size="large"
      height-mode="fixed"
      custom-class="config-editor-dialog"
      append-to-body
    >
      <!-- 编辑器头部信息 -->
      <div class="editor-header">
        <div class="editor-info">
          <el-icon class="info-icon"><Edit /></el-icon>
          <span class="info-text">{{ $t('@76872:编辑当前项目的配置文件') }}</span>
        </div>
        <div class="editor-tips">
          <el-tag size="small" type="info">{{ $t('@76872:支持JSON格式') }}</el-tag>
        </div>
      </div>
      
      <!-- JSON编辑器 -->
      <div class="json-editor-wrapper">
        <el-input
          v-model="configEditorText"
          type="textarea"
          spellcheck="false"
          autocomplete="off"
          :placeholder="$t('@76872:在此编辑当前项目配置的 JSON...')"
          class="json-editor"
        />
      </div>

      <template #footer>
        <div class="editor-footer">
          <button 
            type="button"
            class="dialog-cancel-btn system-config-btn"
            @click="openSystemConfigFile"
          >
            <span>{{ $t('@76872:打开系统配置文件') }}</span>
          </button>
          <div class="footer-actions">
            <button 
              type="button"
              class="dialog-cancel-btn" 
              @click="configEditorVisible = false"
            >
              {{ $t('@76872:取消') }}
            </button>
            <button 
              type="button"
              class="dialog-confirm-btn"
              :disabled="configEditorSaving"
              @click="saveFullConfig"
            >
              <el-icon v-if="!configEditorSaving"><Check /></el-icon>
              <el-icon v-else class="is-loading">
                <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
                  <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z" />
                </svg>
              </el-icon>
              <span>{{ $t('@76872:保存配置') }}</span>
            </button>
          </div>
        </div>
      </template>
    </CommonDialog>

    <!-- 配置文件格式警告弹窗 -->
    <el-dialog
      v-model="configWarningVisible"
      :title="$t('@76872:配置文件格式提示')"
      width="500px"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
    >
      <div class="config-warning-content">
        <el-icon class="warning-icon" color="var(--color-danger)" size="24">
          <Warning />
        </el-icon>
        <p class="warning-message">{{ configWarningMessage }}</p>
      </div>
      <template #footer>
        <span class="dialog-footer">
          <el-button @click="handleConfigWarningAction('cancel')">{{ $t('@76872:取消') }}</el-button>
          <el-button type="info" @click="handleConfigWarningAction('open')">{{ $t('@76872:打开系统配置文件') }}</el-button>
          <el-button type="primary" @click="handleConfigWarningAction('continue')">{{ $t('@76872:继续编辑') }}</el-button>
        </span>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.config-editor-button {
  display: inline-block;
}

// 编辑器头部
.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md);
  background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
  border-radius: var(--radius-lg);
  border: 1px solid #bae6fd;
}

.editor-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}

.info-icon {
  color: #0ea5e9;
  font-size: var(--font-size-lg);
}

.info-text {
  
  font-weight: 500;
  color: #0c4a6e;
}

// JSON编辑器
.json-editor-wrapper {
  flex-grow: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 2px solid var(--color-gray-200);
  transition: border-color 0.3s ease;

  &:focus-within {
    border-color: #3b82f6;
  }
}

:deep(.json-editor) {
  height: 100%;

  .el-textarea__inner {
    height: 100%;
    border: none;
    border-radius: 0;
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    font-size: var(--font-size-sm);
    line-height: 1.6;
    resize: none;
    padding: var(--spacing-lg);

    &:focus {
      box-shadow: none;
    }
  }
}

// 编辑器底部
.editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-md);
}

.footer-actions {
  display: flex;
  gap: var(--spacing-md);
}

.dialog-cancel-btn,
.dialog-confirm-btn {
  padding: var(--spacing-base) var(--spacing-xl);
  border-radius: var(--radius-md);
  
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  border: 1px solid transparent;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.dialog-cancel-btn {
  background: var(--color-gray-100);
  color: var(--color-gray-700);
  border-color: var(--color-gray-200);

  &:hover:not(:disabled) {
    background: var(--color-gray-200);
  }

  &.system-config-btn {
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    color: #92400e;
    border-color: #fbbf24;

    &:hover {
      background: linear-gradient(135deg, #fde68a 0%, #fcd34d 100%);
    }
  }
}

.dialog-confirm-btn {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;

  &:hover:not(:disabled) {
    background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
  }
}

// 警告弹窗
.config-warning-content {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: #fef2f2;
  border-radius: var(--radius-lg);
  border: 1px solid #fecaca;
}

.warning-icon {
  flex-shrink: 0;
  margin-top: var(--spacing-xs);
}

.warning-message {
  flex: 1;
  margin: 0;
  
  color: #991b1b;
  line-height: 1.6;
}
</style>
