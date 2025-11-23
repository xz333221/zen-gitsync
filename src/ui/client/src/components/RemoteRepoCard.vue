<script setup lang="ts">
import { $t } from '@/lang/static'
import { DocumentCopy, Download } from '@element-plus/icons-vue'
import InlineCard from '@components/InlineCard.vue'
import { useGitStore } from '@stores/gitStore'

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
        <el-tooltip :content="$t('@F13B4:复制仓库地址')" placement="top" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-28" @click="gitStore.copyRemoteUrl()">
            <el-icon class="btn-icon"><DocumentCopy /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="$t('@F13B4:复制克隆命令')" placement="top" effect="dark" :show-after="200">
          <button class="modern-btn btn-icon-28" @click="gitStore.copyCloneCommand()">
            <el-icon class="btn-icon"><Download /></el-icon>
          </button>
        </el-tooltip>
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
