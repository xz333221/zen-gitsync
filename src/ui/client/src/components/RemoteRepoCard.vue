<script setup lang="ts">
import { $t } from '@/lang/static'
import { DocumentCopy, Download } from '@element-plus/icons-vue'
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
        <el-tooltip :content="gitStore.remoteUrl" placement="top" effect="dark" :show-after="300">
          <span class="repo-url">{{ gitStore.remoteUrl }}</span>
        </el-tooltip>
      </template>
      <template #actions>
        <IconButton
          :tooltip="$t('@F13B4:复制仓库地址')"
          @click="gitStore.copyRemoteUrl()"
        >
          <el-icon><DocumentCopy /></el-icon>
        </IconButton>
        <IconButton
          :tooltip="$t('@F13B4:复制克隆命令')"
          @click="gitStore.copyCloneCommand()"
        >
          <el-icon><Download /></el-icon>
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
}
</style>
