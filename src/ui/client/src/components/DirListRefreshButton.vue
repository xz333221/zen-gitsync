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
  「刷新全部」按钮本体 —— **纯展示**,不含任何刷新逻辑(逻辑全在 RecentDirectoriesList 里,
  这里只负责"按下 click 把事件抛回去")。

  抽成独立组件是因为同一个动作出现在**两个标题行**里,而这两行分属两个不同的 DOM:
    - 最近项目面板(RecentDirectoriesList 的 variant="panel"):自带 .dir-list__head
    - 切换工作目录弹窗(DirectorySelector):标题是 el-form-item 的 label,列表以
      variant="bare" 嵌在下面,自己没有标题行
  两边都指同一份数据(GET /api/recent_directories),卡片徽标含义也一样,按钮没理由长得不一样。
  但插槽解决不了"落到调用方自己那一行":slot 内容的落点由**列表组件里的 <slot> 出海口**
  决定,而弹窗要的是它的 label 行 —— 那是列表组件外面的一块地。于是列表组件把刷新状态与
  动作 expose 出去(见它的 defineExpose),由调用方渲染这个同一个组件。

  结果:文案、图标、禁用规则、动效、类名(.dir-list__refresh)只有一份,两处不会漂。
  刷新为什么是"逐目录 + 要联网",看 RecentDirectoriesList.vue 里 refreshAllGitStates 的注释。
-->
<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";

const props = withDefaults(defineProps<{
  /** 按钮文案,由调用方算好:空闲「刷新全部」/ 刷新中「刷新中 3/18」 */
  label: string;
  /** 悬浮提示:讲清这是个要花几秒联网的显式动作 */
  title?: string;
  /** 无障碍标签;不传时退回 title */
  ariaLabel?: string;
  /** 正在刷新:图标转圈、按钮禁用 */
  refreshing?: boolean;
  /** 调用方额外的禁用条件(列表为空时没有可刷的目标) */
  disabled?: boolean;
}>(), {
  title: "",
  ariaLabel: "",
  refreshing: false,
  disabled: false,
});

const emit = defineEmits<{ click: [event: MouseEvent] }>();

// disabled 用属性而不是只靠模板的 :disabled —— 原生 disabled 拦得住点击,
// 但 keydown 之类的程序化触发仍会走到这里,补一道判断避免刷新中途被重复发起
function onClick(event: MouseEvent) {
  if (props.disabled || props.refreshing) return;
  emit("click", event);
}
</script>

<template>
  <!-- 类名保持 .dir-list__refresh:这个按钮原本就长在列表组件里,
       单测(RecentDirectoriesList.test.ts)按这个类名定位,别随手改。 -->
  <button
    type="button"
    class="dir-list__refresh"
    :disabled="refreshing || disabled"
    :title="title"
    :aria-label="ariaLabel || title || undefined"
    @click="onClick"
  >
    <el-icon :class="{ 'is-spinning': refreshing }" aria-hidden="true"><Refresh /></el-icon>
    <span>{{ label }}</span>
  </button>
</template>

<style scoped>
/* 「刷新全部」:一个要花几秒联网的显式动作,所以不做成无边框图标 ——
   有边框才有"这里可以点"的暗示。卡片上那些 icon-only 操作用的是另一套语汇
   (hover 才出现、无边框),两者语义不同,不强行统一。 */
.dir-list__refresh {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-mid);
  /* 显式行高:按钮高度只由 height 决定,不受外部继承的行高影响
     (弹窗里它坐在 el-form-item 的 label 行中,外面继承的是表单控件行高) */
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.dir-list__refresh:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-08);
}
.dir-list__refresh:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.dir-list__refresh:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.dir-list__refresh .el-icon {
  font-size: var(--font-size-base);
}
.dir-list__refresh .el-icon.is-spinning {
  animation: dir-list-spin 0.9s linear infinite;
}
@keyframes dir-list-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .dir-list__refresh .el-icon.is-spinning { animation: none; }
}
</style>
