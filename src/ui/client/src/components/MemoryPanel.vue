<!--
  MemoryPanel.vue
  设置 → 记忆库：浏览跨轮经验、展开看正文、单条 / 批量删除。

  数据全部走 REST，进入 tab 时拉一次，之后点刷新 / 切范围 / 删除后再拉
  （与 ExecutionLogManager 同一口径：无轮询、无 SSE —— 记忆条目是低频变更的，
  挂个 5 秒轮询只会白烧 CPU）。

  ⚠️ 界面上**不暴露绝对路径**，只有 scope + 文件名；删除请求也只传这两个
  （见 src/ui/server/routes/memory.js 头注释：路径由服务端重拼）。
  仓库路径是从项目 INDEX.md 头里读出来给人认的，不是秘密，但也不该出现在删除参数里。
-->
<template>
  <div class="mem-panel">
    <!-- 头部：统计 + 刷新 -->
    <header class="mem-panel__head">
      <div class="mem-panel__title-block">
        <span class="mem-panel__stats">
          {{ $t('@42BB9:共 {count} 条经验', { count: totalCount }) }}
        </span>
        <span v-if="orphanCount > 0" class="mem-panel__stat-warn">
          {{ $t('@42BB9:{count} 条没有索引（Agent 查不到）', { count: orphanCount }) }}
        </span>
      </div>
      <div class="mem-panel__head-actions">
        <el-button :icon="Refresh" size="small" :loading="loading" @click="reload">
          {{ $t('@42BB9:刷新') }}
        </el-button>
      </div>
    </header>

    <!-- 范围切换：全局两篇 + 每个项目 -->
    <div class="mem-panel__scope">
      <el-select
        v-model="currentScope"
        size="small"
        class="mem-panel__scope-select"
        :placeholder="$t('@42BB9:全部')"
        :loading="scopesLoading"
        @change="onScopeChange"
      >
        <el-option
          v-for="s in scopes"
          :key="s.scope"
          :label="scopeLabel(s)"
          :value="s.scope"
        >
          <span class="mem-panel__scope-option">
            <span class="mem-panel__scope-name">{{ scopeLabel(s) }}</span>
            <span class="mem-panel__scope-count">{{ s.count }}</span>
          </span>
        </el-option>
      </el-select>
      <span class="mem-panel__scope-path" :title="currentRepoPath">{{ currentRepoPath || currentScope }}</span>
    </div>

    <!-- 批量操作条 -->
    <div v-if="selectedKeys.size > 0" class="mem-panel__batch">
      <el-checkbox
        :model-value="isAllSelected"
        :indeterminate="isSomeSelected"
        @change="toggleSelectAll"
      >
        {{ isAllSelected ? $t('@42BB9:取消全选') : $t('@42BB9:全选') }}
      </el-checkbox>
      <span class="mem-panel__batch-meta">
        {{ $t('@42BB9:已选择 {count} 项', { count: selectedKeys.size }) }}
      </span>
      <el-button type="danger" size="small" @click="batchDelete">
        {{ $t('@42BB9:批量删除') }}
      </el-button>
    </div>

    <!-- 列表 -->
    <div v-loading="loading" class="mem-panel__list">
      <!-- 未初始化：这是合法状态（用户还没开过工作台），给一句人话而不是报错 -->
      <div v-if="!loading && !available" class="mem-panel__empty">
        <div class="mem-panel__empty-art" aria-hidden="true"><el-icon><FolderOpened /></el-icon></div>
        <div class="mem-panel__empty-title">{{ $t('@42BB9:记忆库尚未初始化') }}</div>
        <div class="mem-panel__empty-hint">
          {{ $t('@42BB9:启动一次工作台即会自动创建记忆库目录。') }}
        </div>
      </div>

      <div v-else-if="!loading && entries.length === 0" class="mem-panel__empty">
        <div class="mem-panel__empty-art" aria-hidden="true"><el-icon><Document /></el-icon></div>
        <div class="mem-panel__empty-title">{{ $t('@42BB9:这里还没有经验') }}</div>
        <div class="mem-panel__empty-hint">
          {{ $t('@42BB9:智能体在派发任务收尾时自检四问，命中才会记一条。') }}
        </div>
      </div>

      <article
        v-for="e in entries"
        :key="e.file"
        class="mem-card"
        :class="{ 'is-selected': selectedKeys.has(e.file), 'is-open': expanded === e.file }"
      >
        <el-checkbox
          class="mem-card__check"
          :model-value="selectedKeys.has(e.file)"
          :disabled="!deletable"
          @change="(v: any) => toggleSelect(e.file, v)"
        />
        <div class="mem-card__main">
          <button
            type="button"
            class="mem-card__head"
            :aria-expanded="expanded === e.file"
            @click="toggleExpand(e.file)"
          >
            <span class="mem-card__title">{{ e.title }}</span>
            <span v-if="!e.indexed" class="mem-card__badge mem-card__badge--warn">
              {{ $t('@42BB9:未索引') }}
            </span>
            <span class="mem-card__spacer" />
            <span class="mem-card__meta">{{ formatSize(e.size) }} · {{ formatTime(e.mtime) }}</span>
          </button>

          <!-- 展开：正文。原始 markdown 而非渲染后 —— 用户多半是照着去改文件，
               给渲染结果等于把"可以照抄的原文"藏起来。 -->
          <div v-if="expanded === e.file" v-loading="bodyLoading" class="mem-card__body">
            <pre v-if="bodyCache[e.file]" class="mem-card__text">{{ bodyCache[e.file] }}</pre>
            <div v-else-if="bodyError" class="mem-card__body-error">{{ bodyError }}</div>
          </div>
        </div>
        <div class="mem-card__actions">
          <el-button
            v-if="deletable"
            type="danger"
            plain
            size="small"
            :icon="Delete"
            @click="removeOne(e)"
          >
            {{ $t('@42BB9:删除') }}
          </el-button>
        </div>
      </article>
    </div>

    <p class="mem-panel__foot">
      {{ $t('@42BB9:记忆库位于 ~/.zen-gitsync/memory/，只有索引会进智能体的上下文，正文按需读取。') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Document, FolderOpened, Refresh } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'

/** 一条经验的最小形状（对齐 src/memory/library.js 的 listEntries 返回） */
interface MemoryEntry {
  file: string
  title: string
  size: number
  mtime: number
  indexed: boolean
  summary: string
}

interface MemoryScope {
  scope: string
  label: string
  repoPath: string
  count: number
  mtime: number
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── 状态 ────────────────────────────────────────────────────────────
const available = ref(true)
const scopes = ref<MemoryScope[]>([])
const scopesLoading = ref(false)
const currentScope = ref('')
const entries = ref<MemoryEntry[]>([])
const loading = ref(false)
/** key 用 `${scope}/${file}`，切范围时选中项才不会串到别的项目去 */
const selectedKeys = ref<Set<string>>(new Set())
const expanded = ref('')
const bodyCache = ref<Record<string, string>>({})
const bodyLoading = ref(false)
const bodyError = ref('')

/** 全局两篇是索引/规范本身，删了整套记忆失去记账口径 —— 隐藏删除按钮而不是点了再报错 */
const deletable = computed(() => currentScope.value !== 'global' && currentScope.value !== 'global-index')
const currentRepoPath = computed(() => scopes.value.find(s => s.scope === currentScope.value)?.repoPath || '')
const totalCount = computed(() => scopes.value.reduce((n, s) => n + s.count, 0))
const orphanCount = computed(() => entries.value.filter(e => !e.indexed).length)

const keyOf = (file: string) => `${currentScope.value}/${file}`

const isAllSelected = computed(() =>
  entries.value.length > 0 && entries.value.every(e => selectedKeys.value.has(keyOf(e.file)))
)
const isSomeSelected = computed(() =>
  entries.value.some(e => selectedKeys.value.has(keyOf(e.file))) && !isAllSelected.value
)

function scopeLabel(s: MemoryScope): string {
  if (s.scope === 'global') return $t('@42BB9:全局经验 (GLOBAL.md)')
  if (s.scope === 'global-index') return $t('@42BB9:全局索引 (INDEX.md)')
  const name = s.repoPath || s.label
  const short = name.split(/[\\/]/).filter(Boolean).pop() || name
  return `${short}  ·  ${s.count}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── 数据加载 ────────────────────────────────────────────────────────
async function loadScopes() {
  scopesLoading.value = true
  try {
    const res = await fetch('/api/memory/scopes').then(r => r.json())
    if (!res.success) throw new Error(res.error || 'scopes failed')
    available.value = res.available !== false
    scopes.value = res.scopes || []
    // 当前 scope 可能在别处被删过 → 落到第一个还存在的上
    if (!scopes.value.some(s => s.scope === currentScope.value)) {
      currentScope.value = scopes.value[0]?.scope || ''
    }
  } catch (err) {
    ElMessage.error($t('@42BB9:读取记忆库失败') + ': ' + errMsg(err))
  } finally {
    scopesLoading.value = false
  }
}

async function loadEntries() {
  if (!currentScope.value) { entries.value = []; return }
  loading.value = true
  bodyError.value = ''
  try {
    const res = await fetch(
      `/api/memory/entries?scope=${encodeURIComponent(currentScope.value)}`
    ).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'entries failed')
    entries.value = res.entries || []
    // 清掉已不在当前列表里的选中项（切范围后别拿旧项目的勾去删新项目的文件）
    const alive = new Set(entries.value.map(e => keyOf(e.file)))
    for (const k of Array.from(selectedKeys.value)) {
      if (!alive.has(k)) selectedKeys.value.delete(k)
    }
    selectedKeys.value = new Set(selectedKeys.value)
    if (expanded.value && !entries.value.some(e => e.file === expanded.value)) {
      expanded.value = ''
    }
  } catch (err) {
    entries.value = []
    ElMessage.error($t('@42BB9:读取条目失败') + ': ' + errMsg(err))
  } finally {
    loading.value = false
  }
}

async function reload() {
  await loadScopes()
  await loadEntries()
}

function onScopeChange() {
  expanded.value = ''
  bodyError.value = ''
  loadEntries()
}

// ── 展开看正文 ──────────────────────────────────────────────────────
async function toggleExpand(file: string) {
  if (expanded.value === file) { expanded.value = ''; return }
  expanded.value = file
  bodyError.value = ''
  if (bodyCache.value[file]) return          // 展开过就不重复拉
  bodyLoading.value = true
  try {
    const params = new URLSearchParams({ scope: currentScope.value, file })
    const res = await fetch(`/api/memory/entry?${params.toString()}`).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'read failed')
    bodyCache.value = { ...bodyCache.value, [file]: res.content }
  } catch (err) {
    bodyError.value = errMsg(err)
  } finally {
    bodyLoading.value = false
  }
}

// ── 选中 ────────────────────────────────────────────────────────────
function toggleSelect(file: string, checked: any) {
  const k = keyOf(file)
  if (checked) selectedKeys.value.add(k)
  else selectedKeys.value.delete(k)
  // Set 的 add/delete 本身 Vue 追踪不到，整体替换一次才触发重渲染
  selectedKeys.value = new Set(selectedKeys.value)
}

function toggleSelectAll(checked: any) {
  if (checked) for (const e of entries.value) selectedKeys.value.add(keyOf(e.file))
  else for (const e of entries.value) selectedKeys.value.delete(keyOf(e.file))
  selectedKeys.value = new Set(selectedKeys.value)
}

// ── 删除 ────────────────────────────────────────────────────────────
async function removeOne(entry: MemoryEntry) {
  try {
    await ElMessageBox.confirm(
      $t('@42BB9:确定要删除「{title}」吗？它会同时从索引里移除。', { title: entry.title }),
      $t('@42BB9:删除经验'),
      { type: 'warning', confirmButtonText: $t('@42BB9:删除') }
    )
  } catch { return }                          // 取消 = reject，静默返回
  await doDelete([{ scope: currentScope.value, file: entry.file }])
}

async function batchDelete() {
  const items = entries.value
    .filter(e => selectedKeys.value.has(keyOf(e.file)))
    .map(e => ({ scope: currentScope.value, file: e.file }))
  if (items.length === 0) return
  try {
    await ElMessageBox.confirm(
      $t('@42BB9:确定要删除所选的 {count} 条经验吗？此操作不可恢复。', { count: items.length }),
      $t('@42BB9:批量删除'),
      { type: 'warning' }
    )
  } catch { return }
  await doDelete(items)
}

async function doDelete(items: { scope: string; file: string }[]) {
  try {
    const res = await fetch('/api/memory/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, confirm: true }),
    }).then(r => r.json())
    if (!res.success) throw new Error(res.error || 'delete failed')
    ElMessage.success($t('@42BB9:已删除 {count} 条', { count: res.removed }))
    if (res.failed?.length) {
      ElMessage.warning($t('@42BB9:{count} 条删除失败', { count: res.failed.length }))
    }
    selectedKeys.value = new Set()
    // 缓存里被删掉的那份正文留着就等于"删了还能在展开里看到"
    for (const it of items) delete bodyCache.value[it.file]
    bodyCache.value = { ...bodyCache.value }
    expanded.value = ''
    await reload()
  } catch (err) {
    ElMessage.error($t('@42BB9:删除失败') + ': ' + errMsg(err))
  }
}

// ── 启动 ────────────────────────────────────────────────────────────
onMounted(reload)

defineExpose({ reload })
</script>

<style scoped>
.mem-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm, 8px);
  height: 100%;
  min-height: 0;
}
.mem-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.mem-panel__title-block { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mem-panel__stats {
  font-size: var(--font-size-sm);
  /* 承载信息的文字用 --text-meta/secondary，不用装饰档的 --text-tertiary（不达 AA） */
  color: var(--text-secondary, var(--text-meta, #686a6f));
  font-variant-numeric: tabular-nums;
}
.mem-panel__stat-warn {
  font-size: var(--font-size-sm);
  /* 唯一允许用色的地方：这里确实是一种"状态"（有经验查不到） */
  color: var(--color-warning-dark);
  font-variant-numeric: tabular-nums;
}
.mem-panel__scope { display: flex; align-items: center; gap: 8px; }
.mem-panel__scope-select { width: 260px; }
.mem-panel__scope-path {
  font-size: var(--font-size-sm);
  color: var(--text-meta, #686a6f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.mem-panel__scope-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mem-panel__scope-count { color: var(--text-meta); font-variant-numeric: tabular-nums; }
.mem-panel__batch {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: color-mix(in srgb, var(--color-primary) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary) 25%, transparent);
  border-radius: var(--radius-md, 6px);
}
.mem-panel__batch-meta {
  font-size: var(--font-size-sm);
  color: var(--text-secondary, var(--text-meta, #686a6f));
  font-variant-numeric: tabular-nums;
}
.mem-panel__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 160px;
  overflow-y: auto;
}
.mem-panel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md, 6px);
}
.mem-panel__empty-art { font-size: 36px; opacity: 0.5; margin-bottom: 8px; }
.mem-panel__empty-title { font-size: var(--font-size-base); color: var(--text-secondary); }
.mem-panel__empty-hint {
  margin-top: 4px;
  font-size: var(--font-size-sm);
  color: var(--text-meta, #686a6f);
  text-align: center;
}
.mem-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-subtle, var(--bg-container));
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
}
.mem-card.is-selected { border-color: color-mix(in srgb, var(--color-primary) 45%, transparent); }
.mem-card.is-open { flex-direction: column; }
.mem-card__check { margin-top: 2px; }
.mem-card__main { flex: 1; min-width: 0; }
.mem-card__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}
.mem-card__head:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: 3px; }
.mem-card__title {
  font-size: var(--font-size-base);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.mem-card__spacer { flex: 1; }
.mem-card__meta {
  font-size: var(--font-size-sm);
  color: var(--text-meta, #686a6f);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.mem-card__badge {
  font-size: var(--font-size-xs, 11px);
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
}
.mem-card__badge--warn {
  color: var(--color-warning-dark);
  border: 1px solid color-mix(in srgb, var(--el-color-warning, #e6a23c) 45%, transparent);
}
.mem-card__actions { flex-shrink: 0; }
.mem-card__body { margin-top: 10px; }
.mem-card__text {
  margin: 0;
  padding: 12px 14px;
  max-height: 320px;
  overflow: auto;
  font-size: var(--font-size-sm);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 6px);
}
.mem-card__body-error { font-size: var(--font-size-sm); color: var(--color-danger-dark); }
.mem-panel__foot {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-meta, #686a6f);
  line-height: 1.6;
}
</style>
