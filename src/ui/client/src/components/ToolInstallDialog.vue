<!--
  Copyright 2026 xz333221
  Licensed under the Apache License, Version 2.0.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CopyDocument, Download, Refresh, SuccessFilled, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import CommonDialog from '@components/CommonDialog.vue'
import { $t } from '@/lang/static'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'

const props = defineProps<{
  modelValue: boolean
  tool: ToolId | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'installed', tool: ToolId): void
}>()

const toolsStore = useToolsStore()
const status = ref<'idle' | 'launching' | 'waiting' | 'installed' | 'error'>('idle')
const errorMessage = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollCount = 0

const toolNames: Record<ToolId, string> = {
  vscode: 'Visual Studio Code',
  claude: 'Claude Code',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  zcode: 'ZCode',
}

const toolName = computed(() => props.tool ? toolNames[props.tool] : '')
const installer = computed(() => props.tool ? toolsStore.installers[props.tool] : undefined)
const platformName = computed(() => {
  if (toolsStore.platform === 'win32') return 'Windows'
  if (toolsStore.platform === 'darwin') return 'macOS'
  if (toolsStore.platform === 'linux') return 'Linux'
  return toolsStore.platform || $t('@TINST:当前系统')
})

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function recheck() {
  if (!props.tool) return
  await toolsStore.checkTools()
  if (toolsStore.isToolAvailable(props.tool)) {
    status.value = 'installed'
    stopPolling()
    emit('installed', props.tool)
  }
}

function startPolling() {
  stopPolling()
  pollCount = 0
  pollTimer = setInterval(async () => {
    pollCount += 1
    await recheck()
    // 最多自动检测 2 分钟；用户仍可手动点击“重新检测”。
    if (pollCount >= 24) stopPolling()
  }, 5000)
}

async function install() {
  if (!props.tool || !installer.value?.supported || status.value === 'launching') return
  status.value = 'launching'
  errorMessage.value = ''
  try {
    const response = await fetch('/api/install-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: props.tool }),
    })
    const result = await response.json()
    if (!response.ok || !result.success) {
      throw new Error(result.error || $t('@TINST:启动安装失败'))
    }
    status.value = 'waiting'
    ElMessage.success(result.message || $t('@TINST:安装命令已在新终端中启动'))
    startPolling()
  } catch (error) {
    status.value = 'error'
    errorMessage.value = (error as Error).message
  }
}

async function copyCommand() {
  if (!installer.value?.command) return
  try {
    await navigator.clipboard.writeText(installer.value.command)
    ElMessage.success($t('@TINST:安装命令已复制'))
  } catch {
    ElMessage.error($t('@TINST:复制失败'))
  }
}

function openDocs() {
  if (!installer.value?.docsUrl) return
  window.open(installer.value.docsUrl, '_blank', 'noopener,noreferrer')
}

function closeDialog() {
  stopPolling()
  emit('update:modelValue', false)
}

watch(() => [props.modelValue, props.tool] as const, ([visible]) => {
  if (visible) {
    status.value = 'idle'
    errorMessage.value = ''
    void toolsStore.checkTools()
  } else {
    stopPolling()
  }
})

onBeforeUnmount(stopPolling)
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    :title="$t('@TINST:安装 {tool}', { tool: toolName })"
    size="small"
    custom-class="tool-install-dialog"
    :destroy-on-close="true"
    @update:model-value="emit('update:modelValue', $event)"
    @close="closeDialog"
  >
    <div v-if="installer" class="tool-install">
      <div class="tool-install__summary">
        <div class="tool-install__icon" aria-hidden="true">
          <Download />
        </div>
        <div>
          <strong>{{ $t('@TINST:未检测到 {tool}', { tool: toolName }) }}</strong>
          <p>{{ $t('@TINST:适用于 {platform} 的安装方式', { platform: platformName }) }}</p>
        </div>
      </div>

      <div class="tool-install__method">
        <span class="tool-install__label">{{ installer.packageManager }}</span>
        <div class="tool-install__command-row">
          <code>{{ installer.command }}</code>
          <el-button circle text :aria-label="$t('@TINST:复制安装命令')" @click="copyCommand">
            <el-icon><CopyDocument /></el-icon>
          </el-button>
        </div>
        <p class="tool-install__note">{{ installer.note }}</p>
      </div>

      <div v-if="status === 'waiting'" class="tool-install__status is-waiting">
        <el-icon class="is-loading"><Refresh /></el-icon>
        <span>{{ $t('@TINST:正在等待安装完成，完成后会自动检测') }}</span>
      </div>
      <div v-else-if="status === 'installed'" class="tool-install__status is-success">
        <el-icon><SuccessFilled /></el-icon>
        <span>{{ $t('@TINST:安装已检测成功，现在可以直接打开') }}</span>
      </div>
      <div v-else-if="status === 'error'" class="tool-install__status is-error">
        <el-icon><WarningFilled /></el-icon>
        <span>{{ errorMessage }}</span>
      </div>

      <p v-if="status === 'waiting'" class="tool-install__restart-hint">
        {{ $t('@TINST:若安装完成后仍未检测到，请重启 ZenGitSync 服务以刷新 PATH') }}
      </p>
    </div>

    <div v-else class="tool-install__loading">
      {{ $t('@TINST:正在获取安装方式') }}...
    </div>

    <template #footer>
      <div class="tool-install__footer">
        <el-button @click="openDocs">{{ $t('@TINST:查看官方文档') }}</el-button>
        <el-button v-if="status === 'waiting'" :loading="toolsStore.isChecking" @click="recheck">
          {{ $t('@TINST:重新检测') }}
        </el-button>
        <el-button
          v-if="installer?.supported && status !== 'installed'"
          type="primary"
          :loading="status === 'launching'"
          @click="install"
        >
          {{ $t('@TINST:一键安装') }}
        </el-button>
        <el-button v-else-if="status === 'installed'" type="primary" @click="closeDialog">
          {{ $t('@TINST:完成') }}
        </el-button>
      </div>
    </template>
  </CommonDialog>
</template>

<style scoped lang="scss">
.tool-install {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.tool-install__summary {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);

  p {
    margin: 4px 0 0;
    color: var(--text-secondary);
    font-size: 13px;
  }
}

.tool-install__icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border-radius: 10px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);

  svg { width: 22px; height: 22px; }
}

.tool-install__method {
  padding: var(--spacing-md);
  border: 1px solid var(--border-color);
  border-radius: var(--dialog-radius-sm);
  background: var(--bg-panel);
}

.tool-install__label {
  display: block;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

.tool-install__command-row {
  display: flex;
  align-items: center;
  gap: 8px;

  code {
    flex: 1;
    min-width: 0;
    padding: 9px 10px;
    overflow-x: auto;
    border-radius: 6px;
    background: var(--bg-container);
    color: var(--text-primary);
    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    white-space: nowrap;
  }
}

.tool-install__note,
.tool-install__restart-hint {
  margin: 9px 0 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.tool-install__status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 7px;
  font-size: 13px;

  &.is-waiting { color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 8%, transparent); }
  &.is-success { color: var(--el-color-success); background: color-mix(in srgb, var(--el-color-success) 8%, transparent); }
  &.is-error { color: var(--el-color-danger); background: color-mix(in srgb, var(--el-color-danger) 8%, transparent); }
}

.tool-install__loading {
  padding: 24px;
  color: var(--text-secondary);
  text-align: center;
}

.tool-install__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
</style>
