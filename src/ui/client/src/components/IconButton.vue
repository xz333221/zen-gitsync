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
  // 提示文本
  tooltip?: string
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
      @click="handleClick"
    >
      <!-- SVG 图标 -->
      <svg-icon
        v-if="iconClass"
        :icon-class="iconClass"
        :style="{ color: color || undefined }"
      />
      
      <!-- 图片图标 -->
      <img
        v-else-if="imageUrl"
        :src="imageUrl"
        alt="icon"
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
  transition: all 0.3s ease;
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  padding: 0;
  
  &:focus {
    outline: none;
  }
  
  &:focus-visible {
    box-shadow: 0 0 0 2px var(--color-primary-light);
  }
  
  // 尺寸变体
  &--small {
    width: 28px;
    height: 28px;
    font-size: 16px; // SVG 图标根据 font-size 显示大小
    
    :deep(.svg-icon) {
      width: 16px;
      height: 16px;
      font-size: 16px;
    }
    
    :deep(.el-icon) {
      font-size: 16px;
    }
    
    .icon-image {
      width: 16px;
      height: 16px;
    }
  }
  
  &--medium {
    width: 36px;
    height: 36px;
    font-size: 20px; // SVG 图标根据 font-size 显示大小
    
    :deep(.svg-icon) {
      width: 20px;
      height: 20px;
      font-size: 20px;
    }
    
    :deep(.el-icon) {
      font-size: 20px;
    }
    
    .icon-image {
      width: 20px;
      height: 20px;
    }
  }
  
  &--large {
    width: 40px;
    height: 40px;
    font-size: 22px; // SVG 图标根据 font-size 显示大小
    
    :deep(.svg-icon) {
      width: 22px;
      height: 22px;
      font-size: 22px;
    }
    
    :deep(.el-icon) {
      font-size: 22px;
    }
    
    .icon-image {
      width: 22px;
      height: 22px;
    }
  }
  
  // Hover 效果
  &:hover:not(.is-disabled) {
    color: v-bind(hoverColor);
    background: rgba(64, 158, 255, 0.15);
    transform: translateY(-2px);
    box-shadow: 0 2px 8px rgba(64, 158, 255, 0.2);
    
    :deep(.svg-icon) {
      color: v-bind(hoverColor);
    }
  }
  
  // Active 效果
  &:active:not(.is-disabled) {
    transform: translateY(0);
    background: rgba(64, 158, 255, 0.2);
    box-shadow: 0 1px 4px rgba(64, 158, 255, 0.15);
  }
  
  // 激活状态
  &.is-active {
    color: v-bind(hoverColor);
    background: rgba(64, 158, 255, 0.15);
    
    :deep(.svg-icon) {
      color: v-bind(hoverColor);
    }
    
    &:hover {
      background: rgba(64, 158, 255, 0.25);
      box-shadow: 0 2px 8px rgba(64, 158, 255, 0.25);
    }
  }
  
  // 禁用状态
  &.is-disabled {
    cursor: not-allowed;
    opacity: 0.5;
    color: var(--text-disabled);
    
    :deep(.svg-icon) {
      color: var(--text-disabled);
    }
  }
  
  // 图片图标样式
  .icon-image {
    display: block;
    object-fit: contain;
    transition: all 0.3s ease;
  }
}
</style>
