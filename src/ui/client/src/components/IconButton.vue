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
<script setup lang="ts">
import { computed } from 'vue'
import SvgIcon from '@components/SvgIcon/index.vue'

interface IconButtonProps {
  // SVG 图标类名（来自 assets/icons/svg/）
  iconClass?: string
  // 或者使用图片 URL
  imageUrl?: string
  // 按钮尺寸：small | medium | large
  size?: 'small' | 'medium' | 'large'
  // 是否禁用
  disabled?: boolean
  // 是否激活状态
  active?: boolean
  // 提示文本（同时作为默认 aria-label，可被 ariaLabel 覆盖）
  tooltip?: string
  // 显式无障碍标签（推荐：与 tooltip 同义但更结构化）。若不传则回退到 tooltip
  ariaLabel?: string
  // toggle 按钮的按下状态，会同步设置 aria-pressed
  pressed?: boolean
  // 自定义类名
  customClass?: string
  // 图标颜色（仅对 SVG 图标有效）
  color?: string
  // hover 颜色
  hoverColor?: string
}

const props = withDefaults(defineProps<IconButtonProps>(), {
  size: 'medium',
  disabled: false,
  active: false,
  tooltip: '',
  ariaLabel: '',
  pressed: false,
  customClass: '',
  color: '',
  hoverColor: 'var(--color-primary)',
})

const emit = defineEmits<{
  click: [event: MouseEvent]
}>()

// 计算按钮尺寸类
const sizeClass = computed(() => `icon-button--${props.size}`)

// 处理点击事件
const handleClick = (event: MouseEvent) => {
  if (props.disabled) return
  emit('click', event)
}
</script>

<template>
  <el-tooltip
    :content="tooltip"
    :disabled="!tooltip"
    placement="bottom"
    :show-after="300"
  >
    <button
      type="button"
      class="icon-button"
      :class="[
        sizeClass,
        customClass,
        {
          'is-disabled': disabled,
          'is-active': active,
        }
      ]"
      :disabled="disabled"
      :aria-label="ariaLabel || tooltip || undefined"
      :aria-pressed="pressed ? 'true' : undefined"
      @click="handleClick"
    >
      <!-- SVG 图标 -->
      <svg-icon
        v-if="iconClass"
        :icon-class="iconClass"
        :decorative="true"
        :style="{ color: color || undefined }"
      />

      <!-- 图片图标 -->
      <img
        v-else-if="imageUrl"
        :src="imageUrl"
        alt=""
        aria-hidden="true"
        class="icon-image"
      />

      <!-- 插槽支持自定义内容 -->
      <slot v-else />
    </button>
  </el-tooltip>
</template>

<style scoped lang="scss">
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: var(--dialog-transition);
  border-radius: var(--btn-radius-sm);
  color: var(--text-secondary);
  padding: 0;

  // 鼠标点击的 :focus 不要 outline，只有 :focus-visible（键盘）才显示焦点环
  &:focus:not(:focus-visible) {
    outline: none;
  }

  &:focus-visible {
    /* 2026-10-04：这里原本是**双层**焦点环 —— box-shadow 2px 半透明 halo
       加 outline 2px 实线。而 common.scss:1214-1219 有一段注释明确记录
       「全局焦点环被删掉，因为它跟 zen-ai-chat-ui 叠在一起会出现双层 3px
       同心蓝圈（大框套小框）」—— IconButton 把刚被删掉的东西又写了回来，
       而它有 67 个使用点。
       全站焦点环现在统一走 --focus-outline / --focus-outline-offset
       （见 variables.scss:670-671）。 */
    outline: var(--focus-outline);
    outline-offset: var(--focus-outline-offset);
  }
  
  // 尺寸变体
  &--small {
    width: 28px;
    height: 28px;
    font-size: var(--font-size-base);
    border-radius: var(--btn-radius-sm);
    
    :deep(.svg-icon) {
      width: 14px;
      height: 14px;
      font-size: var(--font-size-base);
    }
    
    :deep(.el-icon) {
      font-size: var(--font-size-base);
    }
    
    .icon-image {
      width: 14px;
      height: 14px;
    }
  }
  
  &--medium {
    width: 38px;
    height: 38px;
    font-size: var(--font-size-xl);
    border-radius: var(--btn-radius);
    
    :deep(.svg-icon) {
      /* 2026-10-04：19px 不在项目任何刻度上（sm/lg 两档字形是 14 / 24），
         改走新加的 --icon-glyph-size-md = 20px。 */
      width: var(--icon-glyph-size-md);
      height: var(--icon-glyph-size-md);
      font-size: var(--font-size-xl);
    }
    
    :deep(.el-icon) {
      font-size: var(--font-size-xl);
    }
    
    .icon-image {
      width: var(--icon-glyph-size-md);
      height: var(--icon-glyph-size-md);
    }
  }
  
  &--large {
    width: 44px;
    height: 44px;
    font-size: var(--font-size-xl);
    border-radius: var(--btn-radius);
    
    :deep(.svg-icon) {
      width: var(--icon-glyph-size-lg);
      height: var(--icon-glyph-size-lg);
      font-size: var(--icon-glyph-size-lg);
    }
    
    :deep(.el-icon) {
      font-size: var(--icon-glyph-size-lg);
    }
    
    .icon-image {
      width: var(--icon-glyph-size-lg);
      height: var(--icon-glyph-size-lg);
    }
  }
  
  // Hover 效果
  &:hover:not(.is-disabled) {
    color: v-bind(hoverColor);
    background: var(--tint-primary-10);
    transform: scale(1.02);
    box-shadow: 0 2px 8px var(--tint-primary-16);
    
    :deep(.svg-icon) {
      color: v-bind(hoverColor);
    }
  }
  
  // Active 效果
  &:active:not(.is-disabled) {
    transform: scale(0.98);
    background: var(--tint-primary-16);
    box-shadow: none;
  }

  // 激活状态
  &.is-active {
    color: v-bind(hoverColor);
    background: var(--tint-primary-12);
    
    :deep(.svg-icon) {
      color: v-bind(hoverColor);
    }
    
    &:hover {
      /* 2026-10-04：原本是 rgba(64,158,255,.18) —— EP 旧默认蓝 #409eff 的
         全仓残留之一，而 variables.scss:394-397 明确记录「单一主色来源，
         不再保留 EP 默认的 #409eff（历史上两套蓝同屏可见色差）」。
         同一规则的下一行 box-shadow 已经用的是 var(--tint-primary-18)，
         这里补齐。 */
      background: var(--tint-primary-18);
      box-shadow: 0 2px 8px var(--tint-primary-18);
    }
  }
  
  // 禁用状态
  &.is-disabled {
    cursor: not-allowed;
    opacity: var(--disabled-opacity);
    color: var(--text-disabled);
    
    :deep(.svg-icon) {
      color: var(--text-disabled);
    }
  }
  
  // 图片图标样式
  .icon-image {
    display: block;
    object-fit: contain;
    transition: var(--dialog-transition);
  }
}
</style>
