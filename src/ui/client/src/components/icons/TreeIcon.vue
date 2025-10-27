<template>
  <svg
    viewBox="0 0 16 16"
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
  >
    <!-- 垂直主线 -->
    <line x1="3" y1="2" x2="3" y2="14" />
    <!-- 第一个分支 -->
    <line x1="3" y1="4" x2="6" y2="4" />
    <rect x="2" y="3" width="8" height="2" rx="0.5" fill="currentColor" stroke="none" />
    <!-- 第二个分支 -->
    <line x1="3" y1="8" x2="6" y2="8" />
    <rect x="4" y="7" width="8" height="2" rx="0.5" fill="currentColor" stroke="none" />
    <!-- 第三个分支 -->
    <line x1="3" y1="12" x2="6" y2="12" />
    <rect x="6" y="11" width="8" height="2" rx="0.5" fill="currentColor" stroke="none" />
  </svg>
</template>

<script setup lang="ts">
interface Props {
  size?: string | number;
}

withDefaults(defineProps<Props>(), {
  size: '1em'
});
</script>
