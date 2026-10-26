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
  「派发设置」—— g ai 主动派活的开关 + 派活时的执行器优先级。

  两件事放在一起是因为它们服务同一个目的：把活派给**更便宜的执行器**去做，
  而不是全在主 agent 这边烧 token。设置本身落在 config.json 的 ui 段
  （dispatchExecutorPriority / agentProactiveDispatch）：
    · 顶层新键会被 config.js 的 saveConfig 随 `...projectConfig` 吞进项目级配置；
    · ui 段走 save-ui-settings 的按 key 浅合并，不会跟别处的整段 ui 快照打架。

  为什么顺序只能前端算：执行器"装没装"的唯一数据源是 /api/check-tools（toolsStore），
  服务端没有这份数据。这里排好序，派活时挑第一个已安装的，再把**具体 id**
  随请求体发过去（见 composables/useTaskExecutorSelection 的 dispatchTarget）。

  样式：平铺行 + hover 底色，不套"圆角 + 单 border"的卡片 —— 与工作台其它列表一致。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import { ArrowUp, ArrowDown, Close, Plus } from '@element-plus/icons-vue'
import { useConfigStore } from '@/stores/configStore'
import { useTaskExecutorSelection } from '@/composables/useTaskExecutorSelection'
import { TASK_EXECUTOR_OPTIONS, taskExecutorName, type TaskExecutorId } from '@/utils/taskExecutor'
import TaskExecutorIcon from '@components/TaskExecutorIcon.vue'

const configStore = useConfigStore()
const { availability, dispatchTarget, executorModelText, executorModelTitle } = useTaskExecutorSelection()

const list = computed<TaskExecutorId[]>(() => configStore.ui.dispatchExecutorPriority)
const proactive = computed(() => configStore.ui.agentProactiveDispatch)
const canAdd = computed(() => TASK_EXECUTOR_OPTIONS.some(opt => !list.value.includes(opt.id)))

/** 每次改动立刻落盘：拖动/上下移这种动作没有"保存"按钮，攒着丢了最气人 */
function persist(next: TaskExecutorId[]) {
  void configStore.saveDispatchSettings({ dispatchExecutorPriority: next })
}

function move(index: number, delta: number) {
  const next = [...list.value]
  const target = index + delta
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target], next[index]]
  persist(next)
}

function remove(id: TaskExecutorId) {
  persist(list.value.filter(item => item !== id))
}

function add(id: unknown) {
  if (typeof id !== 'string') return
  if (list.value.includes(id as TaskExecutorId)) return
  persist([...list.value, id as TaskExecutorId])
}

function toggleProactive(value: boolean) {
  void configStore.saveDispatchSettings({ agentProactiveDispatch: value })
}

/** 只读展示用：链尾那句"当前会用 xxx" */
const targetName = computed(() => taskExecutorName(dispatchTarget.value))
</script>

<template>
  <section class="dps">
    <header class="dps__head">
      <h3 class="dps__title">{{ $t('@AGENT:派发设置') }}</h3>
      <p class="dps__intro">
        {{ $t('@AGENT:g ai 可以把活派给本地 CLI 执行器去做 —— 它们的 token 通常比主 agent 便宜。') }}
      </p>
    </header>

    <!-- ① 主动派活 -->
    <div class="dps__row dps__row--switch">
      <div class="dps__row-main">
        <span class="dps__row-name">{{ $t('@AGENT:让 g ai 主动派活') }}</span>
        <span class="dps__row-hint">
          {{ $t('@AGENT:遇到要改多个文件、跑构建测试这类活，它直接派出去，不再自己从头做；问答与单文件小改仍自己做。') }}
        </span>
      </div>
      <el-switch
        :model-value="proactive"
        class="dps__switch"
        @update:model-value="toggleProactive"
      />
    </div>

    <!-- ② 执行器优先级 -->
    <div class="dps__block">
      <div class="dps__block-head">
        <span class="dps__row-name">{{ $t('@AGENT:派活执行器优先级') }}</span>
        <span v-if="list.length" class="dps__target">
          {{ $t('@AGENT:当前会用：{name}', { name: targetName }) }}
        </span>
      </div>

      <p v-if="!list.length" class="dps__empty">
        {{ $t('@AGENT:还没排优先级 —— 派活沿用下拉里选中的那个执行器。') }}
      </p>

      <ul v-else class="dps__list">
        <li v-for="(id, index) in list" :key="id" class="dps__item">
          <span class="dps__order">{{ index + 1 }}</span>
          <TaskExecutorIcon :executor="id" class="dps__icon" />
          <span class="dps__name">{{ taskExecutorName(id) }}</span>
          <span
            v-if="executorModelText(id)"
            class="dps__model"
            :title="executorModelTitle(id)"
          >{{ executorModelText(id) }}</span>
          <span v-if="!availability[id]" class="dps__missing">{{ $t('@42BB9:未安装') }}</span>
          <span class="dps__actions">
            <button
              type="button"
              class="dps__act"
              :disabled="index === 0"
              :title="$t('@AGENT:往前挪一位')"
              :aria-label="$t('@AGENT:往前挪一位')"
              @click="move(index, -1)"
            >
              <el-icon><ArrowUp /></el-icon>
            </button>
            <button
              type="button"
              class="dps__act"
              :disabled="index === list.length - 1"
              :title="$t('@AGENT:往后挪一位')"
              :aria-label="$t('@AGENT:往后挪一位')"
              @click="move(index, 1)"
            >
              <el-icon><ArrowDown /></el-icon>
            </button>
            <button
              type="button"
              class="dps__act dps__act--danger"
              :title="$t('@AGENT:移出优先级')"
              :aria-label="$t('@AGENT:移出优先级')"
              @click="remove(id)"
            >
              <el-icon><Close /></el-icon>
            </button>
          </span>
        </li>
      </ul>

      <el-dropdown v-if="canAdd" trigger="click" class="dps__add" @command="add">
        <button type="button" class="dps__add-btn">
          <el-icon><Plus /></el-icon>
          <span>{{ $t('@AGENT:添加执行器') }}</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="opt in TASK_EXECUTOR_OPTIONS.filter(o => !list.includes(o.id))"
              :key="opt.id"
              :command="opt.id"
            >
              <span class="dps__add-item">
                <TaskExecutorIcon :executor="opt.id" class="dps__icon" />
                <span>{{ opt.name }}</span>
                <span v-if="!availability[opt.id]" class="dps__missing">{{ $t('@42BB9:未安装') }}</span>
              </span>
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <p class="dps__foot">
        {{ $t('@AGENT:派活时从列表头开始，挑第一个本机已安装的执行器；一个都没装就沿用下拉里的选择。') }}
      </p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.dps {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-top: 18px;
  margin-top: 6px;
  border-top: 1px solid var(--border-color);
}

.dps__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.dps__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.dps__intro,
.dps__foot,
.dps__empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.dps__row,
.dps__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  transition: background-color var(--transition-fast) var(--ease-custom);
}

.dps__row:hover,
.dps__item:hover {
  background: var(--bg-hover);
}

.dps__row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.dps__row-name {
  font-size: 13px;
  color: var(--text-primary);
}

.dps__row-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.dps__switch {
  flex-shrink: 0;
}

.dps__block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dps__block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 0 10px;
}

.dps__target {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.dps__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dps__order {
  width: 16px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
  text-align: right;
}

.dps__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.dps__name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
}

.dps__model {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dps__missing {
  font-size: 11px;
  color: var(--text-secondary);
  opacity: 0.8;
  flex-shrink: 0;
}

.dps__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

/* 危险动作静息灰、hover 才红（与工作台其它图标按钮同一套手势） */
.dps__act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
    background-color var(--transition-fast) var(--ease-custom);
}

.dps__act:hover:not(:disabled) {
  background: var(--bg-active);
  color: var(--text-primary);
}

.dps__act--danger:hover:not(:disabled) {
  color: var(--role-error-ink, var(--color-danger));
}

.dps__act:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.dps__add {
  align-self: flex-start;
  margin-left: 10px;
}

.dps__add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px dashed var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom);
}

.dps__add-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-color-strong, var(--border-color));
}

.dps__add-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
