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
import { $t } from '@/lang/static'
import { useGitStore } from '@stores/gitStore'

const gitStore = useGitStore()
</script>

<template>
  <div v-if="gitStore.remoteUrl" class="remote-wrapper">
    <svg-icon icon-class="remote-repo" class-name="remote-repo-icon" />
    <el-tooltip :content="$t('@F13B4:复制仓库地址')" placement="top" effect="dark" :show-after="300">
      <span class="repo-url clickable" @click="gitStore.copyRemoteUrl()">{{ gitStore.remoteUrl }}</span>
    </el-tooltip>
  </div>
</template>

<style scoped lang="scss">
.remote-wrapper {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-base);
}

.remote-repo-icon {
  width: 16px;
  height: 16px;
  color: var(--color-text);
  vertical-align: middle;
}

.repo-url {
  color: #6c757d;
  font-family: monospace;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &.clickable {
    cursor: pointer;
    transition: color 0.2s;

    &:hover {
      color: var(--el-color-primary);
      text-decoration: underline;
    }
  }
}
</style>
