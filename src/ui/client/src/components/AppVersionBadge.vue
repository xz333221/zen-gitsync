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
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import { fetchAppVersion, startAppUpgrade, type AppVersionInfo } from '@/utils/appVersion'
import UpgradeDialog from './UpgradeDialog.vue'

// 由 vite.config.ts 在构建时从外层 package.json 注入
const version = import.meta.env.PKG_VERSION
const releasesUrl = 'https://github.com/xz333221/zen-gitsync/releases'

const latestInfo = ref<AppVersionInfo | null>(null)
const upgradeDialogVisible = ref(false)
const upgradeLogs = ref('')
const upgradeStatus = ref<'running' | 'success' | 'failed'>('running')

const CACHE_KEY = 'app-version-check'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时

function readCache(): AppVersionInfo | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { at, data } = JSON.parse(raw)
    if (Date.now() - at > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(data: AppVersionInfo) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
  } catch {}
}

async function checkUpdate(silent = false) {
  const cached = readCache()
  if (cached) {
    latestInfo.value = cached
  }
  try {
    const info = await fetchAppVersion()
    latestInfo.value = info
    writeCache(info)
    if (!silent && info.success && info.hasUpdate) {
      ElMessage({
        type: 'success',
        message: $t('@F13B4:发现新版本 {version}', { version: info.latest ?? '' }),
        duration: 4000
      })
    }
  } catch (err: any) {
    if (!silent) {
      ElMessage({
        type: 'warning',
        message: $t('@F13B4:检查更新失败 {error}', { error: err?.message || '' })
      })
    }
  }
}

async function handleUpgrade() {
  if (!latestInfo.value?.hasUpdate) return

  try {
    await ElMessageBox.confirm(
      $t('@F13B4:确定要从 {current} 升级到 {latest} 吗？', {
        current: latestInfo.value.current,
        latest: latestInfo.value.latest
      }),
      $t('@F13B4:升级'),
      {
        confirmButtonText: $t('@F13B4:确定升级'),
        cancelButtonText: $t('@F13B4:取消'),
        type: 'info'
      }
    )
  } catch {
    return // 用户取消
  }

  upgradeLogs.value = ''
  upgradeStatus.value = 'running'
  upgradeDialogVisible.value = true

  await startAppUpgrade((evt) => {
    if (evt.type === 'done') {
      upgradeStatus.value = evt.code === 0 ? 'success' : 'failed'
      if (evt.code === 0) {
        // 升级成功后清掉缓存，等下次进页面自动重查
        try { sessionStorage.removeItem(CACHE_KEY) } catch {}
      }
    } else if (evt.message) {
      upgradeLogs.value += evt.message
    }
  })
}

onMounted(() => {
  // 静默检查（1 小时内的结果走缓存，命中时不打扰用户）
  checkUpdate(true)
})
</script>

<template>
  <div class="app-version-badge">
    <el-tooltip :content="$t('@F13B4:查看更新')" placement="top" effect="dark" :show-after="300">
      <a
        :href="releasesUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="version-link"
      >v{{ version }}</a>
    </el-tooltip>

    <el-tooltip
      v-if="latestInfo?.hasUpdate"
      :content="$t('@F13B4:发现新版本 {version}', { version: latestInfo.latest ?? '' })"
      placement="top"
      effect="dark"
      :show-after="300"
    >
      <el-button
        class="upgrade-btn"
        size="small"
        type="primary"
        @click="handleUpgrade"
      >{{ $t('@F13B4:升级') }}</el-button>
    </el-tooltip>

    <UpgradeDialog
      v-model="upgradeDialogVisible"
      :logs="upgradeLogs"
      :status="upgradeStatus"
      @retry="handleUpgrade"
    />
  </div>
</template>

<style scoped lang="scss">
.app-version-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-base);
  margin-left: auto;
}

.version-link {
  font-family: monospace;
  font-size: 11px;
  color: #6c757d;
  text-decoration: none;
  padding: 2px 6px;
  border-radius: 3px;
  transition: color 0.2s, background-color 0.2s;

  &:hover {
    color: var(--el-color-primary);
    background-color: rgba(0, 0, 0, 0.04);
  }
}

.upgrade-btn {
  // 让按钮和 v2.12.9 在视觉上更平衡
  font-size: 11px !important;
  padding: 0 8px !important;
  height: 20px !important;
  border-radius: 3px !important;
}
</style>
