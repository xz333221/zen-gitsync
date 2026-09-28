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
  「这一条任务交给谁跑」的下拉（claude / opencode / codex）。

  为什么单独成组件：主 Agent 控制台里有**两个地方**要选它 —— 指令模式的派发栏，
  与对话模式下"g ai 派出去的活由谁执行"。同一份交互（未安装置灰、选中打勾、
  与执行按钮共用 localStorage 里的临时选择）在两处各写一遍，迟早会有一边漏了兜底。

  选择本身是**全局共享**的（utils/taskExecutor 的 localStorage），不是本组件的私有状态：
  看板卡片的「执行」按钮、这里的下拉，切了互相跟手 —— 历史行为，别改成组件内部状态。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, Check } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import TaskExecutorIcon from '@components/TaskExecutorIcon.vue'
import { useToolsStore } from '@/stores/toolsStore'
import {
  TASK_EXECUTOR_OPTIONS,
  setSelectedTaskExecutor,
  taskExecutorName,
  type TaskExecutorId,
} from '@/utils/taskExecutor'

const model = defineModel<TaskExecutorId>({ required: true })

const props = defineProps<{
  /** 主按钮的 title（两个入口想说的话不同，但按钮长相、行为一致） */
  title?: string
}>()

const toolsStore = useToolsStore()
const availability = computed<Record<TaskExecutorId, boolean>>(() => ({
  claude: toolsStore.claudeAvailable,
  opencode: toolsStore.opencodeAvailable,
  codex: toolsStore.codexAvailable,
}))

/**
 * 选中项。原生 select 不会命中 disabled option，但键盘 / localStorage 里的历史脏值
 * 仍可能落进来（比如上次用 opencode，之后卸载了）—— 所以在这里兜一次底，
 * 并顺手把回落结果写回共享选择，免得别处再读到那个已不可用的值。
 */
function pick(id: TaskExecutorId) {
  if (!availability.value[id]) return
  model.value = id
  setSelectedTaskExecutor(id)
}

// 首次渲染时如果当前值不可用，同样回落到第一个可用的（不写盘则下次进来看还是坏的）
const viable = computed(() => (Object.keys(availability.value) as TaskExecutorId[])
  .find(id => availability.value[id]))
if (viable.value && !availability.value[model.value]) pick(viable.value)
</script>

<template>
  <el-dropdown trigger="click" class="tep" @command="pick">
    <button
      type="button"
      class="tep__btn"
      :title="props.title"
      :aria-label="$t('@WORKBENCH:任务执行器')"
    >
      <TaskExecutorIcon :executor="model" class="tep__btn-icon" />
      <span class="tep__btn-name">{{ taskExecutorName(model) }}</span>
      <el-icon class="tep__btn-caret"><ArrowDown /></el-icon>
    </button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item
          v-for="opt in TASK_EXECUTOR_OPTIONS"
          :key="opt.id"
          :command="opt.id"
          :disabled="!availability[opt.id]"
        >
          <span class="tep__item">
            <TaskExecutorIcon :executor="opt.id" class="tep__item-icon" />
            <span class="tep__item-name">{{ opt.name }}</span>
            <el-icon v-if="model === opt.id" class="tep__item-check"><Check /></el-icon>
            <span v-else-if="!availability[opt.id]" class="tep__item-missing">{{ $t('@42BB9:未安装') }}</span>
          </span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.tep { vertical-align: middle; }
.tep__btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-pill);
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    border-color var(--transition-fast) var(--ease-custom);
}
.tep__btn:hover,
.tep__btn:focus-visible {
  color: var(--color-primary);
  border-color: var(--color-primary);
}
.tep__btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.tep__btn-icon { font-size: var(--font-size-mid); }
.tep__btn-caret { font-size: var(--font-size-xs); opacity: 0.7; }
.tep__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 132px;
}
.tep__item-icon { font-size: var(--font-size-base); flex: none; }
.tep__item-name { flex: 1; }
.tep__item-check { color: var(--color-primary); font-size: var(--font-size-sm); }
.tep__item-missing { font-size: var(--font-size-xs); color: var(--text-tertiary, var(--text-secondary)); }
</style>
