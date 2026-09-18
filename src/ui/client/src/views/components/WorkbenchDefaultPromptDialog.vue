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
  多项目编排台 · 派发默认提示词设置弹窗。

  两级：全局一条（所有项目都附加）+ 当前项目的每项目一条。
  两条是**拼接**关系而不是覆盖关系 —— 见服务端 orchestratorStore.resolveDispatchPrompt
  里为什么不覆盖：项目级覆盖会让全局规则在某个项目里无声消失，而用户在界面上看不出这件事。
  这里把这个规则写在字段说明里，别让用户自己猜。

  只管编辑与保存：草稿在关窗时丢弃，父组件负责调接口并把结果回灌进来。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import CommonDialog from '@/components/CommonDialog.vue'

const props = defineProps<{
  modelValue: boolean
  /** 全局默认提示词（'' = 没设置） */
  defaultPrompt: string
  /** 当前选中项目的路径；'' = 选的是「全部项目」，此时项目级这一栏不可编辑 */
  projectPath: string
  /** 当前选中项目的显示名，用于字段标题 */
  projectName: string
  /** 当前选中项目的默认提示词（'' = 没设置） */
  projectPrompt: string
  /** 保存中：两个按钮一起禁用，避免连点存两次 */
  saving: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** 提交草稿。父组件负责判断哪一栏真的改了、分别调哪个接口 */
  save: [payload: { globalPrompt: string; projectPrompt: string }]
}>()

/** 与服务端 MAX_DEFAULT_PROMPT_CHARS 对齐 */
const MAX_CHARS = 4000

const globalDraft = ref('')
const projectDraft = ref('')

// 打开时把服务端的值抄成草稿，关掉丢弃 —— 不给"半途改了一半"留下持久状态
watch(() => props.modelValue, (open) => {
  if (!open) return
  globalDraft.value = props.defaultPrompt || ''
  projectDraft.value = props.projectPrompt || ''
})

const hasProject = computed(() => !!props.projectPath)
const dirty = computed(() =>
  globalDraft.value.trim() !== (props.defaultPrompt || '').trim()
  || (hasProject.value && projectDraft.value.trim() !== (props.projectPrompt || '').trim())
)

function submit() {
  if (props.saving) return
  emit('save', { globalPrompt: globalDraft.value, projectPrompt: projectDraft.value })
}

function close() {
  emit('update:modelValue', false)
}
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    :title="$t('@WORKBENCH:默认提示词')"
    width="min(640px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="pd">
      <p class="pd__intro">
        {{ $t('@WORKBENCH:派发指令时自动附加在指令之前，让每个任务都带上这些约束。只影响之后派发的任务，不会改动已经建好的任务。') }}
      </p>

      <div class="pd__field">
        <div class="pd__head">
          <label class="pd__label" for="pd-global">{{ $t('@WORKBENCH:全局默认提示词') }}</label>
          <span class="pd__count">{{ globalDraft.length }} / {{ MAX_CHARS }}</span>
        </div>
        <textarea
          id="pd-global"
          v-model="globalDraft"
          class="pd__area"
          rows="5"
          :maxlength="MAX_CHARS"
          :placeholder="$t('@WORKBENCH:对所有项目生效。例如：回答用中文；改完代码必须跑一遍测试；不要动 dist 目录')"
        />
      </div>

      <div class="pd__field">
        <div class="pd__head">
          <label class="pd__label" for="pd-project">
            {{ hasProject ? $t('@WORKBENCH:「{name}」的项目提示词', { name: projectName }) : $t('@WORKBENCH:项目提示词') }}
          </label>
          <span v-if="hasProject" class="pd__count">{{ projectDraft.length }} / {{ MAX_CHARS }}</span>
        </div>
        <textarea
          id="pd-project"
          v-model="projectDraft"
          class="pd__area"
          rows="5"
          :maxlength="MAX_CHARS"
          :disabled="!hasProject"
          :placeholder="hasProject
            ? $t('@WORKBENCH:只在这个项目派发时附加。例如：包管理器用 pnpm；改动集中在 src/ui 下')
            : $t('@WORKBENCH:先在左侧选中一个具体项目，才能设置它的提示词')"
        />
        <p class="pd__hint">
          {{ hasProject
            ? $t('@WORKBENCH:项目提示词追加在全局提示词之后（不覆盖全局），派发到「{name}」时一起带上', { name: projectName })
            : $t('@WORKBENCH:选中的是「全部项目」，落点由主 Agent 判断 —— 想给某个项目单设提示词，先选中它') }}
        </p>
      </div>
    </div>

    <template #footer>
      <div class="pd__foot">
        <button type="button" class="pd__btn" @click="close">
          {{ $t('@WORKBENCH:取消') }}
        </button>
        <span class="pd__foot-spacer" />
        <button
          type="button"
          class="pd__btn pd__btn--primary"
          :disabled="saving || !dirty"
          @click="submit"
        >{{ saving ? $t('@WORKBENCH:保存中…') : $t('@WORKBENCH:保存') }}</button>
      </div>
    </template>
  </CommonDialog>
</template>

<style scoped>
.pd {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* el-dialog__body 的 line-height 会一路继承，小字号提示会被撑开 —— 在根元素重置 */
  line-height: 1.5;
}
.pd__intro {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
.pd__field { display: flex; flex-direction: column; gap: 5px; }
.pd__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.pd__label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}
.pd__count {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.pd__area {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 92px;
  max-height: 280px;
  padding: 7px 9px;
  font-size: 12.5px;
  font-family: inherit;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom);
}
.pd__area:focus { border-color: var(--color-primary); }
.pd__area::placeholder { color: var(--text-tertiary); }
.pd__area:disabled { opacity: 0.55; cursor: not-allowed; }
.pd__hint {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

.pd__foot { display: flex; align-items: center; gap: 8px; width: 100%; }
.pd__foot-spacer { flex: 1; }
.pd__btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);
}
.pd__btn:hover:not(:disabled) { color: var(--color-primary); background: var(--bg-container-hover); }
.pd__btn:disabled { opacity: 0.45; cursor: default; }
.pd__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.pd__btn--primary { background: var(--color-primary); color: #fff; }
.pd__btn--primary:hover:not(:disabled) { background: var(--color-primary); color: #fff; opacity: 0.88; }
</style>
