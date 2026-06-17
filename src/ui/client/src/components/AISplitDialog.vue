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
import { computed, h, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import AISplitDirectPane from './AISplitDirectPane.vue'
import AISplitChatPane from './AISplitChatPane.vue'

export interface SplitSubtask {
  title: string
  desc: string
}

export type ImportMode = 'append' | 'replace'

type SplitMode = 'direct' | 'chat'

const props = defineProps<{
  modelValue: boolean
  title: string
  desc: string
  taskId?: string
  promptId?: string | null
  existingSubtaskCount?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', subtasks: SplitSubtask[], mode: ImportMode): void
}>()

// 模式切换:直接拆分 vs 对话拆分(由 AISplitDirectPane / AISplitChatPane 各自承载 UI)
const mode = ref<SplitMode>('direct')

const hasExisting = computed(() => (props.existingSubtaskCount ?? 0) > 0)
const existingCount = computed(() => props.existingSubtaskCount ?? 0)

// 拦截 pane 的 confirm,若任务已有子任务则弹窗让用户三选一
async function handlePaneConfirm(subtasks: SplitSubtask[]) {
  if (!subtasks || subtasks.length === 0) return

  if (!hasExisting.value) {
    emit('confirm', subtasks, 'append')
    emit('update:modelValue', false)
    return
  }

  // 任务已有子任务,弹窗让用户在"追加/替换/取消"中选一个
  // - 点 confirm 按钮("追加")    -> then(null)         -> resolve('append')
  // - 点 cancel 按钮("替换现有") -> catch('cancel')    -> resolve('replace')
  // - 点 X / Esc 关闭            -> catch('close')     -> resolve(null)
  const picked = await pickImportMode()
  if (picked === null) return
  emit('confirm', subtasks, picked)
  emit('update:modelValue', false)
}

function pickImportMode(): Promise<ImportMode | null> {
  return new Promise((resolve) => {
    ElMessageBox({
      title: $t('@WORKBENCH:该任务已包含子任务'),
      message: h('div', { class: 'ai-split-import-prompt' }, [
        h('p', null,
          $t('@WORKBENCH:当前任务已有 {n} 个子任务。', { n: existingCount.value })),
        h('p', null,
          $t('@WORKBENCH:点击「追加」将新子任务附加到现有列表;点击「替换」将清空后再写入。'))
      ]),
      showCancelButton: true,
      showClose: true,
      closeOnClickModal: false,
      confirmButtonText: $t('@WORKBENCH:追加'),
      cancelButtonText: $t('@WORKBENCH:替换现有子任务'),
      customClass: 'ai-split-import-dialog'
    })
      .then(() => resolve('append'))
      .catch((action: any) => {
        if (action === 'cancel') resolve('replace')
        else resolve(null) // 'close' 或其他
      })
  })
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
    <AISplitDirectPane
      v-if="mode === 'direct'"
      :title="title"
      :desc="desc"
      :task-id="taskId"
      :prompt-id="promptId"
      :existing-subtask-count="existingCount"
      @confirm="handlePaneConfirm"
    />

    <AISplitChatPane
      v-else
      :title="title"
      :desc="desc"
      :task-id="taskId"
      :prompt-id="promptId"
      :existing-subtask-count="existingCount"
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
