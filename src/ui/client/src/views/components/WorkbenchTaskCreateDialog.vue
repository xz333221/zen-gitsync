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
  多项目编排台 · 新建任务弹窗。

  原来「新建开发任务」是"先悄悄建一个空任务、再把你甩进编辑器"，
  在编排台里这是个反模式：点一下按钮就离开看板，而且还没说明任务属于哪个项目。
  这里把该问的一次问清（项目 / 标题 / 描述 / 类型），建完就关，卡片直接出现在看板上。

  两个刻意的决定：
    1. **默认「复杂」任务**。简单任务必须配一条提示词才跑得起来（simpleOverride），
       而这个弹窗不收集提示词 —— 默认成简单会造出一个"点执行就跑不动"的任务。
       提示词在编辑器里填，所以想建简单任务请走「创建并打开编辑器」。
    2. **标题与描述至少填一个**。看板上的空任务会被 pruneBlankTasks 清掉，
       从这里放行一个空任务只会让用户以为"建成功了"，然后它自己消失。
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import { canonicalProjectPath } from '@/utils/path'
import CommonDialog from '@/components/CommonDialog.vue'
import type { ProjectSummary, Task } from '@/types/workbench'

const props = defineProps<{
  modelValue: boolean
  projects: ProjectSummary[]
  /** 默认归属项目：看板当前选中的项目，选中「全部项目」时是应用当前项目 */
  defaultProjectPath: string
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** openEditor=true 表示「创建并打开编辑器」 */
  created: [payload: { task: Task; openEditor: boolean }]
}>()

const title = ref('')
const desc = ref('')
const taskType = ref<'simple' | 'complex'>('complex')
const projectPath = ref('')
const submitting = ref(false)
const error = ref('')

/**
 * 把「默认项目路径」映射到下拉里真正存在的那个 option 值。
 *
 * 两个口径必须分开：项目条目里 `key` 是归一化路径（盘符大写），`path` 是配置里的原始路径（盘符小写）。
 * 看板传进来的 defaultProjectPath 取的是 key 口径，直接拿去和 `p.path` 比永远不相等 ——
 * 结果就是下拉框显示空白、下面的提示还错说成"跟随当前目录"。
 * 所以这里用归一化后的值做**相等比较**，但落回 select 的仍是 `p.path`（原始路径），
 * 因为任务真正要用的执行目录就是它。
 */
function matchOptionPath(raw: string): string {
  const target = canonicalProjectPath(raw)
  if (!target) return ''
  const hit = props.projects.find(p => canonicalProjectPath(p.path) === target)
  return hit ? hit.path : ''
}

// 打开时重置成一个干净的草稿（并带上默认项目），关掉时丢弃
watch(() => props.modelValue, (open) => {
  if (!open) return
  title.value = ''
  desc.value = ''
  taskType.value = 'complex'
  projectPath.value = matchOptionPath(props.defaultProjectPath)
  error.value = ''
  submitting.value = false
})

/** 项目下拉的候选：只列真实的项目条目（含目录已失效的，用户可能就是想建个占位） */
const projectOptions = computed(() => props.projects)

const canSubmit = computed(() =>
  !submitting.value && (title.value.trim().length > 0 || desc.value.trim().length > 0)
)

const projectName = computed(() => {
  const target = canonicalProjectPath(projectPath.value)
  if (!target) return ''
  const p = projectOptions.value.find(x => canonicalProjectPath(x.path) === target)
  return p ? p.name : ''
})

async function submit(openEditor: boolean) {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = ''
  try {
    const body: Record<string, unknown> = {
      title: title.value.trim(),
      desc: desc.value,
      type: taskType.value,
      promptId: null,
      simpleOverride: '',
      subtasks: [],
    }
    if (projectPath.value) body.projectPath = projectPath.value
    const res = await fetch('/api/workbench/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => null)
    if (!res?.success) {
      error.value = res?.error || $t('@WORKBENCH:保存失败')
      return
    }
    emit('update:modelValue', false)
    emit('created', { task: res.task, openEditor })
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <CommonDialog
    :model-value="modelValue"
    :title="$t('@WORKBENCH:新建开发任务')"
    width="min(600px, 94vw)"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="nc">
      <div class="nc__field">
        <label class="nc__label" for="nc-project">{{ $t('@WORKBENCH:项目') }}</label>
        <select id="nc-project" v-model="projectPath" class="nc__select">
          <option value="">{{ $t('@WORKBENCH:跟随当前项目') }}</option>
          <option v-for="p in projectOptions" :key="p.key" :value="p.path">
            {{ p.name }}{{ p.exists === false ? ` · ${$t('@WORKBENCH:目录不存在')}` : '' }}
          </option>
        </select>
        <p class="nc__hint" :title="projectPath">
          {{ projectName ? $t('@WORKBENCH:任务会在「{name}」目录下执行', { name: projectName }) : $t('@WORKBENCH:任务会跟随应用当前的工作目录') }}
        </p>
      </div>

      <div class="nc__field">
        <label class="nc__label" for="nc-title">{{ $t('@WORKBENCH:标题') }}</label>
        <input
          id="nc-title"
          v-model="title"
          class="nc__input"
          type="text"
          maxlength="200"
          :placeholder="$t('@WORKBENCH:一句话说清要做什么')"
          @keydown.enter.prevent="submit(false)"
        />
      </div>

      <div class="nc__field">
        <label class="nc__label" for="nc-desc">{{ $t('@WORKBENCH:描述') }}</label>
        <textarea
          id="nc-desc"
          v-model="desc"
          class="nc__input nc__input--area"
          rows="6"
          :placeholder="$t('@WORKBENCH:把背景、验收标准、相关文件路径写进来，执行时用它当上下文')"
          @keydown.ctrl.enter.prevent="submit(false)"
          @keydown.meta.enter.prevent="submit(false)"
        />
      </div>

      <div class="nc__field">
        <span class="nc__label">{{ $t('@WORKBENCH:类型') }}</span>
        <div class="nc__radios">
          <label class="nc__radio" :class="{ 'is-on': taskType === 'complex' }">
            <input v-model="taskType" type="radio" value="complex" />
            <span class="nc__radio-name">{{ $t('@WORKBENCH:复杂') }}</span>
            <span class="nc__radio-desc">{{ $t('@WORKBENCH:先拆成子任务再逐个执行，适合一次改多处') }}</span>
          </label>
          <label class="nc__radio" :class="{ 'is-on': taskType === 'simple' }">
            <input v-model="taskType" type="radio" value="simple" />
            <span class="nc__radio-name">{{ $t('@WORKBENCH:简单') }}</span>
            <span class="nc__radio-desc">{{ $t('@WORKBENCH:直接跑一条提示词，提示词要在编辑器里填') }}</span>
          </label>
        </div>
      </div>

      <p v-if="error" class="nc__error">{{ error }}</p>
    </div>

    <template #footer>
      <div class="nc__foot">
        <button type="button" class="nc__btn" @click="emit('update:modelValue', false)">
          {{ $t('@WORKBENCH:取消') }}
        </button>
        <span class="nc__foot-spacer" />
        <button
          type="button"
          class="nc__btn"
          :disabled="!canSubmit"
          @click="submit(true)"
        >{{ $t('@WORKBENCH:创建并打开编辑器') }}</button>
        <button
          type="button"
          class="nc__btn nc__btn--primary"
          :disabled="!canSubmit"
          @click="submit(false)"
        >{{ submitting ? $t('@WORKBENCH:创建中…') : $t('@WORKBENCH:创建') }}</button>
      </div>
    </template>
  </CommonDialog>
</template>

<style scoped>
.nc {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* el-dialog__body 的 line-height 会一路继承，小字号提示会被撑开 —— 在根元素重置 */
  line-height: 1.5;
}
.nc__field { display: flex; flex-direction: column; gap: 5px; }
.nc__label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}
.nc__input,
.nc__select {
  width: 100%;
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
  box-sizing: border-box;
}
.nc__input:focus,
.nc__select:focus { border-color: var(--color-primary); }
.nc__input::placeholder { color: var(--text-tertiary); }
.nc__select { cursor: pointer; }
.nc__input--area {
  resize: vertical;
  min-height: 92px;
  max-height: 260px;
}
.nc__hint { margin: 0; font-size: 10.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 类型：扁平单选，不做卡片 */
.nc__radios { display: flex; flex-direction: column; gap: 6px; }
.nc__radio {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
}
.nc__radio:hover { background: var(--bg-container-hover); }
.nc__radio.is-on { background: color-mix(in srgb, var(--color-primary) 8%, transparent); }
.nc__radio input { cursor: pointer; flex-shrink: 0; align-self: center; }
.nc__radio-name { font-size: 12.5px; color: var(--text-primary); flex-shrink: 0; }
.nc__radio-desc { font-size: 11px; color: var(--text-tertiary); }

.nc__error {
  margin: 0;
  padding: 6px 8px;
  font-size: 11.5px;
  border-radius: var(--radius-md);
  color: var(--color-danger-light);
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
}

.nc__foot { display: flex; align-items: center; gap: 8px; width: 100%; }
.nc__foot-spacer { flex: 1; }
.nc__btn {
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
.nc__btn:hover:not(:disabled) { color: var(--color-primary); background: var(--bg-container-hover); }
.nc__btn:disabled { opacity: 0.45; cursor: default; }
.nc__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.nc__btn--primary { background: var(--color-primary); color: #fff; }
.nc__btn--primary:hover:not(:disabled) { background: var(--color-primary); color: #fff; opacity: 0.88; }
</style>
