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
import { ref } from 'vue'
import { VideoPlay } from '@element-plus/icons-vue'

const props = defineProps<{
  nodeId: string
}>()

const emit = defineEmits<{
  (e: 'execute-from-node', nodeId: string): void
  (e: 'execute-single-node', nodeId: string): void
}>()

const dropdownVisible = ref(false)

function handleCommand(command: string) {
  if (command === 'executeFrom') {
    emit('execute-from-node', props.nodeId)
  } else if (command === 'executeSingle') {
    emit('execute-single-node', props.nodeId)
  }
}
</script>

<template>
  <el-dropdown
    trigger="contextmenu"
    @command="handleCommand"
    @visible-change="(val: boolean) => dropdownVisible = val"
    popper-class="flow-node-dropdown"
  >
    <slot :dropdown-visible="dropdownVisible"></slot>

    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="executeFrom">
          <el-icon><VideoPlay /></el-icon>
          从此处开始执行
        </el-dropdown-item>
        <el-dropdown-item command="executeSingle">
          <el-icon><VideoPlay /></el-icon>
          只执行此节点
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
