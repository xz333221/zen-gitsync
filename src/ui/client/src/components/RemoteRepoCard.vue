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
    <!-- 房子图标：点击后跳转到对应的仓库主页
         (1) 已经是 http(s) 形式 → 直接打开
         (2) SSH 形式 (git@github.com:user/repo.git) → 仅 host 在已知 web 平台白名单内时转 https
         (3) 其它情况（自建域 SSH 等）→ 不响应，鼠标保持默认，tooltip 提示无法打开
         因为只有房子图标可点击，repo-url 文本仍维持"点击复制"语义 -->
    <el-tooltip
      :content="gitStore.isRemoteBrowsable
        ? $t('@F13B4:在浏览器中打开仓库主页')
        : $t('@F13B4:无法识别该远程仓库的网页地址')"
      placement="top"
      effect="dark"
      :show-after="300"
    >
      <a
        v-if="gitStore.isRemoteBrowsable"
        :href="gitStore.remoteWebUrl!"
        target="_blank"
        rel="noopener noreferrer"
        class="remote-repo-link"
        :aria-label="$t('@F13B4:在浏览器中打开仓库主页')"
        @click.stop
      >
        <svg-icon icon-class="remote-repo" class-name="remote-repo-icon" />
      </a>
      <span
        v-else
        class="remote-repo-link remote-repo-link--disabled"
        :aria-label="$t('@F13B4:无法识别该远程仓库的网页地址')"
      >
        <svg-icon icon-class="remote-repo" class-name="remote-repo-icon" />
      </span>
    </el-tooltip>
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

.remote-repo-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  text-decoration: none;
  color: var(--color-text);
  opacity: 0.7;
  transition: color 0.18s ease, opacity 0.18s ease, background 0.18s ease;

  &:hover {
    opacity: 1;
    color: var(--color-primary);
    background: var(--bg-hover, rgba(0, 0, 0, 0.06));
  }

  &--disabled {
    cursor: not-allowed;
    opacity: 0.4;

    &:hover {
      opacity: 0.5;
      background: transparent;
    }
  }
}

.remote-repo-icon {
  width: 16px;
  height: 16px;
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
