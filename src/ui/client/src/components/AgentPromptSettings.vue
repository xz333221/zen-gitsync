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
  智能体视图 · 「设置」Tab 里的提示词设置。

  两块提示词，来源不同、存的地方也不同，别把它们当成一件事：
    ① g ai 智能体的默认提示词 —— config.json 的 agentDefaultPrompt（走 /api/config/save-ai-settings）
    ② 派发任务的提示词 —— orchestrator.json 的 defaultPrompt / projectPrompts，
       和工作台「预设提示词」是**同一份数据**（同一组接口），在哪边改都一样。
       这里不自己拼提示词、也不自己存一份镜像 —— 两边各存一份必然分叉。

  两块都会在**和 g ai 对话时**每轮注入（服务端 chatPrompts.js 现读现拼，只进请求副本、
  不落会话历史），所以改完下一次发消息就生效，不需要新开会话。
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage } from 'element-plus'
import { useConfigStore } from '@/stores/configStore'
import { useOrchestrator } from '@/composables/useOrchestrator'
import { canonicalProjectPath, getFolderNameFromPath } from '@/utils/path'

const configStore = useConfigStore()
const {
  defaultPrompt,
  projectPrompts,
  loadOrchestrator,
  saveDefaultPrompt,
  saveProjectPrompt,
} = useOrchestrator()

/** 与服务端 AGENT_DEFAULT_PROMPT_MAX / MAX_DEFAULT_PROMPT_CHARS 对齐（都是 4000） */
const MAX_CHARS = 4000

// ── ① g ai 智能体的默认提示词 ─────────────────────────────
const gaiDraft = ref('')
const savingGai = ref(false)
const gaiSaved = ref(false)

// 草稿从 store 抄一次（store 是全局单例，别在每次渲染时重置，否则打字会被覆盖）
const gaiStored = computed(() => configStore.agentDefaultPrompt || '')
const gaiDirty = computed(() => gaiDraft.value.trim() !== gaiStored.value.trim())

async function saveGai() {
  if (savingGai.value || !gaiDirty.value) return
  savingGai.value = true
  try {
    const ok = await configStore.saveAiSettings({ agentDefaultPrompt: gaiDraft.value })
    if (ok) {
      // 以回执为准（服务端会截断到上限），别让输入框显示得跟磁盘不一致
      gaiDraft.value = gaiStored.value
      gaiSaved.value = true
      ElMessage.success($t('@AGENT:已保存 g ai 默认提示词'))
    }
  } finally {
    savingGai.value = false
  }
}

// ── ② 派发任务的提示词（与工作台同一份）────────────────────
// 项目级这一栏跟着**当前项目**走：这里的对话就是在这个项目里跑的，
// 与派发时"按落点项目解析"是同一个口径（服务端 resolveDispatchPrompt）。
const projectPath = computed(() => configStore.currentDirectory || '')
const projectName = computed(() => getFolderNameFromPath(projectPath.value) || projectPath.value)
const projectPrompt = computed(() => {
  const key = canonicalProjectPath(projectPath.value)
  return (key && projectPrompts.value?.[key]?.prompt) || ''
})

const globalDraft = ref('')
const projectDraft = ref('')
const savingDispatch = ref(false)
const dispatchSaved = ref(false)
/** 编排状态没读到时给一句说明 —— 否则两栏显示为空，用户会以为"我的设置丢了" */
const dispatchLoadFailed = ref(false)

const dispatchDirty = computed(() =>
  globalDraft.value.trim() !== (defaultPrompt.value || '').trim()
  || (!!projectPath.value && projectDraft.value.trim() !== projectPrompt.value.trim())
)

/** 把服务端值抄成草稿。切项目 / 首次加载完都要抄一次 */
function syncDispatchDraft() {
  globalDraft.value = defaultPrompt.value || ''
  projectDraft.value = projectPrompt.value
}

onMounted(async () => {
  gaiDraft.value = gaiStored.value
  syncDispatchDraft()
  // 编排状态里才有派发提示词。失败不弹错（面板本身还能用，只是这两栏显示为空）
  const ok = await loadOrchestrator(true)
  dispatchLoadFailed.value = !ok
  if (ok) syncDispatchDraft()
})

async function saveDispatch() {
  if (savingDispatch.value || !dispatchDirty.value) return
  savingDispatch.value = true
  try {
    let ok = true
    const nextGlobal = globalDraft.value.trim()
    if (nextGlobal !== (defaultPrompt.value || '').trim()) {
      ok = await saveDefaultPrompt(nextGlobal)
    }
    const nextProject = projectDraft.value.trim()
    if (ok && projectPath.value && nextProject !== projectPrompt.value.trim()) {
      ok = await saveProjectPrompt(projectPath.value, nextProject)
    }
    if (ok) {
      syncDispatchDraft()
      dispatchSaved.value = true
    }
  } finally {
    savingDispatch.value = false
  }
}
</script>

<template>
  <div class="aps">
    <div class="aps__scroll">
      <header class="aps__head">
        <h3 class="aps__title">{{ $t('@AGENT:提示词设置') }}</h3>
        <p class="aps__intro">
          {{ $t('@AGENT:这里配的两块提示词，和 g ai 对话时每一轮都会自动带上。改完下一次发消息就生效，不用新开会话。') }}
        </p>
      </header>

      <!-- ── ① g ai 智能体的默认提示词 ── -->
      <section class="aps__card aps__card--gai">
        <div class="aps__card-head">
          <h4 class="aps__card-title">{{ $t('@AGENT:g ai 智能体的默认提示词') }}</h4>
          <span class="aps__count">{{ gaiDraft.length }} / {{ MAX_CHARS }}</span>
        </div>
        <p class="aps__hint">
          {{ $t('@AGENT:只作用于 g ai 自己：每次对话都会带上（定时任务也一样）。派发出去的任务读不到这一段。') }}
        </p>
        <textarea
          id="aps-gai"
          v-model="gaiDraft"
          class="aps__area"
          rows="6"
          :maxlength="MAX_CHARS"
          :placeholder="$t('@AGENT:例如：回答用中文；改完代码先跑一遍验证再汇报；不要动 dist 目录')"
        />
        <div class="aps__foot">
          <span v-if="gaiSaved && !gaiDirty" class="aps__saved">{{ $t('@AGENT:已保存') }}</span>
          <span class="aps__spacer" />
          <button
            type="button"
            class="aps__btn aps__btn--primary"
            :disabled="savingGai || !gaiDirty"
            @click="saveGai"
          >{{ savingGai ? $t('@AGENT:保存中…') : $t('@AGENT:保存') }}</button>
        </div>
      </section>

      <!-- ── ② 派发任务的提示词 ── -->
      <section class="aps__card aps__card--dispatch">
        <div class="aps__card-head">
          <h4 class="aps__card-title">{{ $t('@AGENT:派发任务的提示词') }}</h4>
        </div>
        <p class="aps__hint">
          {{ $t('@AGENT:与工作台「预设提示词」是同一份设置，在哪边改都一样。派发任务时附加在指令之前，和 g ai 对话时也会带上。') }}
        </p>

        <div class="aps__field">
          <div class="aps__card-head">
            <label class="aps__label" for="aps-global">{{ $t('@AGENT:全局提示词') }}</label>
            <span class="aps__count">{{ globalDraft.length }} / {{ MAX_CHARS }}</span>
          </div>
          <textarea
            id="aps-global"
            v-model="globalDraft"
            class="aps__area"
            rows="5"
            :maxlength="MAX_CHARS"
            :placeholder="$t('@AGENT:对所有项目生效。例如：回答用中文；改完代码必须跑一遍测试；不要动 dist 目录')"
          />
        </div>

        <div class="aps__field">
          <div class="aps__card-head">
            <label class="aps__label" for="aps-project">
              {{ projectPath ? $t('@AGENT:「{name}」的项目提示词', { name: projectName }) : $t('@AGENT:项目提示词') }}
            </label>
            <span v-if="projectPath" class="aps__count">{{ projectDraft.length }} / {{ MAX_CHARS }}</span>
          </div>
          <textarea
            id="aps-project"
            v-model="projectDraft"
            class="aps__area"
            rows="5"
            :maxlength="MAX_CHARS"
            :disabled="!projectPath"
            :placeholder="projectPath
              ? $t('@AGENT:只在这个项目派发/对话时附加。例如：包管理器用 pnpm；改动集中在 src/ui 下')
              : $t('@AGENT:当前没有打开项目，项目级提示词暂时不能设置')"
          />
          <p class="aps__hint">
            {{ projectPath
              ? $t('@AGENT:项目提示词追加在全局提示词之后（不覆盖全局），在「{name}」里派发或对话时一起带上', { name: projectName })
              : $t('@AGENT:先在左上角切到一个项目，才能设置它的提示词') }}
          </p>
        </div>

        <div class="aps__foot">
          <span v-if="dispatchSaved && !dispatchDirty" class="aps__saved">{{ $t('@AGENT:已保存') }}</span>
          <span v-else-if="dispatchLoadFailed" class="aps__saved">{{ $t('@AGENT:读取设置失败，请稍后重试') }}</span>
          <span class="aps__spacer" />
          <button
            type="button"
            class="aps__btn aps__btn--primary"
            :disabled="savingDispatch || !dispatchDirty"
            @click="saveDispatch"
          >{{ savingDispatch ? $t('@AGENT:保存中…') : $t('@AGENT:保存') }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped lang="scss">
.aps {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-container);
  overflow: hidden;
}

/* 面板自己滚：两块 textarea 在矮窗口里会比可用高度高 */
.aps__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  line-height: 1.5;
  /* 设置页在宽窗口里别拉成一整行 —— 一行几百字的输入框读起来很累 */
  max-width: 860px;
}

.aps__head { display: flex; flex-direction: column; gap: 5px; }
.aps__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.aps__intro {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--text-meta);
}

.aps__card {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 14px 16px;
  background: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}
.aps__card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.aps__card-title {
  margin: 0;
  font-size: var(--font-size-mid);
  font-weight: 600;
  color: var(--text-primary);
}
.aps__label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--text-secondary);
}
.aps__count {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.aps__field { display: flex; flex-direction: column; gap: 5px; }
.aps__hint {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--text-meta);
}

.aps__area {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 92px;
  max-height: 320px;
  padding: 7px 9px;
  font-size: var(--font-size-mid);
  font-family: inherit;
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-subtle);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  outline: none;
  transition: border-color var(--transition-fast) var(--ease-custom);

  &:focus { border-color: var(--color-primary); }
  &::placeholder { color: var(--text-meta); }
  &:disabled { opacity: var(--disabled-opacity); cursor: not-allowed; }
}

.aps__foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.aps__spacer { flex: 1; }
.aps__saved {
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.aps__btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 28px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom), background var(--transition-fast) var(--ease-custom);

  &:hover:not(:disabled) { color: var(--color-primary); background: var(--bg-container-hover); }
  &:disabled { opacity: var(--disabled-opacity); cursor: default; }
  &:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
}
.aps__btn--primary {
  background: var(--color-primary);
  color: #fff;

  &:hover:not(:disabled) { background: var(--color-primary); color: #fff; opacity: 0.88; }
}
</style>
