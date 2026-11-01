<template>
  <div class="peer-panel">
    <!-- ── 本机节点 ─────────────────────────────────────────────── -->
    <section class="peer-sec">
      <div class="peer-sec-head">
        <h3>{{ $t('@PEER:本机节点') }}</h3>
        <span class="peer-id">{{ self.id }}</span>
        <span class="peer-run" :class="running ? 'is-on' : 'is-off'">
          {{ running ? $t('@PEER:运行中') : $t('@PEER:已停止') }}
        </span>
      </div>

      <div class="peer-form">
        <label class="peer-label">{{ $t('@PEER:昵称') }}</label>
        <input v-model="self.name" class="peer-input" maxlength="40" :placeholder="$t('@PEER:这台电脑叫什么')" />

        <label class="peer-label">{{ $t('@PEER:头像') }}</label>
        <input v-model="self.avatar" class="peer-input" maxlength="200" :placeholder="$t('@PEER:emoji 或图片地址，可留空')" />

        <label class="peer-label">{{ $t('@PEER:端口') }}</label>
        <input v-model.number="self.port" type="number" min="1" max="65535" class="peer-input peer-input--num" />

        <label class="peer-label">{{ $t('@PEER:允许其他机器提问') }}</label>
        <div class="peer-switch">
          <el-switch v-model="self.enabled" />
          <span class="peer-hint-inline">{{ self.enabled ? $t('@PEER:已开启') : $t('@PEER:已关闭') }}</span>
        </div>
      </div>

      <div class="peer-token">
        <span class="peer-label">{{ $t('@PEER:令牌') }}</span>
        <code class="peer-token-value" :title="self.token">{{ self.token || '—' }}</code>
        <button class="peer-btn" type="button" @click="copyToken">{{ $t('@PEER:复制') }}</button>
        <button class="peer-btn peer-btn--warn" type="button" @click="rotateToken">{{ $t('@PEER:重置') }}</button>
      </div>

      <p class="peer-hint">
        {{ $t('@PEER:把地址和令牌给对方，对方就能问你。改完即刻生效，不需要重启。') }}
      </p>

      <div class="peer-actions">
        <button class="peer-btn peer-btn--primary" type="button" :disabled="savingSelf" @click="saveSelf">
          {{ savingSelf ? $t('@PEER:保存中…') : $t('@PEER:保存') }}
        </button>
        <span v-if="savedAt" class="peer-saved">{{ $t('@PEER:已保存') }}</span>
      </div>
    </section>

    <!-- ── 对端清单 ─────────────────────────────────────────────── -->
    <section class="peer-sec">
      <div class="peer-sec-head">
        <h3>{{ $t('@PEER:对端') }}</h3>
        <button class="peer-btn peer-btn--ghost" type="button" :disabled="loading" @click="load">
          {{ $t('@PEER:刷新') }}
        </button>
      </div>

      <div v-if="!peers.length" class="peer-empty">
        {{ $t('@PEER:还没有对端。在另一台机器上打开本页，把这边的地址和令牌填进去即可。') }}
      </div>

      <ul v-else class="peer-list">
        <li v-for="p in peers" :key="p.id || p.url" class="peer-row">
          <span class="peer-dot" :class="p.online ? 'is-on' : 'is-off'" :title="p.online ? $t('@PEER:在线') : $t('@PEER:离线')" />
          <span class="peer-row-name">{{ p.name }}</span>
          <span class="peer-row-url">{{ p.url }}</span>
          <span class="peer-row-ver">{{ p.online ? p.version : (p.error || $t('@PEER:离线')) }}</span>
          <button class="peer-btn peer-btn--ghost" type="button" @click="testPeer(p)">{{ $t('@PEER:测试') }}</button>
          <button class="peer-btn peer-btn--danger" type="button" @click="removePeer(p)">{{ $t('@PEER:删除') }}</button>
        </li>
      </ul>
    </section>

    <!-- ── 添加对端 ─────────────────────────────────────────────── -->
    <section class="peer-sec">
      <div class="peer-sec-head">
        <h3>{{ $t('@PEER:添加对端') }}</h3>
      </div>
      <div class="peer-form">
        <label class="peer-label">{{ $t('@PEER:昵称') }}</label>
        <input v-model="draft.name" class="peer-input" maxlength="40" :placeholder="$t('@PEER:比如：服务器')" />

        <label class="peer-label">{{ $t('@PEER:地址') }}</label>
        <input v-model="draft.url" class="peer-input" :placeholder="`http://192.168.1.20:${defaultPort}`" />

        <label class="peer-label">{{ $t('@PEER:令牌') }}</label>
        <input v-model="draft.token" class="peer-input" :placeholder="$t('@PEER:对方「本机节点」里那串令牌')" />
      </div>
      <div class="peer-actions">
        <button class="peer-btn peer-btn--primary" type="button" :disabled="adding" @click="addPeer">
          {{ adding ? $t('@PEER:连接中…') : $t('@PEER:添加并测试') }}
        </button>
        <span class="peer-hint-inline">{{ $t('@PEER:会先真连一次，连不上会当场报错。') }}</span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
// 跨机器设置面板：本机身份（昵称/头像/端口/开关/令牌）+ 对端清单。
//
// 为什么放在设置弹窗里而不是新开一个页面：这是"一次配好、长期不管"的东西，
// 与 AI 模型、Git 全局设置同一类；跨机器问答本身在对话框里，不需要单独入口。
//
// 数据来源是 /api/peer-settings（本机主服务），**不是** peer 端口那套带令牌的接口
// —— 那套是给别的机器用的，这套只给本机界面用。
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { $t } from '@/lang/static'

interface SelfInfo {
  id: string
  name: string
  avatar: string
  port: number
  host: string
  enabled: boolean
  token: string
}

interface PeerRow {
  id: string
  name: string
  url: string
  online: boolean
  version?: string
  error?: string
}

const self = reactive<SelfInfo>({ id: '', name: '', avatar: '', port: 5600, host: '0.0.0.0', enabled: false, token: '' })
const peers = ref<PeerRow[]>([])
const defaultPort = ref(5600)
const draft = reactive({ name: '', url: '', token: '' })

const loading = ref(false)
const savingSelf = ref(false)
const adding = ref(false)
const savedAt = ref(0)
const running = ref(false)

async function readJson(res: Response) {
  const data = await res.json().catch(() => null)
  if (!res.ok || !data || data.success === false) {
    throw new Error(data?.error || `HTTP ${res.status}`)
  }
  return data
}

async function load() {
  loading.value = true
  try {
    const data = await readJson(await fetch('/api/peer-settings'))
    Object.assign(self, data.self)
    running.value = data.running === true
    peers.value = data.peers || []
  } catch (err: any) {
    ElMessage.error($t('@PEER:读取跨机器设置失败：{msg}', { msg: err?.message || err }))
  } finally {
    loading.value = false
  }
}

async function saveSelf() {
  savingSelf.value = true
  try {
    const data = await readJson(await fetch('/api/peer-settings/self', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: self.name, avatar: self.avatar, port: self.port, enabled: self.enabled })
    }))
    Object.assign(self, data.self)
    running.value = data.running === true
    savedAt.value = Date.now()
    ElMessage.success($t('@PEER:设置已保存'))
  } catch (err: any) {
    ElMessage.error(String(err?.message || err))
  } finally {
    savingSelf.value = false
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(self.token)
    ElMessage.success($t('@PEER:令牌已复制'))
  } catch {
    ElMessage.warning($t('@PEER:复制失败，请手动选中那串令牌'))
  }
}

async function rotateToken() {
  try {
    await ElMessageBox.confirm(
      $t('@PEER:重置后旧令牌立即失效，已经配对过的机器都要重新填。确定重置？'),
      $t('@PEER:重置令牌'),
      { type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const data = await readJson(await fetch('/api/peer-settings/token', { method: 'POST' }))
    Object.assign(self, data.self)
    running.value = data.running === true
    ElMessage.success($t('@PEER:令牌已重置'))
  } catch (err: any) {
    ElMessage.error(String(err?.message || err))
  }
}

async function addPeer() {
  if (!draft.name.trim() || !draft.url.trim() || !draft.token.trim()) {
    ElMessage.warning($t('@PEER:昵称、地址、令牌都要填'))
    return
  }
  adding.value = true
  try {
    const data = await readJson(await fetch('/api/peer-settings/peers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: draft.name.trim(), url: draft.url.trim(), token: draft.token.trim() })
    }))
    ElMessage.success($t('@PEER:已连上「{name}」', { name: data.peer?.name || draft.name }))
    draft.name = ''
    draft.url = ''
    draft.token = ''
    await load()
  } catch (err: any) {
    ElMessage.error(String(err?.message || err))
  } finally {
    adding.value = false
  }
}

async function testPeer(p: PeerRow) {
  try {
    const data = await readJson(await fetch(`/api/peer-settings/peers/${encodeURIComponent(p.id || p.name)}/test`, { method: 'POST' }))
    p.online = data.online
    p.version = data.version || ''
    p.error = data.error || ''
    if (data.online) ElMessage.success($t('@PEER:「{name}」在线', { name: p.name }))
    else ElMessage.error($t('@PEER:「{name}」连不上：{msg}', { name: p.name, msg: data.error || $t('@PEER:离线') }))
  } catch (err: any) {
    ElMessage.error(String(err?.message || err))
  }
}

async function removePeer(p: PeerRow) {
  try {
    await ElMessageBox.confirm($t('@PEER:移除「{name}」？', { name: p.name }), $t('@PEER:移除对端'), { type: 'warning' })
  } catch {
    return
  }
  try {
    await readJson(await fetch(`/api/peer-settings/peers/${encodeURIComponent(p.id || p.name)}`, { method: 'DELETE' }))
    ElMessage.success($t('@PEER:已移除'))
    await load()
  } catch (err: any) {
    ElMessage.error(String(err?.message || err))
  }
}

onMounted(async () => {
  try {
    const data = await readJson(await fetch('/api/peer-settings/defaults'))
    defaultPort.value = data.port || 5600
    if (!self.port) self.port = defaultPort.value
  } catch { /* 老服务端没有这个端点就按默认值显示 */ }
  await load()
})
</script>

<style scoped>
/* 平铺分区 + 分隔线，不做"圆角 + 单层边框"的卡片（用户明确不喜欢那种观感） */
.peer-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 2px 12px;
  color: var(--text-primary);
}

.peer-sec {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.peer-sec:last-child {
  border-bottom: none;
}

.peer-sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.peer-sec-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.peer-run {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.peer-run.is-on {
  color: var(--role-done-ink, #3f9d5a);
}

.peer-id {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary);
}

.peer-form {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 8px 12px;
  align-items: center;
  max-width: 640px;
}

.peer-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.peer-input {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  outline: none;
}

.peer-input:focus {
  border-color: var(--role-active-edge, var(--border-color));
}

.peer-input--num {
  max-width: 120px;
}

.peer-switch {
  display: flex;
  align-items: center;
  gap: 8px;
}

.peer-token {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  max-width: 640px;
}

.peer-token-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 5px 8px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  background: var(--bg-input);
  border-radius: 4px;
  color: var(--text-secondary);
}

.peer-hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.peer-hint-inline {
  font-size: 11px;
  color: var(--text-secondary);
}

.peer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.peer-saved {
  font-size: 11px;
  color: var(--role-done-ink, var(--text-secondary));
}

.peer-empty {
  padding: 10px 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.peer-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 平铺行 + hover 底色（不是卡片） */
.peer-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.peer-row:hover {
  background: var(--bg-hover);
}

.peer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.peer-dot.is-on {
  background: var(--role-done-ink, #4caf50);
}

.peer-dot.is-off {
  background: var(--border-color);
}

.peer-row-name {
  flex: 0 0 auto;
  font-weight: 500;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peer-row-url {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
}

.peer-row-ver {
  flex: 0 0 auto;
  color: var(--text-secondary);
  font-size: 11px;
}

.peer-btn {
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
}

.peer-btn:hover {
  background: var(--bg-hover);
}

.peer-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.peer-btn--primary {
  color: #fff;
  background: var(--color-primary, #3b82f6);
  border-color: transparent;
}

.peer-btn--primary:hover {
  background: var(--color-primary-dark, #2563eb);
}

.peer-btn--ghost {
  background: transparent;
}

/* 危险动作静息灰、hover 才红（与需求一致） */
.peer-btn--danger,
.peer-btn--warn {
  background: transparent;
  color: var(--text-secondary);
}

.peer-btn--danger:hover,
.peer-btn--warn:hover {
  color: #e5484d;
  border-color: #e5484d;
}
</style>
