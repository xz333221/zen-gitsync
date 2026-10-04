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
import { ref, watch, nextTick } from 'vue'
import { Loading, CircleCheck, CircleClose } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import CommonDialog from '@/components/CommonDialog.vue'

type Status = 'running' | 'success' | 'failed'

/**
 * 升级失败时给用户的手动自救命令。
 * 自动升级在少数环境（无写权限的 npm prefix、被劫持的 sudo 等）注定失败，
 * 与其让用户卡在"重试"循环里，不如直接把命令递到他手上。
 */
const MANUAL_COMMAND = 'npm install -g zen-gitsync --registry https://registry.npmjs.org/'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    logs: string
    status: Status
    /** 升级成功后离自动刷新的剩余秒数；0 表示未启动倒计时 */
    countdown?: number
  }>(),
  {
    countdown: 0
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'retry'): void
  (e: 'restart'): void
  /** 用户选择"稍后手动重启"或关闭弹窗 → 通知父级取消自动刷新倒计时 */
  (e: 'cancel'): void
}>()

const logEl = ref<HTMLElement | null>(null)

// 日志自动滚到底
watch(
  () => props.logs,
  async () => {
    await nextTick()
    if (logEl.value) {
      logEl.value.scrollTop = logEl.value.scrollHeight
    }
  }
)

function close() {
  if (props.status === 'running') {
    // 升级中不允许关闭，避免误操作
    return
  }
  // success / failed 状态下关闭 = 用户放弃自动刷新
  if (props.status === 'success' && props.countdown > 0) {
    emit('cancel')
  }
  emit('update:modelValue', false)
}

function onRetry() {
  emit('retry')
}

function onRestart() {
  // 主动点"立即重启"= 跳过倒计时，立即触发父级重启
  emit('restart')
}

function onLater() {
  // 明确取消自动刷新
  emit('cancel')
  emit('update:modelValue', false)
}

/** 复制手动安装命令，让用户在自动升级失败后仍能自助完成升级 */
async function onCopyCommand() {
  try {
    await navigator.clipboard.writeText(MANUAL_COMMAND)
    ElMessage.success($t('@F13B4:已复制升级命令'))
  } catch {
    // clipboard API 在非安全上下文/无权限时会失败，提示用户手动复制
    ElMessage.warning($t('@F13B4:复制失败，请手动复制'))
  }
}
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :title="$t('@F13B4:升级')"
    width="680px"
    type="flex"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="status !== 'running'"
    append-to-body
    @close="close"
  >
    <div class="upgrade-status" :class="`is-${status}`">
      <el-icon v-if="status === 'running'" class="is-loading"><Loading /></el-icon>
      <el-icon v-else-if="status === 'success'" color="var(--color-success)"><CircleCheck /></el-icon>
      <el-icon v-else color="var(--color-danger)"><CircleClose /></el-icon>
      <span v-if="status === 'running'">{{ $t('@F13B4:升级中') }}</span>
      <span v-else-if="status === 'success'">{{ $t('@F13B4:升级完成') }}</span>
      <span v-else>{{ $t('@F13B4:升级失败') }}</span>
    </div>

    <p v-if="status === 'success'" class="upgrade-hint">
      {{ $t('@F13B4:新版本已全局安装，需要重启服务才能生效') }}
      <span v-if="countdown > 0" class="upgrade-countdown">
        {{ $t('@F13B4:{seconds} 秒后自动刷新', { seconds: countdown }) }}
      </span>
    </p>

    <p v-if="status === 'failed'" class="upgrade-manual">
      <span class="upgrade-manual__label">{{ $t('@F13B4:手动升级命令') }}</span>
      <code class="upgrade-manual__cmd">{{ MANUAL_COMMAND }}</code>
    </p>

    <pre ref="logEl" class="upgrade-log">{{ logs || $t('@F13B4:等待日志输出') }}</pre>

    <template #footer>
      <el-button v-if="status === 'failed'" type="primary" @click="onRetry">
        {{ $t('@F13B4:重试') }}
      </el-button>
      <el-button v-if="status === 'failed'" @click="onCopyCommand">
        {{ $t('@F13B4:复制升级命令') }}
      </el-button>
      <el-button v-if="status === 'success'" type="primary" @click="onRestart">
        {{ $t('@F13B4:立即重启并刷新') }}
      </el-button>
      <el-button v-if="status === 'success'" @click="onLater">
        {{ $t('@F13B4:稍后手动重启') }}
      </el-button>
      <el-button v-if="status === 'running'" disabled>
        {{ $t('@F13B4:升级中') }}...
      </el-button>
    </template>
  </CommonDialog>
</template>

<style scoped lang="scss">
.upgrade-status {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-bottom: var(--spacing-md);
  font-size: var(--font-size-base);
  font-weight: 500;

  &.is-running {
    color: var(--el-color-primary);
  }
  &.is-success {
    color: var(--color-success-dark);
  }
  &.is-failed {
    color: var(--color-danger-dark);
  }

  .is-loading {
    animation: rotating 2s linear infinite;
  }
}

.upgrade-log {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px;
  border-radius: var(--radius-base);
  height: 320px;
  overflow: auto;
  margin: 0;
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.upgrade-hint {
  margin: 0 0 var(--spacing-md) 0;
  padding: 8px 12px;
  /* 2026-10-04：这里原本是 border-left: 3px/4px 的**侧边色条**，属
   PRODUCT.md 反参考里禁掉的形态（禁在卡片/列表项/callout 上用 >1px 的
   border-left 当彩色强调）。已换成「同色系淡底 + 1px 同色系描边」，
   语义（这里是成功/失败/冲突）不变，权重不再靠一根竖条。 */
  background: rgba(103, 194, 58, 0.08);
  border: 1px solid color-mix(in srgb, var(--color-success) 26%, transparent);
  border-radius: var(--radius-base);
  color: var(--color-success-dark);
  font-size: var(--font-size-mid);
}

.upgrade-countdown {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  background: var(--el-color-success);
  color: #fff;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 600;
  animation: pulse 1s ease-in-out infinite;
}

/* 失败态的手动升级命令:给被自动升级卡住的用户一条自助出口 */
.upgrade-manual {
  margin: 0 0 var(--spacing-md) 0;
  padding: 8px 12px;
  background: rgba(245, 108, 108, 0.08);
  border: 1px solid color-mix(in srgb, var(--color-danger) 26%, transparent);
  border-radius: var(--radius-base);
  font-size: var(--font-size-mid);

  &__label {
    display: block;
    margin-bottom: 4px;
    color: var(--color-danger-dark);
    font-weight: 500;
  }

  &__cmd {
    display: block;
    padding: 6px 8px;
    background: rgba(0, 0, 0, 0.04);
    border-radius: var(--radius-base);
    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
    font-size: var(--font-size-sm);
    color: var(--text-primary, #303133);
    word-break: break-all;
    user-select: all;
  }
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
