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
<template>
  <svg
    :class="svgClass"
    :aria-hidden="decorative ? 'true' : undefined"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : (ariaLabel || undefined)"
    :focusable="decorative ? 'false' : undefined"
  >
    <use :xlink:href="iconName" />
  </svg>
</template>

<script lang="ts" setup name="SvgIcon">
import { computed } from 'vue'

const props = defineProps({
  iconClass: {
    type: String,
    required: true,
  },
  className: {
    type: String,
    default: '',
  },
  /**
   * 是否装饰性图标。
   * - true (默认): aria-hidden=true，屏幕阅读器跳过
   * - false: 作为 img + aria-label 语义化使用(如 Logo、状态徽章等)
   */
  decorative: {
    type: Boolean,
    default: true,
  },
  /**
   * 语义化图标 (decorative=false) 时的无障碍标签
   */
  ariaLabel: {
    type: String,
    default: '',
  },
})

const iconName = computed(() => `#icon-${props.iconClass}`)

const svgClass = computed(() => {
  if (props.className) {
    return `svg-icon ${props.className}`
  }
  return 'svg-icon'
})
</script>

<style scoped>
.svg-icon {
  width: 1em;
  height: 1em;
  vertical-align: -0.15em;
  fill: currentColor;
  overflow: hidden;
  color: var(--text-secondary);
}
</style>