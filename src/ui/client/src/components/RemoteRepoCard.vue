<script setup lang="ts">
import { $t } from '@/lang/static'
import { DocumentCopy } from '@element-plus/icons-vue'
import { useGitStore } from '@stores/gitStore'
import IconButton from '@components/IconButton.vue'

const gitStore = useGitStore()
</script>

<template>
  <div v-if="gitStore.remoteUrl" class="remote-wrapper">
    <svg-icon icon-class="remote-repo" class-name="remote-repo-icon" />
    <el-tooltip :content="$t('@F13B4:复制克隆命令')" placement="top" effect="dark" :show-after="300">
      <span class="repo-url clickable" @click="gitStore.copyCloneCommand()">{{ gitStore.remoteUrl }}</span>
    </el-tooltip>
    <IconButton
      size="small"
      :tooltip="$t('@F13B4:复制仓库地址')"
      @click="gitStore.copyRemoteUrl()"
    >
      <el-icon><DocumentCopy /></el-icon>
    </IconButton>
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
