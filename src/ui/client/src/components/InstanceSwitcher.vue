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
import { computed, ref } from 'vue'
import { ElDropdown, ElDropdownMenu, ElDropdownItem, ElIcon, ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Close, Loading } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import { useInstancesStore } from '@/stores/instancesStore'
import { getFolderNameFromPath } from '@/utils/path'
import type { InstanceInfo } from '@/types/instances'

const store = useInstancesStore()
const dropdownVisible = ref(false)
const closingPid = ref<number | null>(null)
const closingAll = ref(false)

// 列表为空时不渲染（单实例用户无意义）
const hasAny = computed(() => store.list.length > 0)

const count = computed(() => store.list.length)
const otherCount = computed(() => store.otherInstances.length)

// 是否有可以批量关闭的非当前实例
const canCloseAll = computed(() => otherCount.value > 0)

// 触发器文本：总数 + 当前项目名
const triggerText = computed(() => `${count.value} ${$t('@INSSW:个实例')}`)

function handleOpen(port: number) {
  if (!port) return
  window.open(`http://localhost:${port}`, '_blank', 'noopener')
}

function pathSubtitle(instance: InstanceInfo): string {
  return getFolderNameFromPath(instance.projectPath) || instance.projectName
}

function instanceInitial(instance: InstanceInfo): string {
  return (instance.projectName || pathSubtitle(instance) || '?').slice(0, 1).toUpperCase()
}

async function requestClose(instance: InstanceInfo) {
  if (closingPid.value != null || closingAll.value) return
  try {
    await ElMessageBox.confirm(
      $t('@INSSW:关闭实例确认内容', { name: instance.projectName, port: instance.port }),
      $t('@INSSW:关闭实例'),
      {
        confirmButtonText: $t('@INSSW:确认关闭'),
        cancelButtonText: $t('@INSSW:取消'),
        type: 'warning',
        autofocus: false,
      },
    )
  } catch {
    return
  }

  closingPid.value = instance.pid
  try {
    await store.closeInstance(instance.pid)
    ElMessage.success($t('@INSSW:实例已关闭', { name: instance.projectName }))
  } catch (error) {
    ElMessage.error(`${$t('@INSSW:关闭实例失败')}: ${(error as Error).message}`)
    await store.refresh()
  } finally {
    closingPid.value = null
  }
}

async function requestCloseAll() {
  if (!canCloseAll.value || closingAll.value) return
  const target = otherCount.value
  try {
    await ElMessageBox.confirm(
      $t('@INSSW:关闭全部实例确认内容', { count: target }),
      $t('@INSSW:关闭全部实例'),
      {
        confirmButtonText: $t('@INSSW:确认关闭'),
        cancelButtonText: $t('@INSSW:取消'),
        type: 'warning',
        autofocus: false,
      },
    )
  } catch {
    return
  }

  closingAll.value = true
  try {
    const result = await store.closeAllInstances()
    if (result.failed === 0) {
      ElMessage.success($t('@INSSW:关闭全部实例成功', { closed: result.closed }))
    } else {
      ElMessage.warning(
        $t('@INSSW:关闭全部实例部分失败', { closed: result.closed, failed: result.failed }),
      )
    }
  } catch (error) {
    ElMessage.error(`${$t('@INSSW:关闭实例失败')}: ${(error as Error).message}`)
    await store.refresh()
  } finally {
    closingAll.value = false
  }
}
</script>

<template>
  <el-dropdown
    v-if="hasAny"
    trigger="click"
    placement="bottom-end"
    popper-class="instance-switcher-popper"
    @command="handleOpen"
    @visible-change="dropdownVisible = $event"
  >
    <button
      type="button"
      class="instance-switcher"
      :class="{ 'is-open': dropdownVisible }"
      :aria-label="triggerText"
      :aria-expanded="dropdownVisible"
    >
      <el-icon class="switcher-icon">
        <!-- apps/layers 图标 -->
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </el-icon>
      <span class="switcher-count">{{ count }}</span>
      <span class="switcher-label">{{ $t('@INSSW:运行中') }}</span>
      <el-icon class="switcher-chevron"><ArrowDown /></el-icon>
    </button>
    <template #dropdown>
      <el-dropdown-menu class="instance-dropdown-menu">
        <li class="instance-menu-header" role="presentation">
          <div>
            <strong>{{ $t('@INSSW:运行中的实例') }}</strong>
            <span>{{ $t('@INSSW:点击实例可在新标签页打开') }}</span>
          </div>
          <div class="instance-header-actions">
            <button
              v-if="canCloseAll"
              type="button"
              class="instance-close-all"
              :class="{ 'is-loading': closingAll }"
              :disabled="closingAll || closingPid != null"
              :aria-label="$t('@INSSW:关闭全部实例')"
              :title="$t('@INSSW:关闭全部实例 {count}', { count: otherCount })"
              @click.stop.prevent="requestCloseAll"
            >
              <el-icon v-if="closingAll"><Loading /></el-icon>
              <el-icon v-else><Close /></el-icon>
              <span>{{ $t('@INSSW:关闭全部实例 {count}', { count: otherCount }) }}</span>
            </button>
            <span class="instance-total">{{ count }}</span>
          </div>
        </li>

        <!-- 当前实例（不可点击） -->
        <el-dropdown-item v-if="store.currentInstance" disabled class="instance-menu-item instance-menu-item--current">
          <div class="instance-row instance-row--current">
            <span class="instance-avatar" aria-hidden="true">{{ instanceInitial(store.currentInstance) }}</span>
            <div class="instance-content">
              <div class="instance-row-main">
                <span class="instance-name">{{ store.currentInstance.projectName }}</span>
                <span class="instance-current-label">{{ $t('@INSSW:当前') }}</span>
              </div>
              <span class="instance-path" :title="store.currentInstance.projectPath">
                {{ store.currentInstance.projectPath }}
              </span>
            </div>
            <span class="port-badge">:{{ store.currentInstance.port }}</span>
          </div>
        </el-dropdown-item>

        <!-- 其他运行中的实例 -->
        <el-dropdown-item
          v-for="inst in store.otherInstances"
          :key="inst.pid"
          :command="inst.port"
          class="instance-menu-item"
        >
          <div class="instance-row">
            <span class="instance-avatar" aria-hidden="true">{{ instanceInitial(inst) }}</span>
            <div class="instance-content">
              <div class="instance-row-main">
                <span class="instance-name">{{ inst.projectName }}</span>
              </div>
              <span class="instance-path" :title="inst.projectPath">{{ inst.projectPath }}</span>
            </div>
            <div class="instance-action">
              <span class="port-badge">:{{ inst.port }}</span>
              <button
                type="button"
                class="instance-close"
                :class="{ 'is-loading': closingPid === inst.pid }"
                :disabled="closingPid != null || closingAll"
                :aria-label="$t('@INSSW:关闭实例 {name}', { name: inst.projectName })"
                :title="$t('@INSSW:关闭实例')"
                @click.stop.prevent="requestClose(inst)"
              >
                <el-icon v-if="closingPid === inst.pid"><Loading /></el-icon>
                <el-icon v-else><Close /></el-icon>
              </button>
            </div>
          </div>
        </el-dropdown-item>

        <!-- 空状态 -->
        <el-dropdown-item v-if="store.otherInstances.length === 0" disabled>
          <span class="instance-empty">{{ $t('@INSSW:无其他运行中的实例') }}</span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.instance-switcher {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  cursor: pointer;
  border-radius: 9px;
  border: 1px solid var(--border-component);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium, 500);
  transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease, color 180ms ease, transform 120ms ease;
  user-select: none;
  flex-shrink: 0;
}

.instance-switcher:hover,
.instance-switcher.is-open {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--bg-container));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 11%, transparent);
  color: var(--text-primary);
}

.instance-switcher:active { transform: scale(0.98); }

.instance-switcher:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.switcher-icon {
  font-size: var(--font-size-lg);
  display: flex;
  align-items: center;
}

.switcher-icon svg {
  width: 16px;
  height: 16px;
}

.switcher-count,
.switcher-label,
.switcher-chevron {
  display: none;
}

.instance-row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: min(340px, calc(100vw - 32px));
  padding: 8px 6px;
}

.instance-row--current {
  position: relative;
}

.instance-row-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.instance-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.instance-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.port-badge {
  flex-shrink: 0;
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 28%, var(--border-color));
  border-radius: 5px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 5%, transparent);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.instance-path {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.instance-avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  color: var(--text-secondary);
  background: var(--bg-panel);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 12px;
  font-weight: 700;
}

.instance-current-label {
  flex-shrink: 0;
  color: var(--color-primary);
  font-size: 10px;
  font-weight: 600;
}

.instance-action {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 42px;
  min-height: 30px;
}

.instance-close {
  position: absolute;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transform: scale(0.86);
  pointer-events: none;
  transition: opacity 150ms ease, transform 150ms ease, color 150ms ease, background 150ms ease;
}

.instance-close:hover {
  color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
}

.instance-close:focus-visible {
  outline: 2px solid var(--el-color-danger);
  outline-offset: 1px;
}

.instance-close.is-loading :deep(svg) {
  animation: rotating 1s linear infinite;
}

.instance-empty {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-style: italic;
}

:global(.instance-switcher-popper.el-popper) {
  overflow: hidden;
  border: 1px solid var(--dialog-border-color);
  border-radius: 12px;
  box-shadow: var(--dialog-shadow);
}

:global(.instance-switcher-popper .el-dropdown-menu) {
  min-width: 354px;
  padding: 6px;
}

:global(.instance-switcher-popper .instance-menu-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 10px 10px;
  border-bottom: 1px solid var(--border-color-light);
  margin-bottom: 4px;
}

:global(.instance-switcher-popper .instance-menu-header > div) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

:global(.instance-switcher-popper .instance-menu-header strong) {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.1px;
}

:global(.instance-switcher-popper .instance-menu-header span) {
  color: var(--text-secondary);
  font-size: 11px;
}

:global(.instance-switcher-popper .instance-menu-header .instance-total) {
  display: grid;
  place-items: center;
  min-width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--text-primary);
  background: var(--bg-panel);
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
  font-size: 11px;
  font-weight: 700;
}

:global(.instance-switcher-popper .instance-header-actions) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

:global(.instance-switcher-popper .instance-close-all) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--el-color-danger) 28%, var(--border-color));
  border-radius: 7px;
  background: color-mix(in srgb, var(--el-color-danger) 4%, transparent);
  color: var(--el-color-danger);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease, opacity 150ms ease;
}

:global(.instance-switcher-popper .instance-close-all:hover) {
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
  border-color: color-mix(in srgb, var(--el-color-danger) 50%, var(--border-color));
}

:global(.instance-switcher-popper .instance-close-all:focus-visible) {
  outline: 2px solid var(--el-color-danger);
  outline-offset: 1px;
}

:global(.instance-switcher-popper .instance-close-all:disabled) {
  cursor: not-allowed;
  opacity: 0.6;
}

:global(.instance-switcher-popper .instance-close-all.is-loading :deep(svg)) {
  animation: rotating 1s linear infinite;
}

:global(.instance-switcher-popper .instance-close-all .el-icon) {
  font-size: 12px;
}

:global(.instance-switcher-popper .instance-menu-item) {
  height: auto;
  padding: 0;
  border-radius: 8px;
  line-height: normal;
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus) {
  background: var(--bg-panel-hover);
}

:global(.instance-switcher-popper .instance-menu-item--current.is-disabled) {
  position: relative;
  opacity: 1;
  cursor: default;
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

:global(.instance-switcher-popper .instance-menu-item--current.is-disabled::before) {
  content: '';
  position: absolute;
  inset: 7px auto 7px 0;
  width: 2px;
  border-radius: 2px;
  background: var(--color-primary);
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover .port-badge),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus-within .port-badge) {
  opacity: 0;
  transform: scale(0.88);
}

:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):hover .instance-close),
:global(.instance-switcher-popper .instance-menu-item:not(.is-disabled):focus-within .instance-close) {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

:global(.instance-switcher-popper .port-badge) {
  transition: opacity 140ms ease, transform 140ms ease;
}

@keyframes rotating {
  to { transform: rotate(360deg); }
}
</style>
