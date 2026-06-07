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
