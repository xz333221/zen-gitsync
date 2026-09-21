<!--
  智能体页面的「广场」面板:Skill 广场 / MCP 广场共用这一份。
  - 按来源分组展示(每个来源独立请求、独立降级,一个目录站挂了不影响其他组)
  - 两个安装目标:当前项目(.claude/skills、.mcp.json)/ g ai 智能体(~/.zen-gitsync/ai/)
  - MCP 需要 API key 时弹窗收集环境变量;参数(如 Filesystem 的目录)可改
  后端见 src/ui/server/routes/workbench/agentMarketplace.js
-->
<script setup lang="ts">
import { ref, computed, watch, reactive } from 'vue'
import { $t } from '@/lang/static'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh, Delete, Link, Check, Star, Download, Warning } from '@element-plus/icons-vue'
import { useConfigStore } from '@/stores/configStore'

const props = defineProps<{
  type: 'skill' | 'mcp'
}>()

const configStore = useConfigStore()

// ── 状态 ──────────────────────────────────────────────────
interface MarketItem {
  id: string
  name: string
  description: string
  repository?: string
  subpath?: string
  package?: string
  args?: string[] | null
  envKeys?: string[]
  transport?: string
  remoteUrl?: string
  stars?: number
  downloads?: number
  uses?: number
  verified?: boolean
  upstream?: string
  tags?: string[]
  installable?: boolean
  installed?: boolean
}

interface SourceGroup {
  id: string
  label: string
  kind: 'builtin' | 'live'
  homepage?: string
  status: 'ok' | 'error'
  error?: string
  items: MarketItem[]
  count?: number
}

interface InstalledItem {
  id: string
  name: string
  description: string
  target: 'project' | 'global'
  package?: string
  command?: string
  requiredEnv?: string[]
}

const groups = ref<SourceGroup[]>([])
const installed = ref<InstalledItem[]>([])
const loading = ref(false)
const searchInput = ref('')
const query = ref('')
// 默认不筛来源:后端返回全部来源,前端按组渲染,用户可勾选只看某几个
const selectedSources = ref<string[]>([])
const installTarget = ref<'project' | 'global'>('project')
const installing = ref<Set<string>>(new Set())
const removing = ref<Set<string>>(new Set())

const cwd = computed(() => configStore.currentDirectory || '')

// ── 请求 ──────────────────────────────────────────────────
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function loadCatalog() {
  if (loading.value) return
  loading.value = true
  try {
    const params = new URLSearchParams({ type: props.type, cwd: cwd.value })
    if (query.value) params.set('q', query.value)
    if (selectedSources.value.length) params.set('sources', selectedSources.value.join(','))
    const res = await fetch(`/api/agent/marketplace/catalog?${params}`)
    const data = await res.json()
    if (data?.success) {
      groups.value = data.groups || []
      installed.value = data.installed || []
    } else {
      ElMessage.error(data?.error || $t('@MKT:加载失败'))
    }
  } catch {
    ElMessage.error($t('@MKT:加载失败'))
  } finally {
    loading.value = false
  }
}

watch(searchInput, value => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { query.value = value.trim(); loadCatalog() }, 400)
})

watch(selectedSources, () => loadCatalog())
watch(() => props.type, () => { selectedSources.value = []; query.value = ''; searchInput.value = ''; loadCatalog() })
watch(cwd, () => loadCatalog())
loadCatalog()

// ── 展示辅助 ──────────────────────────────────────────────
const targetLabel = computed(() => {
  const project = cwd.value ? cwd.value.split(/[\\/]/).filter(Boolean).pop() : ''
  return installTarget.value === 'project'
    ? (project || $t('@MKT:当前项目'))
    : $t('@MKT:g ai 智能体')
})

function metricText(item: MarketItem): string {
  if (item.stars) return `${formatCount(item.stars)} ★`
  if (item.downloads) return `${formatCount(item.downloads)} ${$t('@MKT:周下载')}`
  if (item.uses) return `${formatCount(item.uses)} ${$t('@MKT:次使用')}`
  return ''
}

function formatCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`
  return String(value)
}

function cardKey(item: MarketItem) {
  return `${item.id}`
}

function isBusy(item: MarketItem) {
  return installing.value.has(cardKey(item))
}

const installedByTarget = computed(() => {
  const map = { project: [] as InstalledItem[], global: [] as InstalledItem[] }
  for (const item of installed.value) (map[item.target] ||= []).push(item)
  return map
})

// ── 安装 / 卸载 ───────────────────────────────────────────
// MCP 的环境变量与参数用真正的 el-dialog 收集 —— 不要用 ElMessageBox +
// dangerouslyUseHTMLString 再去 query DOM 拿值:弹窗关闭动画之后 DOM 就没了,
// 那套写法属于"大多数时候能跑"的时序赌运气。
const configDialog = reactive({
  visible: false,
  item: null as MarketItem | null,
  env: {} as Record<string, string>,
  args: '',
})

function needsConfig(item: MarketItem) {
  return props.type === 'mcp' && (!!item.envKeys?.length || !!item.args?.length)
}

function openConfigDialog(item: MarketItem) {
  configDialog.item = item
  configDialog.env = Object.fromEntries((item.envKeys || []).map(key => [key, '']))
  configDialog.args = (item.args || []).join(' ')
  configDialog.visible = true
}

function confirmConfig() {
  const item = configDialog.item
  configDialog.visible = false
  if (!item) return
  const env = Object.fromEntries(
    Object.entries(configDialog.env).filter(([, value]) => value.trim() !== ''),
  )
  const args = configDialog.args.trim()
    ? configDialog.args.trim().match(/(?:[^\s"]+|"[^"]*")+/g)?.map(part => part.replace(/^"|"$/g, '')) ?? undefined
    : undefined
  void doInstall(item, { env, ...(args ? { args } : {}) })
}

async function onInstall(item: MarketItem) {
  if (item.installed && !await confirmReinstall(item)) return
  if (needsConfig(item)) {
    openConfigDialog(item)
    return
  }
  await doInstall(item, {})
}

async function doInstall(item: MarketItem, extra: { env?: Record<string, string>, args?: string[] }) {
  const key = cardKey(item)
  installing.value.add(key)
  try {
    const res = await fetch('/api/agent/marketplace/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: props.type, target: installTarget.value, cwd: cwd.value, item: { ...item, ...extra } }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.success) {
      ElMessage.error(data?.error || $t('@MKT:安装失败'))
      return
    }
    if (data.item?.warning) ElMessage.warning(data.item.warning)
    if (data.item?.envKeys?.length) {
      ElMessage.warning(`${$t('@MKT:还缺环境变量')}: ${data.item.envKeys.join(', ')}`)
    } else {
      ElMessage.success($t('@MKT:安装成功'))
    }
    await loadCatalog()
  } catch {
    ElMessage.error($t('@MKT:安装失败'))
  } finally {
    installing.value.delete(key)
  }
}

async function confirmReinstall(item: MarketItem) {
  try {
    await ElMessageBox.confirm(
      `${item.name} ${$t('@MKT:已安装，要重新安装吗？')}`,
      $t('@MKT:重新安装'),
      { confirmButtonText: $t('@MKT:重装'), cancelButtonText: $t('@MKT:取消'), type: 'warning' },
    )
    return true
  } catch {
    return false
  }
}

/** MCP 安装前的配置收集已改为 el-dialog(见 configDialog),不再走 DOM hack。 */

async function onRemove(item: InstalledItem) {
  try {
    await ElMessageBox.confirm(
      `${$t('@MKT:确定卸载')} ${item.name}？`,
      $t('@MKT:卸载'),
      { confirmButtonText: $t('@MKT:卸载'), cancelButtonText: $t('@MKT:取消'), type: 'warning' },
    )
  } catch {
    return
  }
  const key = `${item.target}:${item.id}`
  removing.value.add(key)
  try {
    const params = new URLSearchParams({ target: item.target, cwd: cwd.value })
    const res = await fetch(`/api/agent/marketplace/item/${props.type}/${encodeURIComponent(item.id)}?${params}`, { method: 'DELETE' })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.success) {
      ElMessage.error(data?.error || $t('@MKT:卸载失败'))
      return
    }
    ElMessage.success($t('@MKT:已卸载'))
    await loadCatalog()
  } catch {
    ElMessage.error($t('@MKT:卸载失败'))
  } finally {
    removing.value.delete(key)
  }
}
</script>

<template>
  <div class="marketplace-panel">
    <!-- ── 工具栏 ───────────────────────────────── -->
    <div class="mp-toolbar">
      <div class="mp-search">
        <el-icon class="mp-search-icon"><Search /></el-icon>
        <input
          v-model="searchInput"
          class="mp-search-input"
          type="text"
          :placeholder="type === 'skill' ? $t('@MKT:搜索 Skill...') : $t('@MKT:搜索 MCP 服务...')"
        />
      </div>

      <el-radio-group v-model="installTarget" size="small" class="mp-target">
        <el-radio-button value="project">{{ $t('@MKT:当前项目') }}</el-radio-button>
        <el-radio-button value="global">{{ $t('@MKT:g ai 智能体') }}</el-radio-button>
      </el-radio-group>

      <el-tooltip :content="$t('@MKT:刷新')" placement="top" :show-after="300">
        <button class="mp-refresh" :class="{ spinning: loading }" @click="loadCatalog">
          <el-icon><Refresh /></el-icon>
        </button>
      </el-tooltip>
    </div>

    <div class="mp-toolbar-sub">
      <span class="mp-target-hint">{{ $t('@MKT:安装到') }} <b>{{ targetLabel }}</b></span>
      <div class="mp-source-filter">
        <button
          v-for="group in groups"
          :key="group.id"
          class="mp-chip"
          :class="{ active: selectedSources.includes(group.id) }"
          @click="() => {
            const index = selectedSources.indexOf(group.id)
            if (index >= 0) selectedSources.splice(index, 1)
            else selectedSources.push(group.id)
          }"
        >{{ group.label }}</button>
        <button v-if="selectedSources.length" class="mp-chip clear" @click="selectedSources = []">
          {{ $t('@MKT:全部来源') }}
        </button>
      </div>
    </div>

    <!-- ── 内容 ─────────────────────────────────── -->
    <div class="mp-body" v-loading="loading">
      <section v-for="group in groups" :key="group.id" class="mp-group">
        <header class="mp-group-header">
          <h3 class="mp-group-title">{{ group.label }}</h3>
          <span v-if="group.status === 'ok'" class="mp-group-count">{{ group.items.length }}</span>
          <span v-else class="mp-group-error">
            <el-icon><Warning /></el-icon>
            {{ group.error || $t('@MKT:来源不可用') }}
          </span>
          <a
            v-if="group.homepage"
            class="mp-group-link"
            :href="group.homepage"
            target="_blank"
            rel="noopener noreferrer"
            :title="group.homepage"
          >
            <el-icon><Link /></el-icon>
          </a>
        </header>

        <div v-if="group.status === 'ok' && group.items.length" class="mp-grid">
          <article v-for="item in group.items" :key="cardKey(item)" class="mp-card">
            <div class="mp-card-head">
              <span class="mp-card-name" :title="item.name">{{ item.name }}</span>
              <span v-if="metricText(item)" class="mp-card-metric">
                <el-icon><Star v-if="item.stars" /><Download v-else /></el-icon>
                {{ metricText(item) }}
              </span>
            </div>

            <p class="mp-card-desc" :title="item.description">{{ item.description || $t('@MKT:暂无描述') }}</p>

            <div class="mp-card-meta">
              <code v-if="item.package" class="mp-meta-pkg" :title="item.package">{{ item.package }}</code>
              <span v-else-if="item.repository" class="mp-meta-repo" :title="item.repository + (item.subpath ? ' · ' + item.subpath : '')">
                {{ item.repository }}<template v-if="item.subpath"> · {{ item.subpath }}</template>
              </span>
              <span v-if="item.transport === 'remote'" class="mp-tag remote">{{ $t('@MKT:远程服务') }}</span>
              <span v-for="tag in (item.tags || []).slice(0, 2)" :key="tag" class="mp-tag">{{ tag }}</span>
            </div>

            <div class="mp-card-foot">
              <a
                v-if="item.upstream"
                class="mp-card-link"
                :href="item.upstream"
                target="_blank"
                rel="noopener noreferrer"
              >{{ $t('@MKT:查看来源') }}</a>
              <span class="mp-foot-spacer" />
              <span v-if="item.installed" class="mp-installed-chip">
                <el-icon><Check /></el-icon>{{ $t('@MKT:已安装') }}
              </span>
              <button
                v-else-if="item.installable !== false"
                class="mp-install-btn"
                :disabled="isBusy(item)"
                @click="onInstall(item)"
              >{{ isBusy(item) ? $t('@MKT:安装中...') : $t('@MKT:安装') }}</button>
              <span v-else class="mp-not-installable">{{ $t('@MKT:暂不支持一键安装') }}</span>
            </div>
          </article>
        </div>

        <div v-else-if="group.status === 'ok'" class="mp-empty">{{ $t('@MKT:该来源暂无结果') }}</div>
      </section>

      <!-- ── 已安装 ─────────────────────────────── -->
      <section v-if="installed.length" class="mp-group installed">
        <header class="mp-group-header">
          <h3 class="mp-group-title">{{ $t('@MKT:已安装') }}</h3>
          <span class="mp-group-count">{{ installed.length }}</span>
        </header>

        <div v-for="target in (['project', 'global'] as const)" :key="target">
          <div v-if="installedByTarget[target]?.length" class="mp-installed-block">
            <div class="mp-installed-target">
              {{ target === 'project' ? $t('@MKT:当前项目') : $t('@MKT:g ai 智能体') }}
            </div>
            <div class="mp-installed-list">
              <div v-for="item in installedByTarget[target]" :key="target + item.id" class="mp-installed-row">
                <span class="mp-installed-name">{{ item.name }}</span>
                <code v-if="item.package" class="mp-meta-pkg">{{ item.package }}</code>
                <span v-if="item.requiredEnv?.length" class="mp-tag warn">{{ $t('@MKT:待配置') }}: {{ item.requiredEnv.join(', ') }}</span>
                <span class="mp-foot-spacer" />
                <button
                  class="mp-remove-btn"
                  :disabled="removing.has(target + item.id)"
                  @click="onRemove(item)"
                >
                  <el-icon><Delete /></el-icon>
                  {{ removing.has(target + item.id) ? $t('@MKT:卸载中...') : $t('@MKT:卸载') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div v-if="!loading && !groups.length" class="mp-empty all">{{ $t('@MKT:加载失败') }}</div>
    </div>

    <!-- ── MCP 安装前配置 ───────────────────────── -->
    <el-dialog
      v-model="configDialog.visible"
      :title="$t('@MKT:配置 MCP')"
      width="460px"
      :close-on-click-modal="false"
      append-to-body
    >
      <div v-if="configDialog.item" class="mkt-form">
        <p class="mkt-form-name">{{ configDialog.item.name }}</p>
        <div v-for="key in Object.keys(configDialog.env)" :key="key" class="mkt-field">
          <label>{{ key }}</label>
          <input
            v-model="configDialog.env[key]"
            type="text"
            autocomplete="off"
            :placeholder="$t('@MKT:环境变量值')"
            spellcheck="false"
          />
        </div>
        <div v-if="configDialog.item.args?.length" class="mkt-field">
          <label>{{ $t('@MKT:启动参数') }}</label>
          <input v-model="configDialog.args" type="text" autocomplete="off" spellcheck="false" />
          <p class="mkt-hint">{{ $t('@MKT:参数提示') }}</p>
        </div>
      </div>
      <template #footer>
        <button class="mkt-cancel" @click="configDialog.visible = false">{{ $t('@MKT:取消') }}</button>
        <button class="mkt-confirm" @click="confirmConfig">{{ $t('@MKT:安装') }}</button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped lang="scss">
.marketplace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-container);
}

/* ── 工具栏 ─────────────────────────────────── */
.mp-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px 8px;
  flex-shrink: 0;
}

.mp-search {
  flex: 1;
  max-width: 420px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  height: 32px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  transition: border-color 0.15s ease;

  &:focus-within { border-color: var(--color-primary); }

  .mp-search-icon { color: var(--text-tertiary); flex-shrink: 0; }

  .mp-search-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    outline: none;

    &::placeholder { color: var(--text-tertiary); }
  }
}

.mp-target { flex-shrink: 0; }

.mp-refresh {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover { color: var(--color-primary); border-color: var(--color-primary); }

  &.spinning svg { animation: mkt-spin 0.9s linear infinite; }
}

@keyframes mkt-spin {
  to { transform: rotate(360deg); }
}

.mp-toolbar-sub {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px 10px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.mp-target-hint {
  font-size: 12px;
  color: var(--text-tertiary);

  b { color: var(--color-primary); font-weight: 600; }
}

.mp-source-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.mp-chip {
  padding: 2px 10px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover { color: var(--text-secondary); border-color: var(--text-tertiary); }

  &.active {
    color: var(--color-primary);
    border-color: var(--color-primary);
    background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  }

  &.clear {
    border-style: dashed;
    color: var(--text-tertiary);
  }
}

/* ── 内容区 ─────────────────────────────────── */
.mp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 20px;
}

.mp-group {
  margin-bottom: 20px;

  &.installed {
    padding-top: 14px;
    border-top: 1px dashed var(--border-color);
  }
}

.mp-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.mp-group-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.mp-group-count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

.mp-group-error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--color-warning);
}

.mp-group-link {
  display: inline-flex;
  color: var(--text-tertiary);
  transition: color 0.15s ease;

  &:hover { color: var(--color-primary); }
}

/* ── 卡片网格 ───────────────────────────────── */
.mp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
}

.mp-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--color-primary) 40%, var(--border-color));
    box-shadow: var(--shadow-sm);
  }
}

.mp-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mp-card-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mp-card-metric {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.mp-card-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}

.mp-card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-height: 18px;
}

.mp-meta-pkg,
.mp-meta-repo {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.mp-tag {
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
  flex-shrink: 0;

  &.remote {
    background: color-mix(in srgb, var(--color-info, #06b6d4) 14%, transparent);
    color: var(--color-info, #06b6d4);
  }

  &.warn {
    background: color-mix(in srgb, var(--color-warning) 14%, transparent);
    color: var(--color-warning);
  }
}

.mp-card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.mp-card-link {
  font-size: 11px;
  color: var(--text-tertiary);
  text-decoration: none;

  &:hover { color: var(--color-primary); text-decoration: underline; }
}

.mp-foot-spacer { flex: 1; }

.mp-install-btn {
  padding: 4px 14px;
  font-size: 12px;
  font-family: inherit;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover:not(:disabled) {
    background: var(--color-primary);
    color: #fff;
  }

  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.mp-installed-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--color-success, #34d399);
}

.mp-not-installable {
  font-size: 11px;
  color: var(--text-tertiary);
}

.mp-empty {
  padding: 16px 0;
  font-size: 12px;
  color: var(--text-tertiary);

  &.all { text-align: center; padding: 48px 0; }
}

/* ── 已安装列表 ─────────────────────────────── */
.mp-installed-block { margin-bottom: 12px; }

.mp-installed-target {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.mp-installed-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mp-installed-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}

.mp-installed-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mp-remove-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover:not(:disabled) {
    color: var(--color-danger);
    border-color: var(--color-danger);
  }

  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

@media (prefers-reduced-motion: reduce) {
  .mp-refresh.spinning svg { animation: none; }
}

/* ── MCP 配置弹窗 ───────────────────────────── */
.mkt-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mkt-form-name {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.mkt-field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  input {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-container);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    transition: border-color 0.15s ease;

    &:focus { outline: none; border-color: var(--color-primary); }
  }
}

.mkt-hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-tertiary);
}

.mkt-cancel,
.mkt-confirm {
  padding: 6px 16px;
  font-size: 13px;
  font-family: inherit;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}

.mkt-cancel {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  margin-right: 8px;

  &:hover { color: var(--text-primary); border-color: var(--text-tertiary); }
}

.mkt-confirm {
  border: 1px solid var(--color-primary);
  background: var(--color-primary);
  color: #fff;

  &:hover { opacity: 0.9; }
}
</style>
