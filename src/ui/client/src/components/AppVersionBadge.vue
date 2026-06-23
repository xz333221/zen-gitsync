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
import { onMounted, ref, computed, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'
import { fetchAppVersion, startAppUpgrade, restartApp, type AppVersionInfo } from '@/utils/appVersion'
import UpgradeDialog from './UpgradeDialog.vue'

// 由 vite.config.ts 在构建时从外层 package.json 注入
const buildVersion = import.meta.env.PKG_VERSION
const releasesUrl = 'https://github.com/xz333221/zen-gitsync/releases'

// 升级成功后会被后端返回的 current 覆盖，确保 footer 立刻反映新版本
const runtimeVersion = ref<string>(buildVersion)
const displayVersion = computed(() => runtimeVersion.value || buildVersion)

const latestInfo = ref<AppVersionInfo | null>(null)
const upgradeDialogVisible = ref(false)
const upgradeLogs = ref('')
const upgradeStatus = ref<'running' | 'success' | 'failed'>('running')

// 升级成功 → 自动重启的倒计时（秒）。0 表示不启动自动重启
const AUTO_REFRESH_SECONDS = 5
const countdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

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
    // 把后端读到的真实版本覆盖到 footer，让用户立即看到当前版本
    if (info.current) {
      runtimeVersion.value = info.current
    }
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
        // 立即把 footer 上的版本号更新到后端报告的 latest，
        // 这样用户不重启也能看到"已经升级到 vX.Y.Z"的提示
        if (latestInfo.value?.latest) {
          runtimeVersion.value = latestInfo.value.latest
        }
        // 启动自动刷新倒计时：N 秒后自动调用重启接口 + 刷新页面
        startAutoRefreshCountdown()
      }
    } else if (evt.message) {
      upgradeLogs.value += evt.message
    }
  })
}

function startAutoRefreshCountdown() {
  // 防止重复启动
  cancelAutoRefreshCountdown()
  countdown.value = AUTO_REFRESH_SECONDS
  countdownTimer = setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) {
      // 倒计时归零：清理 timer 并自动触发重启
      if (countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = null
      }
      handleRestart()
    }
  }, 1000)
}

function cancelAutoRefreshCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  countdown.value = 0
}

function handleCancelAutoRefresh() {
  // 子组件(UpgradeDialog)汇报"用户选择稍后或关闭弹窗"
  cancelAutoRefreshCountdown()
}

async function handleRestart() {
  // 用户主动点"立即重启"或在倒计时归零时触发：先取消倒计时避免重复触发
  cancelAutoRefreshCountdown()
  try {
    await restartApp()
    // 给服务端 300ms 时间退出，再尝试 reload
    setTimeout(() => {
      // 加 cache buster 防止浏览器从 disk cache 命中旧 SPA
      window.location.reload()
    }, 600)
  } catch (err: any) {
    ElMessage({
      type: 'warning',
      message: $t('@F13B4:重启失败 {error}', { error: err?.message || '' })
    })
  }
}

onBeforeUnmount(() => {
  cancelAutoRefreshCountdown()
})

onMounted(() => {
  // 静默检查（1 小时内的结果走缓存，命中时不打扰用户）
  checkUpdate(true)
})
</script>

<template>
  <div class="app-version-badge">
    <!-- GitHub 链接 -->
    <el-tooltip :content="$t('@F13B4:在 GitHub 上查看源码')" placement="top" effect="dark" :show-after="300">
      <a
        href="https://github.com/xz333221/zen-gitsync"
        target="_blank"
        rel="noopener noreferrer"
        class="badge-icon-link"
        :aria-label="$t('@F13B4:在 GitHub 上查看源码')"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
        </svg>
      </a>
    </el-tooltip>

    <!-- NPM 链接 -->
    <el-tooltip :content="$t('@F13B4:在 npm 上查看包')" placement="top" effect="dark" :show-after="300">
      <a
        href="https://www.npmjs.com/package/zen-gitsync"
        target="_blank"
        rel="noopener noreferrer"
        class="badge-icon-link badge-icon-link--npm"
        :aria-label="$t('@F13B4:在 npm 上查看包')"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 2v20h20V2H2zm17.167 17.167H12.5v-10h-3.333v10H4.833V4.833h14.334v14.334z"/>
        </svg>
      </a>
    </el-tooltip>

    <!-- 版本号 -->
    <el-tooltip :content="$t('@F13B4:查看更新')" placement="top" effect="dark" :show-after="300">
      <a
        :href="releasesUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="version-link"
      >v{{ displayVersion }}</a>
    </el-tooltip>

    <button
      v-if="latestInfo?.hasUpdate"
      type="button"
      class="upgrade-btn"
      :title="$t('@F13B4:发现新版本 {version}，点击升级', { version: latestInfo.latest ?? '' })"
      :aria-label="$t('@F13B4:发现新版本 {version}，点击升级', { version: latestInfo.latest ?? '' })"
      @click="handleUpgrade"
    >
      <span class="upgrade-btn__dot" aria-hidden="true"></span>
      <span class="upgrade-btn__label">{{ $t('@F13B4:升级') }}</span>
      <span class="upgrade-btn__version">v{{ latestInfo.latest }}</span>
    </button>

    <UpgradeDialog
      v-model="upgradeDialogVisible"
      :logs="upgradeLogs"
      :status="upgradeStatus"
      :countdown="countdown"
      @retry="handleUpgrade"
      @restart="handleRestart"
      @cancel="handleCancelAutoRefresh"
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

/* ── 图标链接（GitHub / NPM） ── */
.badge-icon-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-tertiary);
  opacity: 0.7;
  text-decoration: none;
  transition: color 0.18s ease, opacity 0.18s ease, background 0.18s ease;

  &:hover {
    opacity: 1;
    color: var(--text-secondary);
    background: var(--bg-hover, rgba(0, 0, 0, 0.06));
  }
}
.badge-icon-link--npm:hover {
  color: #cb3837;
}
.badge-icon-link:first-child:hover {
  color: var(--text-primary);
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
  // 独立的胶囊按钮：不再被 el-tooltip 包裹，避免 tooltip padding 区域扩大误点击区
  // 直接给 button 元素加样式，hover/active 都在自身范围内
  appearance: none;
  outline: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 10px 0 8px;
  margin: 0;
  border: 0;
  border-radius: 11px;
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  background: linear-gradient(135deg, var(--color-primary) 0%, #3a8ee6 100%);
  box-shadow: var(--shadow-sm);
  transition:
    transform var(--transition-fast) var(--ease-custom),
    box-shadow var(--transition-fast) var(--ease-custom),
    filter var(--transition-fast) var(--ease-custom);
  white-space: nowrap;
  user-select: none;

  &:hover {
    filter: brightness(1.08);
    box-shadow: var(--shadow-md);
    transform: translateY(-1px);
  }

  &:active {
    transform: translateY(0);
    filter: brightness(0.96);
    box-shadow: var(--shadow-sm);
  }

  &:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 2px;
  }
}

.upgrade-btn__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
  animation: upgrade-pulse 1.6s ease-in-out infinite;
  flex-shrink: 0;
}

.upgrade-btn__label {
  letter-spacing: 0.5px;
}

.upgrade-btn__version {
  font-family: monospace;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.22);
  line-height: 1.2;
}

@keyframes upgrade-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.8); }
}
</style>
