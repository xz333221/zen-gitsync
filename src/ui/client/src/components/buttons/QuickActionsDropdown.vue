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
<!--
  QuickActionsDropdown —— 「提交并推送 ▾」
  2026-10-16 走查 P2-1：动作区原来一行 6 个按钮、5 种视觉权重（两颗几乎同色的深蓝
  实心「一键提交 / 一键推送所有」+ 一颗实心紫 AI），主次扫不出来。本组件把两颗
  「一键」合并成一个下拉：动作区收敛为
    [暂存][提交][推送]（中性描边） + [提交并推送 ▾]（唯一实心蓝） + [AI 提交并推送]（紫描边）
  要点：
  · 动作逻辑/禁用口径/标题副标题**仍由 QuickCommitButton / QuickPushButton 承担** ——
    它们在本组件里隐藏挂载当「引擎」，菜单项从引擎 expose 读状态与文案（一处口径、两个出口），
    不在本文件复制任何分支判断。
  · 引擎必须真挂载：PushProgressModal 等交互都在引擎里，隐藏只是 display:none；
    EP 对话框自带 append-to-body，不受父级隐藏影响。
  · 触发器的 busy（引擎 loading 时）把 caret 换成转圈 —— 菜单点完即收起，
    这里是唯一常驻的进度反馈位。
  · ⚠️ 菜单 popper teleport 到 body，scoped 选择器命不中 → 相关样式写在文件末尾
    第二段非 scoped <style> 里，统一挂 .qa-dropdown-popper 前缀防外溢。
  -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { Loading } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import QuickCommitButton from './QuickCommitButton.vue'
import QuickPushButton from './QuickPushButton.vue'

interface Props {
  hasUserCommitMessage?: boolean
  finalCommitMessage?: string
  skipHooks?: boolean
  from?: 'form' | 'drawer'
}

const props = withDefaults(defineProps<Props>(), {
  hasUserCommitMessage: false,
  finalCommitMessage: '',
  skipHooks: false,
  from: 'form'
})

const emit = defineEmits<{
  afterCommit: [success: boolean]
  afterPush: [success: boolean]
  beforePush: []
  pushStart: []
  clearFields: []
}>()

// ── 引擎 ────────────────────────────────────────────────────────
const quickCommitRef = ref<InstanceType<typeof QuickCommitButton> | null>(null)
const quickPushRef = ref<InstanceType<typeof QuickPushButton> | null>(null)

// 从引擎 expose 读状态/文案：`ref.value?.xxx` 会经公开实例代理解包 computed（实测
// typeof 为 boolean/string），读取同样建立依赖，引擎状态一变这里跟着变。
// ⚠️ 时机：首次渲染时引擎 ref 还没绑定（拿到 undefined → 走 `?? true` 保守兜底），
// mount 后 ref 绑定会触发重渲染，下一个 tick 起才是真实值。
const commitDisabled = computed(() => quickCommitRef.value?.isDisabled ?? true)
const commitLoading = computed(() => quickCommitRef.value?.isLoading ?? false)
const commitTitle = computed(() => quickCommitRef.value?.buttonTitle ?? $t('@2E184:一键提交'))
const commitDesc = computed(() =>
  commitDisabled.value
    ? (quickCommitRef.value?.tooltipText ?? '')
    : (quickCommitRef.value?.buttonDesc ?? '')
)
const commitTooltip = computed(() => quickCommitRef.value?.tooltipText ?? '')

const pushDisabled = computed(() => quickPushRef.value?.isDisabled ?? true)
const pushLoading = computed(() => quickPushRef.value?.isLoading ?? false)
const pushTitle = computed(() => quickPushRef.value?.buttonTitle ?? $t('@2E184:一键推送所有'))
const pushDesc = computed(() =>
  pushDisabled.value
    ? (quickPushRef.value?.tooltipText ?? '')
    : (quickPushRef.value?.buttonDesc ?? '')
)
const pushTooltip = computed(() => quickPushRef.value?.tooltipText ?? '')

const busy = computed(() => commitLoading.value || pushLoading.value)
/** 两档都不可用 → 触发器退回禁用层观感（口径与 GitActionButtons 的禁用层一致） */
const allDisabled = computed(() => commitDisabled.value && pushDisabled.value)

// 触发器副标题跟随推送档：纯推送时它自己会说「推送到远程仓库」（QP-09 的口径）
const triggerDesc = computed(() => quickPushRef.value?.buttonDesc || $t('@2E184:暂存 + 提交 + 推送'))

function handleCommand(cmd: string | number | object) {
  if (cmd === 'commit') quickCommitRef.value?.triggerQuickCommit()
  else if (cmd === 'push') quickPushRef.value?.triggerQuickPush()
}

// 兼容 GitActionButtons 原来的 expose 链（Enter 键 / AI 提交流程都经 triggerQuickPush）
defineExpose({
  triggerQuickPush: () => quickPushRef.value?.triggerQuickPush()
})
</script>

<template>
  <div class="qa-wrap">
    <el-dropdown trigger="click" placement="bottom-start" popper-class="qa-dropdown-popper" @command="handleCommand">
      <div
        class="qa-trigger"
        :class="{ 'is-quiet': allDisabled, 'is-busy': busy }"
        role="button"
        tabindex="0"
        :aria-label="$t('@2E184:提交并推送')"
        :title="pushTooltip"
      >
        <div class="qa-trigger__text">
          <span class="qa-trigger__title">{{ $t('@2E184:提交并推送') }}</span>
          <span class="qa-trigger__desc">{{ triggerDesc }}</span>
        </div>
        <el-icon v-if="busy" class="is-loading qa-trigger__caret"><Loading /></el-icon>
        <!-- chevron-down（Tabler icons，MIT） -->
        <svg
          v-else
          class="qa-trigger__caret"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path d="M6 9l6 6l6 -6" />
        </svg>
      </div>

      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item :disabled="commitDisabled" command="commit">
            <div class="qa-item">
              <!-- git-commit（Tabler icons，MIT） -->
              <svg
                class="qa-item__icon"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />
                <path d="M12 3l0 6" />
                <path d="M12 15l0 6" />
              </svg>
              <div class="qa-item__text">
                <span class="qa-item__title">{{ commitTitle }}</span>
                <span class="qa-item__desc">{{ commitDesc || commitTooltip }}</span>
              </div>
            </div>
          </el-dropdown-item>
          <el-dropdown-item :disabled="pushDisabled" command="push">
            <div class="qa-item">
              <!-- cloud-upload（Tabler icons，MIT） -->
              <svg
                class="qa-item__icon"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1" />
                <path d="M9 15l3 -3l3 3" />
                <path d="M12 12l0 9" />
              </svg>
              <div class="qa-item__text">
                <span class="qa-item__title">{{ pushTitle }}</span>
                <span class="qa-item__desc">{{ pushDesc || pushTooltip }}</span>
              </div>
            </div>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!-- 引擎：口径的唯一出处，只挂载不显示（见文件头注释） -->
    <div class="qa-engines" aria-hidden="true">
      <QuickCommitButton
        ref="quickCommitRef"
        :from="props.from"
        :has-user-commit-message="props.hasUserCommitMessage"
        :final-commit-message="props.finalCommitMessage"
        :skip-hooks="props.skipHooks"
        @after-commit="(success: boolean) => emit('afterCommit', success)"
        @clear-fields="() => emit('clearFields')"
      />
      <QuickPushButton
        ref="quickPushRef"
        :from="props.from"
        :has-user-commit-message="props.hasUserCommitMessage"
        :final-commit-message="props.finalCommitMessage"
        :skip-hooks="props.skipHooks"
        @before-push="() => emit('beforePush')"
        @push-start="() => emit('pushStart')"
        @after-push="(success: boolean) => emit('afterPush', success)"
        @clear-fields="() => emit('clearFields')"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.qa-wrap {
  display: flex;
  height: 100%;
}

.qa-engines {
  display: none;
}

/* 触发器 = 原「一键」双按钮的合并替身：实心深蓝，动作区唯一的实心蓝。
   白字在 --color-primary-dark 上 ≈5.2:1（AA），沿用旧口径。 */
.qa-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 4px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-primary-dark);
  color: #fff;
  cursor: pointer;
  user-select: none;
  transition: var(--transition-ui-slow);

  &:hover {
    background: color-mix(in srgb, var(--color-primary-dark) 88%, #000);
    box-shadow: var(--shadow-md);
  }

  &:active {
    transform: scale(0.98);
  }

  &:focus-visible {
    outline: var(--focus-outline);
    outline-offset: 2px;
  }

  /* 两档都不可用：与 GitActionButtons 的禁用层同口径（身份 wash + 可读淡字） */
  &.is-quiet {
    background: var(--tint-primary-12);
    box-shadow: none;
    cursor: not-allowed;

    .qa-trigger__title {
      color: var(--text-secondary);
    }

    .qa-trigger__desc {
      color: var(--text-meta);
    }

    .qa-trigger__caret {
      color: var(--text-meta);
    }
  }

  .qa-trigger__text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .qa-trigger__title {
    font-size: var(--font-size-mid);
  }

  .qa-trigger__desc {
    font-size: var(--font-size-xs);
    font-weight: 400;
    letter-spacing: 0.1px;
    /* 11px 小字压深蓝端，保住 4.5:1（沿用旧按钮口径，别再压透明度） */
    opacity: 0.9;
  }

  .qa-trigger__caret {
    opacity: 0.85;
    flex-shrink: 0;
  }
}
</style>

<!-- popper 内容 teleport 到 body：scoped 选择器命不中，单独一段非 scoped 样式，
     统一挂 .qa-dropdown-popper 前缀防外溢 -->
<style lang="scss">
.qa-dropdown-popper {
  .el-dropdown-menu {
    min-width: 236px;
    padding: 6px;
  }

  .el-dropdown-menu__item {
    padding: 0;
    border-radius: var(--radius-md);
    line-height: 1.4;

    &:hover:not(.is-disabled) {
      background: var(--soft-btn-bg-hover, var(--tint-primary-06));
    }
  }

  .qa-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    width: 100%;
  }

  .qa-item__icon {
    flex-shrink: 0;
    color: var(--color-primary-dark);
  }

  .qa-item__text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
  }

  .qa-item__title {
    font-size: var(--font-size-mid);
    color: var(--text-primary);
  }

  .qa-item__desc {
    font-size: var(--font-size-xs);
    color: var(--text-meta);
  }

  /* 禁用项：保留可读性（说明为什么点不了），EP 默认灰底 opacity 观感太糊 */
  .el-dropdown-menu__item.is-disabled {
    opacity: 1;
    cursor: not-allowed;

    .qa-item__icon {
      color: var(--text-disabled, var(--text-meta));
    }

    .qa-item__title {
      color: var(--text-meta);
    }

    .qa-item__desc {
      color: var(--text-disabled, var(--text-meta));
    }
  }
}
</style>
