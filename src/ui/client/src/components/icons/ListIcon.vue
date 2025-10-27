<template>
  <svg
    viewBox="0 0 16 16"
    xmlns="http://www.w3.org/2000/svg"
    :width="size"
    :height="size"
    fill="currentColor"
    stroke="none"
  >
    <!-- 简洁的列表图标 - 三条横线 -->
    <rect x="2" y="3" width="12" height="2" rx="0.5" />
    <rect x="2" y="7" width="12" height="2" rx="0.5" />
    <rect x="2" y="11" width="12" height="2" rx="0.5" />
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
