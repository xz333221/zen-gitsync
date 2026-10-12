<script setup lang="ts">
// 任务执行器的品牌图标：claude / opencode / codex / codebuddy 各一张彩色 SVG。
// 统一收口成组件的原因：执行按钮下拉、派发控制台、设置弹窗三处都要用，
// 图标路径和尺寸口径只写一遍，以后加执行器也只改这里。
//
// 尺寸用 1em 跟随父级 font-size：塞进 11px 的按钮和 14px 的菜单项
// 都能自动对齐文字，不用每处再写死 px。
//
// codex 标是纯黑单色（OpenAI 结），深色主题下要反相成白色 —— 打 .icon-invert-dark，
// 规则与理由见 styles/dark-theme.scss。codebuddy 是官方彩色标（青绿渐变底），
// 深浅色都不反相。
import { computed } from 'vue'
import claudeIcon from '@/assets/icons/svg/claudecode-color.svg'
import opencodeIcon from '@/assets/icons/svg/opencode.svg'
import codexIcon from '@/assets/icons/svg/codex.svg'
// codebuddy 官方标压到 5.2KB 后仍超 vite 默认内联阈值（4KB），加 ?inline 强制内联成
// data URL —— 与另三家同一条消费路径（<img src> 零网络请求），图标指纹探针
// （verify-wb-card-executor-icon.cjs）也才能对 content hash。
import codebuddyIcon from '@/assets/icons/svg/codebuddy.svg?inline'
import type { TaskExecutorId } from '@/utils/taskExecutor'

const props = defineProps<{ executor: TaskExecutorId }>()

const ICONS: Record<TaskExecutorId, string> = {
  claude: claudeIcon,
  opencode: opencodeIcon,
  codex: codexIcon,
  codebuddy: codebuddyIcon,
}

const src = computed(() => ICONS[props.executor])
</script>

<template>
  <img
    :src="src"
    alt=""
    class="task-executor-icon"
    :class="{ 'icon-invert-dark': executor === 'codex' }"
    draggable="false"
  />
</template>

<style scoped>
.task-executor-icon {
  width: 1em;
  height: 1em;
  object-fit: contain;
  display: inline-block;
  vertical-align: -0.125em;
}
</style>
