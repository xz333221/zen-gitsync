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
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import AISplitDirectPane from './AISplitDirectPane.vue'
import AISplitChatPane from './AISplitChatPane.vue'

export interface SplitSubtask {
  title: string
  desc: string
}

type SplitMode = 'direct' | 'chat'

const props = defineProps<{
  modelValue: boolean
  title: string
  desc: string
  taskId?: string
  promptId?: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', subtasks: SplitSubtask[]): void
}>()

// 模式切换:直接拆分 vs 对话拆分
const mode = ref<SplitMode>('direct')
const modeOptions = computed(() => [
  { label: $t('@WORKBENCH:直接拆分'), value: 'direct' as const },
  { label: $t('@WORKBENCH:对话拆分'), value: 'chat' as const }
])

// 转发 pane 的 confirm 给父组件
function handlePaneConfirm(subtasks: SplitSubtask[]) {
  emit('confirm', subtasks)
  emit('update:modelValue', false)
}

// 打开时重置模式(用户手动切换的保留)
watch(() => props.modelValue, (v) => {
  if (v) {
    mode.value = 'direct'
  }
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :title="$t('@WORKBENCH:AI 拆分任务')"
    width="800px"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    :show-close="true"
  >
    <div class="ai-split-mode-bar">
      <el-segmented
        v-model="mode"
        :options="modeOptions"
        :block="false"
      />
    </div>

    <AISplitDirectPane
      v-if="mode === 'direct'"
      :title="title"
      :desc="desc"
      :task-id="taskId"
      :prompt-id="promptId"
      @confirm="handlePaneConfirm"
    />

    <AISplitChatPane
      v-else
      :title="title"
      :desc="desc"
      :task-id="taskId"
      :prompt-id="promptId"
      @confirm="handlePaneConfirm"
    />
  </el-dialog>
</template>

<style scoped lang="scss">
.ai-split-mode-bar {
  margin-bottom: 12px;
  display: flex;
  justify-content: flex-start;
}
</style>
