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
import { computed } from 'vue'
import { ElDropdown, ElDropdownMenu, ElDropdownItem, ElIcon, ElTag } from 'element-plus'
import { $t } from '@/lang/static'
import { useInstancesStore } from '@/stores/instancesStore'
import { getFolderNameFromPath } from '@/utils/path'
import type { InstanceInfo } from '@/types/instances'

const store = useInstancesStore()

// 列表为空时不渲染（单实例用户无意义）
const hasAny = computed(() => store.list.length > 0)

const count = computed(() => store.list.length)

// 触发器文本：总数 + 当前项目名
const triggerText = computed(() => `${count.value} ${$t('@INSSW:个实例')}`)

function handleOpen(port: number) {
  if (!port) return
  window.open(`http://localhost:${port}`, '_blank', 'noopener')
}

function pathSubtitle(instance: InstanceInfo): string {
  return getFolderNameFromPath(instance.projectPath) || instance.projectName
}
</script>

<template>
  <el-dropdown
    v-if="hasAny"
    trigger="click"
    placement="bottom-end"
    @command="handleOpen"
  >
    <span class="instance-switcher">
      <el-icon class="switcher-icon">
        <!-- apps/layers 图标 -->
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </el-icon>
      <span class="switcher-text">{{ triggerText }}</span>
    </span>
    <template #dropdown>
      <el-dropdown-menu class="instance-dropdown-menu">
        <!-- 当前实例（不可点击） -->
        <el-dropdown-item v-if="store.currentInstance" disabled>
          <div class="instance-row instance-row--current">
            <div class="instance-row-main">
              <span class="instance-name">{{ store.currentInstance.projectName }}</span>
              <el-tag size="small" type="primary" effect="light" class="instance-tag">{{ $t('@INSSW:当前') }}</el-tag>
            </div>
            <div class="instance-row-sub">
              <el-tag size="small" effect="plain" class="port-badge">:{{ store.currentInstance.port }}</el-tag>
              <span class="instance-path">{{ pathSubtitle(store.currentInstance) }}</span>
            </div>
          </div>
        </el-dropdown-item>

        <!-- 其他运行中的实例 -->
        <el-dropdown-item
          v-for="inst in store.otherInstances"
          :key="inst.pid"
          :command="inst.port"
        >
          <div class="instance-row">
            <div class="instance-row-main">
              <span class="instance-name">{{ inst.projectName }}</span>
              <el-tag size="small" effect="plain" class="port-badge">:{{ inst.port }}</el-tag>
            </div>
            <div class="instance-row-sub">
              <span class="instance-path">{{ pathSubtitle(inst) }}</span>
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
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px var(--spacing-base);
  cursor: pointer;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-component);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium, 500);
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease;
  user-select: none;
}

.instance-switcher:hover {
  border-color: var(--color-primary);
  background: rgba(59, 130, 246, 0.08);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.12);
  color: var(--text-primary);
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

.switcher-text {
  white-space: nowrap;
}

.instance-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
  max-width: 320px;
  padding: 4px 0;
}

.instance-row--current {
  opacity: 0.85;
}

.instance-row-main {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.instance-row-sub {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.instance-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.instance-tag {
  flex-shrink: 0;
}

.port-badge {
  flex-shrink: 0;
  font-family: var(--font-mono, 'JetBrains Mono', monospace);
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

.instance-empty {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-style: italic;
}

/* 主题：暗色下边框和背景微调 */
:global([data-theme="dark"]) .instance-switcher {
  background: var(--bg-subtle);
}
</style>
