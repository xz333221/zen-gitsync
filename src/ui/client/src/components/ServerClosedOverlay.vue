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
  服务端退出的全屏遮罩。

  触发场景有两处：
    1. InstanceSwitcher「关闭当前实例」——UI 主动关闭，window.close() 被拦截时兜底；
    2. useServerLifecycle——检出宿主服务端已退出(优雅关闭或强杀/崩溃)。
  两者共用同一套 class 与 i18n key（@INSSW:当前实例已关闭*），保证既有用例零改动。
-->
<script setup lang="ts">
import { ElIcon } from 'element-plus'
import { $t } from '@/lang/static'

const props = withDefaults(defineProps<{
  visible: boolean
  name?: string
}>(), {
  name: '',
})
</script>

<template>
  <Teleport to="body">
    <div v-if="props.visible" class="self-closed-overlay" role="alert">
      <div class="self-closed-card">
        <el-icon class="self-closed-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M15 9l-6 6M9 9l6 6" />
          </svg>
        </el-icon>
        <h2 class="self-closed-title">{{ $t('@INSSW:当前实例已关闭标题') }}</h2>
        <p class="self-closed-desc">{{ $t('@INSSW:当前实例已关闭描述', { name: props.name }) }}</p>
        <span class="self-closed-hint">{{ $t('@INSSW:当前实例已关闭提示') }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Teleport 到 body 后 scoped 属性随元素走，样式仍然生效。 */
.self-closed-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay-critical);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-container, #fff);
}

.self-closed-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 420px;
  text-align: center;
}

.self-closed-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  color: var(--text-secondary);
  border: 1px solid var(--border-component);
  background: var(--bg-subtle);
}

.self-closed-icon svg {
  width: 26px;
  height: 26px;
}

.self-closed-title {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--text-primary);
}

.self-closed-desc {
  margin: 0;
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
  line-height: 1.6;
}

.self-closed-hint {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-meta, var(--text-secondary));
  line-height: 1.6;
}
</style>
