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

type Strategy = 'append' | 'replace' | 'merge'

export interface ImportConfirmPayload {
  strategy: Strategy
  titles: string[]
}

const props = defineProps<{
  modelValue: boolean
  existingCount: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'confirm', payload: ImportConfirmPayload): void
}>()

const strategy = ref<Strategy>('append')
const text = ref('')

// 每弹一次清空文本 + 重置策略
watch(() => props.modelValue, (v) => {
  if (v) {
    text.value = ''
    strategy.value = props.existingCount > 0 ? 'append' : 'replace'
  }
})

// 解析:每行一个子任务,空行 + # 注释行跳过,自动剥 markdown 前缀
function parseImport(raw: string): { titles: string[]; skipped: number } {
  const titles: string[] = []
  let skipped = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      skipped++
      continue
    }
    const cleaned = trimmed
      .replace(/^[-*+•·]\s+/, '')
      .replace(/^\[\s*[xX ]?\s*\]\s+/, '')
      .replace(/^\d+[.)、]\s+/, '')
    titles.push(cleaned)
  }
  return { titles, skipped }
}

const preview = computed(() => parseImport(text.value))
const canConfirm = computed(() => preview.value.titles.length > 0)

function handleClose() {
  emit('update:modelValue', false)
}

function handleConfirm() {
  if (!canConfirm.value) return
  emit('confirm', {
    strategy: strategy.value,
    titles: preview.value.titles
  })
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    :title="$t('@WORKBENCH:导入拆分对话框')"
    width="720px"
    :close-on-click-modal="false"
    :close-on-press-escape="true"
    :show-close="true"
  >
    <div class="import-split__strategy">
      <el-radio-group v-model="strategy">
        <el-radio value="append">{{ $t('@WORKBENCH:追加') }}</el-radio>
        <el-radio value="replace" :disabled="existingCount === 0">{{ $t('@WORKBENCH:替换') }}</el-radio>
        <el-radio value="merge" :disabled="existingCount === 0">{{ $t('@WORKBENCH:合并(跳过已存在)') }}</el-radio>
      </el-radio-group>
    </div>

    <el-input
      v-model="text"
      type="textarea"
      :rows="12"
      :placeholder="$t('@WORKBENCH:每行一个子任务,以 # 开头视为注释,空行忽略')"
      resize="vertical"
    />

    <div class="import-split__preview">
      {{
        $t('@WORKBENCH:已解析 N 个子任务,M 行被跳过', {
          n: preview.titles.length,
          m: preview.skipped
        })
      }}
    </div>

    <template #footer>
      <el-button @click="handleClose">{{ $t('@WORKBENCH:取消') }}</el-button>
      <el-button type="primary" :disabled="!canConfirm" @click="handleConfirm">
        {{ $t('@WORKBENCH:导入') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-split__strategy {
  margin-bottom: 12px;
}
.import-split__preview {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary, #909399);
}
</style>