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
import SvgIcon from '@components/SvgIcon/index.vue'
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
      hover-color="#409EFF"
      @click="openDialog"
      custom-class="project-startup-btn"
    >
      <SvgIcon icon-class="start-run-command" class-name="icon-btn" />
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
    background: rgba(64, 158, 255, 0.1);
  }
}
</style>
