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
  与工作台执行按钮共用同一份"上次用过"）在两处各写一遍，迟早会有一边漏了兜底。

  选择本身是**全局共享**的（composables/useTaskExecutorSelection → configStore
  的 ui.lastTaskExecutor），不是本组件的私有状态，也没有 v-model：
  看板卡片的「执行」按钮、工作台执行按钮、这里的下拉，切了互相跟手 ——
  历史行为，别改回组件内部状态。派发时各入口直接读 composable 的 active。

  下拉项右侧显示**该执行器当前配置的模型**：工作台派任务不传 --model，模型跟随各 CLI
  的配置文件，"这个执行器现在用什么模型"在界面上别处都看不到（数据来自只读探测，
  见 stores/toolsStore 的 executorModel* ）。按钮上不加模型名 —— 那个 pill 只有 22px 高，
  挤进第二段文字会把整行布局带跑；要看当前模型把鼠标停在按钮上，title 里有。
-->
<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ArrowDown, Check } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import TaskExecutorIcon from '@components/TaskExecutorIcon.vue'
import { useTaskExecutorSelection } from '@/composables/useTaskExecutorSelection'
import { useToolsStore } from '@/stores/toolsStore'
import { TASK_EXECUTOR_OPTIONS, taskExecutorName, type TaskExecutorId } from '@/utils/taskExecutor'

const props = defineProps<{
  /** 主按钮的 title（两个入口想说的话不同，但按钮长相、行为一致） */
  title?: string
  /**
   * 只读：不让人改，只显示"g ai 派活实际会用谁"（优先级链算出来的那个）。
   * 用在悬浮面板底栏 —— 那里配了优先级时执行器不由下拉决定，给个能点的下拉
   * 只会让人以为自己选的会生效。
   */
  readonly?: boolean
  /** 只读时显示的执行器（缺省 = active） */
  value?: TaskExecutorId
}>()

const { active, availability, choose, executorModelText, executorModelTitle } = useTaskExecutorSelection()

/** 界面上该显示哪个：只读且指定了就用指定的（= dispatchTarget），否则沿用共享的 active */
const displayed = computed<TaskExecutorId>(() => (props.readonly && props.value ? props.value : active.value))
const toolsStore = useToolsStore()

// 进页面就拉一次模型；store 内部有 TTL 缓存 + 并发去重，本组件在多处实例化也只请求一次
onMounted(() => { void toolsStore.fetchExecutorModels() })

// 可用性 / 模型名 / 兜底全在 composable 里了，这里不再各存一份 ——
// 之前三处各算一遍，其中一处漏了兜底就会显示出一个没装的执行器。

/** 主按钮 title：入口自己的说明 + 当前模型，不进下拉也知道这活是哪个模型跑的 */
function btnTitle(): string {
  return [props.title, executorModelTitle(displayed.value)].filter(Boolean).join(' · ')
}
</script>

<template>
  <!-- 只读态：不是禁用下拉，而是**根本不是下拉** —— 禁用态的下拉点开是空的，更像坏了 -->
  <span v-if="readonly" class="tep tep--static">
    <span class="tep__btn" :title="btnTitle()" :aria-label="$t('@WORKBENCH:任务执行器')">
      <TaskExecutorIcon :executor="displayed" class="tep__btn-icon" />
      <span class="tep__btn-name">{{ taskExecutorName(displayed) }}</span>
      <span class="tep__btn-tag">{{ $t('@AGENT:按优先级') }}</span>
    </span>
  </span>
  <el-dropdown v-else trigger="click" class="tep" @command="choose">
    <button
      type="button"
      class="tep__btn"
      :title="btnTitle()"
      :aria-label="$t('@WORKBENCH:任务执行器')"
    >
      <TaskExecutorIcon :executor="displayed" class="tep__btn-icon" />
      <span class="tep__btn-name">{{ taskExecutorName(displayed) }}</span>
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
            <span
              v-if="executorModelText(opt.id)"
              class="tep__item-model"
              :title="executorModelTitle(opt.id)"
            >{{ executorModelText(opt.id) }}</span>
            <el-icon v-if="displayed === opt.id" class="tep__item-check"><Check /></el-icon>
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
/* 只读态：不是可点的胶囊（没有 hover 反馈，光标也不变手型），右侧挂一枚"按优先级"小签 */
.tep--static .tep__btn { cursor: default; }
.tep--static .tep__btn:hover { color: var(--text-secondary); border-color: var(--border-color); }
.tep__btn-tag {
  padding-left: 5px;
  margin-left: 1px;
  border-left: 1px solid var(--border-color);
  font-size: var(--font-size-xs);
  color: var(--text-meta, var(--text-secondary));
}
.tep__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 132px;
}
.tep__item-icon { font-size: var(--font-size-base); flex: none; }
.tep__item-name { flex: 1; }
/* 当前模型：承载信息的元文字，不是装饰档（--text-tertiary 那种对比度不达 AA） */
.tep__item-model {
  flex: none;
  max-width: 15em;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.tep__item-check { color: var(--color-primary); font-size: var(--font-size-sm); }
.tep__item-missing { font-size: var(--font-size-xs); color: var(--text-meta, var(--text-secondary)); }
</style>
