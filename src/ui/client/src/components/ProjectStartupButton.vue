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
import { useI18n } from 'vue-i18n'
import IconButton from '@components/IconButton.vue'
import ProjectStartupDialog from '@components/ProjectStartupDialog.vue'

const { t } = useI18n()

const emit = defineEmits<{
  'execute-command': [command: any]
  'execute-workflow': [workflow: any]
}>()

const dialogVisible = ref(false)

function openDialog() {
  dialogVisible.value = true
}

function handleExecuteCommand(command: any) {
  emit('execute-command', command)
}

function handleExecuteWorkflow(workflow: any) {
  emit('execute-workflow', workflow)
}
</script>

<template>
  <div>
    <IconButton
      :tooltip="t('@PSTART:项目启动项')"
      hover-color="var(--color-primary)"
      @click="openDialog"
      custom-class="project-startup-btn"
    >
      <!-- player-play.svg（Tabler icons，MIT）：原 start-run-command 精灵（文档+播放）的等价物 -->
      <svg class="icon-btn" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 4v16l13-8l-13-8" />
      </svg>
    </IconButton>

    <ProjectStartupDialog 
      v-model:visible="dialogVisible"
      @execute-command="handleExecuteCommand"
      @execute-workflow="handleExecuteWorkflow"
    />
  </div>
</template>

<style scoped lang="scss">
.project-startup-btn {
  &:hover {
    color: var(--color-primary);
    background: var(--tint-primary-10);
  }
}
</style>
