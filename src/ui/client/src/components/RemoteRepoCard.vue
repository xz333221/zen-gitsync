<script setup lang="ts">
import { $t } from '@/lang/static'
import { DocumentCopy } from '@element-plus/icons-vue'
import InlineCard from '@components/InlineCard.vue'
import { useGitStore } from '@stores/gitStore'
import IconButton from '@components/IconButton.vue'

const gitStore = useGitStore()
</script>

<template>
  <div v-if="gitStore.remoteUrl">
    <InlineCard class="footer-right" compact>
      <template #content>
        <svg-icon icon-class="remote-repo" class-name="remote-repo-icon" />
        <el-tooltip :content="$t('@F13B4:复制克隆命令')" placement="top" effect="dark" :show-after="300">
          <span class="repo-url clickable" @click="gitStore.copyCloneCommand()">{{ gitStore.remoteUrl }}</span>
        </el-tooltip>
      </template>
      <template #actions>
        <IconButton
          size="small"
          :tooltip="$t('@F13B4:复制仓库地址')"
          @click="gitStore.copyRemoteUrl()"
        >
          <el-icon><DocumentCopy /></el-icon>
        </IconButton>
      </template>
    </InlineCard>
  </div>
</template>

<style scoped lang="scss">
.remote-repo-icon {
  width: 16px;
  height: 16px;
  margin-right: 6px;
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
