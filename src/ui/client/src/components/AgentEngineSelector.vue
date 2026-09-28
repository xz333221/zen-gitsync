<!--
  智能体「引擎」选择器 —— 下拉切换谁来跑这一轮对话。

  一个组件收口三处消费方（智能体视图顶部、工作台左栏、文件空间 g ai 面板），
  免得同一套「可用性映射 + 未安装开安装弹窗 + 图标二选一」抄第二遍
  （本仓库为"同一份清单抄两处"吃过亏，见 utils/agentEngine.ts 头注释）。

  引擎在会话建立时锁定：`locked` 为真时按钮置灰、下拉不弹，要换只能新建会话。
  父级负责把「当前会话的引擎 / 下次新建用的引擎」算出 displayEngine 再传进来
  （两种取值的口径见 utils/agentEngine.ts）。
-->
<template>
  <!-- 单根包一层：父级传下来的 class（Tab 行的 margin-left:auto、面板的 flex:none）
       才能可靠落到这里 —— 多根组件会丢掉 fallthrough class。 -->
  <div class="agent-engine">
    <el-dropdown trigger="click" @command="onCommand">
      <button
        type="button"
        class="agent-engine__btn"
        :class="{ 'is-locked': locked }"
        :disabled="locked"
        :title="locked
          ? $t('@AGENT:本会话的引擎已锁定；要换引擎请新建会话')
          : $t('@AGENT:新建会话使用的引擎')"
        :aria-label="$t('@AGENT:智能体引擎')"
      >
        <TaskExecutorIcon
          v-if="isExternalAgentEngine(engine)"
          :executor="engine as TaskExecutorId"
          class="agent-engine__icon"
        />
        <svg-icon v-else :icon-class="BUILTIN_ENGINE_ICON" class="agent-engine__icon" />
        <span class="agent-engine__name">{{ engineName }}</span>
        <el-icon class="agent-engine__caret"><ArrowDown /></el-icon>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="opt in AGENT_ENGINE_OPTIONS"
            :key="opt.id"
            :command="opt.id"
          >
            <span class="agent-engine__item">
              <TaskExecutorIcon
                v-if="isExternalAgentEngine(opt.id)"
                :executor="opt.id as TaskExecutorId"
                class="agent-engine__item-icon"
              />
              <svg-icon v-else :icon-class="BUILTIN_ENGINE_ICON" class="agent-engine__item-icon" />
              <span class="agent-engine__item-name">{{ opt.name }}</span>
              <el-icon v-if="engine === opt.id" class="agent-engine__item-check"><Check /></el-icon>
              <span v-else-if="!engineAvailability[opt.id]" class="agent-engine__item-missing">{{ $t('@42BB9:未安装') }}</span>
            </span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <ToolInstallDialog v-model="installDialogVisible" :tool="installTool" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { $t } from '@/lang/static'
import { ElIcon, ElDropdown, ElDropdownMenu, ElDropdownItem } from 'element-plus'
import { ArrowDown, Check } from '@element-plus/icons-vue'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'
import {
  AGENT_ENGINE_OPTIONS,
  BUILTIN_ENGINE_ICON,
  agentEngineName,
  isExternalAgentEngine,
  type AgentEngineId,
} from '@/utils/agentEngine'
import type { TaskExecutorId } from '@/utils/taskExecutor'
import SvgIcon from '@/components/SvgIcon/index.vue'
import TaskExecutorIcon from '@/components/TaskExecutorIcon.vue'
import ToolInstallDialog from '@/components/ToolInstallDialog.vue'

const props = defineProps<{
  /** 当前展示的引擎（已有会话取它自己的，没有会话取"下次新建会用哪个"） */
  engine: AgentEngineId
  /** 会话已落盘、引擎锁死：按钮置灰，要换请新建会话 */
  locked?: boolean
}>()

const emit = defineEmits<{ (e: 'select', id: AgentEngineId): void }>()

const toolsStore = useToolsStore()

const engineName = computed(() => agentEngineName(props.engine))

/** 未安装的项在下拉里置灰并标「未安装」——与工作台 OrchestratorConsole 同一口径（同一个 toolsStore） */
const engineAvailability = computed<Record<string, boolean>>(() => ({
  gai: true,
  claude: toolsStore.claudeAvailable,
  opencode: toolsStore.opencodeAvailable,
  codex: toolsStore.codexAvailable,
}))

// 未安装的引擎点了不是静默失败，而是直接开安装弹窗（与工作台同一条路径）。
// 类型用 ToolId：内置的 g ai 没有对应安装器，所以它永远是 null。
const installDialogVisible = ref(false)
const installTool = ref<ToolId | null>(null)

function onCommand(id: AgentEngineId) {
  // 已落盘的会话不允许中途换引擎（服务端也会拦 ENGINE_LOCKED）
  if (props.locked) return
  if (!engineAvailability.value[id]) {
    // g ai 是内置的、没有安装器；能走到「未安装」的必然是外部三家
    if (!isExternalAgentEngine(id)) return
    installTool.value = id
    installDialogVisible.value = true
    return
  }
  emit('select', id)
}
</script>

<style scoped lang="scss">
/* 刻意扁平 —— 只有图标 + 引擎名 + caret，没有底色没有边框装饰；未安装的项在菜单里标出来。
   四个引擎都带自己的图标（内置 g ai 用 sprite 的 g-ai，与顶栏同一个）。 */
.agent-engine {
  vertical-align: middle;
}

.agent-engine__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-family: inherit;
  line-height: 1.5;
  cursor: pointer;
  transition: border-color var(--transition-fast) ease, color var(--transition-fast) ease;
}

.agent-engine__btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--text-primary);
}

.agent-engine__btn:disabled {
  cursor: not-allowed;
  color: var(--text-tertiary);
}

/* 两种图标机制（<img> 品牌彩色 SVG / sprite 的 <svg-icon>）在同一个 1em 盒子里对齐：
   尺寸统一由这里的 font-size 定，flex 里一律不许被压缩（否则窄一点的按钮会把图标挤扁）。 */
.agent-engine__icon,
.agent-engine__item-icon {
  font-size: 14px;
  flex: none;
}

.agent-engine__caret {
  font-size: 12px;
  color: var(--text-tertiary);
}

.agent-engine__item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 148px;
}

.agent-engine__item-name {
  flex: 1;
}

.agent-engine__item-check {
  font-size: 13px;
  color: var(--color-primary);
}

.agent-engine__item-missing {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}
</style>
