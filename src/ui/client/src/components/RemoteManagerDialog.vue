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
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Plus, Upload, EditPen, Setting, Delete,
  CircleCheck, CircleClose, Connection, Loading
} from '@element-plus/icons-vue'
import { useGitStore, type RemoteInfo } from '@stores/gitStore'
import CommonDialog from '@components/CommonDialog.vue'
import GitCommandPreview from '@components/GitCommandPreview.vue'
import IconButton from '@components/IconButton.vue'

const gitStore = useGitStore()

// 可见性直接复用 store 状态:入口有三个(底部仓库卡片齿轮、推送下拉、行内按钮),
// 各自只负责把 isRemoteManagerVisible 置 true,避免多份状态不同步。
const visible = computed({
  get: () => gitStore.isRemoteManagerVisible,
  set: (v: boolean) => { gitStore.isRemoteManagerVisible = v }
})

// ── 添加远程 ────────────────────────────────────────────────────────────
const addForm = ref({ name: 'origin', url: '' })
const isAdding = ref(false)

const addCommand = computed(() => {
  const name = addForm.value.name.trim() || $t('@RMT01:<名称>')
  const url = addForm.value.url.trim() || $t('@RMT01:<地址>')
  return `git remote add ${name} ${url}`
})

async function handleAdd() {
  const name = addForm.value.name.trim()
  const url = addForm.value.url.trim()
  if (!name) {
    ElMessage.warning($t('@RMT01:请输入远程名称'))
    return
  }
  if (!url) {
    ElMessage.warning($t('@RMT01:请输入远程地址'))
    return
  }
  if (gitStore.remotes.some(r => r.name === name)) {
    ElMessage.warning($t('@RMT01:远程名称已存在'))
    return
  }
  isAdding.value = true
  try {
    // 提示与错误翻译都在 store 的 addRemote 内处理
    const ok = await gitStore.addRemote(url, name)
    if (ok) {
      ElMessage.success($t('@RMT01:远程添加成功'))
      // 清空名称与地址:首个 remote 用 origin 作默认值,加完再连加第二个时不应撞名
      addForm.value = { name: '', url: '' }
    }
  } finally {
    isAdding.value = false
  }
}

// ── 重命名子对话框 ──────────────────────────────────────────────────────
const renameVisible = ref(false)
const renameTarget = ref<RemoteInfo | null>(null)
const renameValue = ref('')
const isRenaming = ref(false)

const renameCommand = computed(() => {
  const oldName = renameTarget.value?.name || $t('@RMT01:<原名称>')
  const newName = renameValue.value.trim() || $t('@RMT01:<新名称>')
  return `git remote rename ${oldName} ${newName}`
})

function openRename(r: RemoteInfo) {
  renameTarget.value = r
  renameValue.value = r.name
  renameVisible.value = true
}

async function handleRename() {
  const target = renameTarget.value
  if (!target) return
  const newName = renameValue.value.trim()
  if (!newName) {
    ElMessage.warning($t('@RMT01:请输入新名称'))
    return
  }
  if (newName === target.name) {
    ElMessage.warning($t('@RMT01:新名称与原名称相同'))
    return
  }
  if (gitStore.remotes.some(r => r.name === newName)) {
    ElMessage.warning($t('@RMT01:远程名称已存在'))
    return
  }
  isRenaming.value = true
  try {
    const ok = await gitStore.renameRemote(target.name, newName)
    if (ok) renameVisible.value = false
  } finally {
    isRenaming.value = false
  }
}

// ── 编辑地址子对话框 ────────────────────────────────────────────────────
const urlVisible = ref(false)
const urlTarget = ref<RemoteInfo | null>(null)
const urlValue = ref('')
const isSavingUrl = ref(false)

const urlCommand = computed(() => {
  const name = urlTarget.value?.name || $t('@RMT01:<名称>')
  return `git remote set-url ${name} ${urlValue.value.trim() || $t('@RMT01:<地址>')}`
})

function openEditUrl(r: RemoteInfo) {
  urlTarget.value = r
  urlValue.value = r.fetchUrl
  urlVisible.value = true
}

async function handleSaveUrl() {
  const target = urlTarget.value
  if (!target) return
  const url = urlValue.value.trim()
  if (!url) {
    ElMessage.warning($t('@RMT01:请输入远程地址'))
    return
  }
  isSavingUrl.value = true
  try {
    const ok = await gitStore.setRemoteUrl(target.name, url)
    if (ok) urlVisible.value = false
  } finally {
    isSavingUrl.value = false
  }
}

// ── 推送地址(多 push URL)子对话框 ───────────────────────────────────────
const pushUrlVisible = ref(false)
const pushUrlTarget = ref<RemoteInfo | null>(null)
// 用对象行而非字符串行:v-for 的别名是局部变量,v-model="别名" 无法写回数组,
// 必须 v-model="row.url" 才能落到 ref 上。
const pushUrlRows = ref<{ url: string }[]>([{ url: '' }])
const isSavingPushUrls = ref(false)

const pushUrlCommand = computed(() => {
  const name = pushUrlTarget.value?.name || $t('@RMT01:<名称>')
  const urls = pushUrlRows.value.map(r => r.url.trim()).filter(Boolean)
  const parts = [`git config --unset-all remote.${name}.pushurl`]
  for (const u of urls) {
    parts.push(`git remote set-url --push --add ${name} ${u}`)
  }
  return parts.join(' && ')
})

function openPushUrls(r: RemoteInfo) {
  pushUrlTarget.value = r
  // 显式配过 pushurl 才回填;否则留一个空行,让用户从"与拉取地址一致"开始
  pushUrlRows.value = r.hasExplicitPushUrls && r.pushUrls.length > 0
    ? r.pushUrls.map(u => ({ url: u }))
    : [{ url: '' }]
  pushUrlVisible.value = true
}

function addPushUrlRow() {
  if (pushUrlRows.value.length >= 10) {
    ElMessage.warning($t('@RMT01:推送地址最多 10 条'))
    return
  }
  pushUrlRows.value.push({ url: '' })
}

function removePushUrlRow(index: number) {
  pushUrlRows.value.splice(index, 1)
  if (pushUrlRows.value.length === 0) pushUrlRows.value.push({ url: '' })
}

async function handleSavePushUrls() {
  const target = pushUrlTarget.value
  if (!target) return
  const urls = pushUrlRows.value.map(r => r.url.trim()).filter(Boolean)
  isSavingPushUrls.value = true
  try {
    // 全空 = 清空显式 pushurl,push 回落到 fetch URL(后端按空数组处理)
    const ok = await gitStore.setRemotePushUrls(target.name, urls)
    if (ok) pushUrlVisible.value = false
  } finally {
    isSavingPushUrls.value = false
  }
}

// ── 删除远程 ────────────────────────────────────────────────────────────
async function handleRemove(r: RemoteInfo) {
  try {
    await ElMessageBox.confirm(
      r.isUpstream
        ? $t('@RMT01:当前分支上游指向该远程，删除后将解除上游跟踪')
        : $t('@RMT01:删除后本地配置将移除，远程仓库本身不受影响'),
      `${$t('@RMT01:确认删除远程')} "${r.name}"`,
      {
        type: 'warning',
        confirmButtonText: $t('@RMT01:删除'),
        cancelButtonText: $t('@RMT01:取消')
      }
    )
  } catch {
    return // 用户取消
  }
  await gitStore.removeRemote(r.name)
}

// ── 推送 ────────────────────────────────────────────────────────────────
const pushingRemote = ref('')
const isPushingAll = ref(false)

// 单个远程推送:复用带进度的 SSE 通道,不传回调 = 不在弹窗内展示字节进度
async function handlePushOne(r: RemoteInfo) {
  pushingRemote.value = r.name
  try {
    const ok = await gitStore.pushToRemoteWithProgress(undefined, r.name)
    if (ok) ElMessage.success(`${$t('@RMT01:已推送到')} ${r.name}`)
  } finally {
    pushingRemote.value = ''
  }
}

async function handlePushAll() {
  isPushingAll.value = true
  try {
    // 逐条结果(含失败原因)写在 store.lastPushAllResults,下方结果区展示
    await gitStore.pushAllRemotes()
  } finally {
    isPushingAll.value = false
  }
}

// ── 复制地址 ────────────────────────────────────────────────────────────
async function copyText(text: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success($t('@RMT01:地址已复制'))
  } catch {
    ElMessage.error($t('@RMT01:复制失败'))
  }
}

// 打开时拉一次最新列表,并清掉上一轮的推送结果,避免看到过期状态
watch(visible, (v) => {
  if (!v) return
  gitStore.fetchRemotes()
  gitStore.lastPushAllResults = []
})
</script>

<template>
  <CommonDialog
    v-model="visible"
    :title="$t('@RMT01:远程仓库管理')"
    size="large"
    type="flex"
    :close-on-click-modal="false"
    custom-class="remote-manager-dialog"
  >
    <div class="remote-manager">
      <!-- 说明卡片 -->
      <div class="rm-hero">
        <div class="rm-hero__icon">
          <svg-icon icon-class="remote-repo" />
        </div>
        <div class="rm-hero__text">
          <h4>{{ $t('@RMT01:管理多个远程仓库') }}</h4>
          <p>{{ $t('@RMT01:一个仓库可配置多个远程（如 origin / upstream / backup），推送时按名称选择目标。') }}</p>
        </div>
      </div>

      <!-- 添加远程 -->
      <section class="rm-section">
        <h4 class="rm-section__title">
          <el-icon><Plus /></el-icon>
          <span>{{ $t('@RMT01:添加远程') }}</span>
        </h4>
        <div class="rm-add">
          <div class="rm-field rm-field--name">
            <label for="rm-add-name">{{ $t('@RMT01:远程名称') }}</label>
            <el-input
              id="rm-add-name"
              v-model="addForm.name"
              :placeholder="$t('@RMT01:例如 origin、upstream、backup')"
              clearable
              @keyup.enter="handleAdd"
            />
          </div>
          <div class="rm-field rm-field--url">
            <label for="rm-add-url">{{ $t('@RMT01:远程地址') }}</label>
            <el-input
              id="rm-add-url"
              v-model="addForm.url"
              placeholder="git@github.com:user/project.git"
              clearable
              @keyup.enter="handleAdd"
            />
          </div>
          <el-button type="primary" :loading="isAdding" class="rm-add__btn" @click="handleAdd">
            {{ $t('@RMT01:添加') }}
          </el-button>
        </div>
        <GitCommandPreview
          :command="addCommand"
          :title="$t('@RMT01:命令预览：')"
          :placeholder="$t('@RMT01:填写名称与地址后显示命令')"
        />
      </section>

      <!-- 远程列表 -->
      <section class="rm-section rm-section--list">
        <h4 class="rm-section__title">
          <el-icon><Connection /></el-icon>
          <span>{{ $t('@RMT01:远程仓库列表') }}</span>
          <span class="rm-count">{{ gitStore.remotes.length }}</span>
        </h4>

        <div v-if="gitStore.isLoadingRemotes && gitStore.remotes.length === 0" class="rm-empty">
          <el-icon class="is-loading"><Loading /></el-icon>
          <span>{{ $t('@RMT01:加载中…') }}</span>
        </div>
        <div v-else-if="gitStore.remotes.length === 0" class="rm-empty">
          <span>{{ $t('@RMT01:暂无远程仓库') }}</span>
        </div>

        <div v-else class="rm-rows">
          <div
            v-for="r in gitStore.remotes"
            :key="r.name"
            class="rm-row"
            :class="{ 'is-upstream': r.isUpstream }"
          >
            <div class="rm-row__head">
              <span class="rm-row__name">{{ r.name }}</span>
              <el-tag v-if="r.isUpstream" size="small" type="success" effect="light">
                {{ $t('@RMT01:上游') }}
              </el-tag>
              <el-tag v-if="r.isPushDefault" size="small" type="warning" effect="light">
                {{ $t('@RMT01:默认推送') }}
              </el-tag>
              <span class="rm-row__spacer" />
              <div class="rm-row__actions">
                <el-button
                  size="small"
                  type="primary"
                  :icon="Upload"
                  :loading="pushingRemote === r.name"
                  :disabled="gitStore.isPushing"
                  @click="handlePushOne(r)"
                >
                  {{ $t('@RMT01:推送') }}
                </el-button>
                <IconButton
                  :tooltip="$t('@RMT01:编辑地址')"
                  size="small"
                  @click="openEditUrl(r)"
                >
                  <el-icon><EditPen /></el-icon>
                </IconButton>
                <IconButton
                  :tooltip="$t('@RMT01:管理推送地址')"
                  size="small"
                  @click="openPushUrls(r)"
                >
                  <el-icon><Setting /></el-icon>
                </IconButton>
                <IconButton
                  :tooltip="$t('@RMT01:重命名')"
                  size="small"
                  @click="openRename(r)"
                >
                  <svg-icon icon-class="git-branch" />
                </IconButton>
                <IconButton
                  :tooltip="$t('@RMT01:删除')"
                  size="small"
                  hover-color="var(--color-danger)"
                  @click="handleRemove(r)"
                >
                  <el-icon><Delete /></el-icon>
                </IconButton>
              </div>
            </div>

            <div class="rm-row__urls">
              <div class="rm-url">
                <span class="rm-url__label">{{ $t('@RMT01:拉取地址') }}</span>
                <el-tooltip :content="$t('@RMT01:点击复制')" placement="top" :show-after="300">
                  <span class="rm-url__value" @click="copyText(r.fetchUrl)">{{ r.fetchUrl }}</span>
                </el-tooltip>
              </div>
              <div v-if="r.hasExplicitPushUrls" class="rm-url">
                <span class="rm-url__label">{{ $t('@RMT01:推送地址') }}</span>
                <el-tooltip
                  v-for="(u, i) in r.pushUrls"
                  :key="i"
                  :content="$t('@RMT01:点击复制')"
                  placement="top"
                  :show-after="300"
                >
                  <el-tag size="small" class="rm-pushurl" @click="copyText(u)">{{ u }}</el-tag>
                </el-tooltip>
              </div>
              <div v-else class="rm-url">
                <span class="rm-url__hint">{{ $t('@RMT01:推送地址与拉取地址一致') }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div class="rm-footer">
        <div v-if="gitStore.lastPushAllResults.length" class="rm-push-results">
          <span class="rm-push-results__title">{{ $t('@RMT01:上次推送结果') }}</span>
          <span
            v-for="res in gitStore.lastPushAllResults"
            :key="res.name"
            class="rm-push-result"
            :class="res.ok ? 'is-ok' : 'is-fail'"
            :title="res.error || ''"
          >
            <el-icon><CircleCheck v-if="res.ok" /><CircleClose v-else /></el-icon>
            {{ res.name }}
          </span>
        </div>
        <div class="rm-footer__actions">
          <el-button
            v-if="gitStore.hasMultipleRemotes"
            type="primary"
            :icon="Upload"
            :loading="isPushingAll"
            @click="handlePushAll"
          >
            {{ $t('@RMT01:推送到全部远程') }}
          </el-button>
          <el-button @click="visible = false">{{ $t('@RMT01:关闭') }}</el-button>
        </div>
      </div>
    </template>
  </CommonDialog>

  <!-- 重命名 -->
  <CommonDialog
    v-model="renameVisible"
    :title="$t('@RMT01:重命名远程仓库')"
    size="small"
    :close-on-click-modal="false"
    show-footer
    :confirm-text="$t('@RMT01:保存')"
    :cancel-text="$t('@RMT01:取消')"
    :confirm-loading="isRenaming"
    @confirm="handleRename"
  >
    <el-form label-position="top">
      <el-form-item :label="$t('@RMT01:新名称')">
        <el-input
          v-model="renameValue"
          :placeholder="$t('@RMT01:请输入新名称')"
          clearable
          @keyup.enter="handleRename"
        />
      </el-form-item>
    </el-form>
    <p class="rm-tip">{{ $t('@RMT01:重命名后当前分支的上游跟踪会自动跟随，无需手动调整。') }}</p>
    <GitCommandPreview :command="renameCommand" :title="$t('@RMT01:命令预览：')" />
  </CommonDialog>

  <!-- 编辑地址 -->
  <CommonDialog
    v-model="urlVisible"
    :title="$t('@RMT01:编辑远程地址')"
    size="small"
    :close-on-click-modal="false"
    show-footer
    :confirm-text="$t('@RMT01:保存')"
    :cancel-text="$t('@RMT01:取消')"
    :confirm-loading="isSavingUrl"
    @confirm="handleSaveUrl"
  >
    <el-form label-position="top">
      <el-form-item :label="$t('@RMT01:远程地址')">
        <el-input
          v-model="urlValue"
          placeholder="git@github.com:user/project.git"
          clearable
          @keyup.enter="handleSaveUrl"
        />
      </el-form-item>
    </el-form>
    <p v-if="urlTarget?.hasExplicitPushUrls" class="rm-tip rm-tip--warn">
      {{ $t('@RMT01:该远程配置了独立的推送地址，不受本次修改影响') }}
    </p>
    <GitCommandPreview :command="urlCommand" :title="$t('@RMT01:命令预览：')" />
  </CommonDialog>

  <!-- 推送地址 -->
  <CommonDialog
    v-model="pushUrlVisible"
    :title="$t('@RMT01:管理推送地址')"
    size="medium"
    :close-on-click-modal="false"
    show-footer
    :confirm-text="$t('@RMT01:保存')"
    :cancel-text="$t('@RMT01:取消')"
    :confirm-loading="isSavingPushUrls"
    @confirm="handleSavePushUrls"
  >
    <div class="rm-pushurls">
      <div
        v-for="(row, i) in pushUrlRows"
        :key="i"
        class="rm-pushurl-row"
      >
        <el-input
          v-model="row.url"
          :placeholder="$t('@RMT01:推送地址')"
          clearable
          @keyup.enter="handleSavePushUrls"
        />
        <IconButton
          :tooltip="$t('@RMT01:删除')"
          size="small"
          hover-color="var(--color-danger)"
          @click="removePushUrlRow(i)"
        >
          <el-icon><Delete /></el-icon>
        </IconButton>
      </div>
      <el-button link type="primary" :icon="Plus" @click="addPushUrlRow">
        {{ $t('@RMT01:添加一行') }}
      </el-button>
      <p class="rm-tip">{{ $t('@RMT01:留空则推送地址与拉取地址一致；配置多个推送地址后可一次推送到多处。') }}</p>
    </div>
    <GitCommandPreview :command="pushUrlCommand" :title="$t('@RMT01:命令预览：')" />
  </CommonDialog>
</template>

<style scoped lang="scss">
.remote-manager {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

/* 说明卡片 */
.rm-hero {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-base);
  padding: var(--spacing-base);
  /* 全部用主题感知令牌:--color-gray-* 是固定浅灰,不随深色主题翻转,
     拿它做底色会在深色下变成"浅底浅字" */
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  background: var(--bg-subtle);

  &__icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: var(--radius-lg);
    background: var(--color-primary);
    color: #fff;
    font-size: var(--font-size-lg);
  }

  &__text {
    flex: 1;
    min-width: 0;

    h4 {
      margin: 0 0 4px;
      font-size: var(--font-size-md);
      font-weight: 600;
      color: var(--color-text-title);
    }

    p {
      margin: 0;
      font-size: var(--font-size-sm);
      color: var(--text-secondary);
      line-height: 1.5;
    }
  }
}

/* 区块 */
.rm-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);

  &__title {
    display: flex;
    align-items: center;
    gap: var(--spacing-base);
    margin: 0;
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text-title);

    .el-icon {
      color: var(--text-secondary);
    }
  }
}

.rm-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

/* 添加表单 */
.rm-add {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-base);
  flex-wrap: wrap;
}

.rm-field {
  display: flex;
  flex-direction: column;
  gap: 6px;

  label {
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  &--name {
    flex: 0 0 200px;
  }

  &--url {
    flex: 1;
    min-width: 260px;
  }
}

.rm-add__btn {
  height: 32px;
}

/* 列表 */
.rm-rows {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.rm-row {
  padding: var(--spacing-base);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;

  &:hover {
    border-color: var(--border-card-hover);
    box-shadow: var(--shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.06));
  }

  &.is-upstream {
    border-left: 3px solid var(--color-success);
  }

  &__head {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  &__name {
    font-family: var(--font-mono);
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text-title);
  }

  &__spacer {
    flex: 1;
  }

  &__actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
  }

  &__urls {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: var(--spacing-sm);
  }
}

.rm-url {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;

  &__label {
    flex-shrink: 0;
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    min-width: 56px;
  }

  &__value {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--color-text);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    &:hover {
      color: var(--color-primary);
      text-decoration: underline;
    }
  }

  &__hint {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
  }
}

.rm-pushurl {
  cursor: pointer;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 空态 */
.rm-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-2xl);
  border: 1px dashed var(--border-color-medium);
  border-radius: var(--radius-xl);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

/* 底部 */
.rm-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-base);
  width: 100%;
  flex-wrap: wrap;
}

.rm-footer__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  margin-left: auto;
}

.rm-push-results {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
  font-size: var(--font-size-sm);

  &__title {
    color: var(--text-secondary);
  }
}

.rm-push-result {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-base);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);

  &.is-ok {
    background: rgba(16, 185, 129, 0.12);
    color: var(--color-success);
  }

  &.is-fail {
    background: rgba(239, 68, 68, 0.12);
    color: var(--color-danger);
    cursor: help;
  }
}

/* 推送地址编辑 */
.rm-pushurls {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  align-items: flex-start;
}

.rm-pushurl-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  width: 100%;

  :deep(.el-input) {
    flex: 1;
  }
}

.rm-tip {
  margin: var(--spacing-sm) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.5;

  &--warn {
    color: var(--color-warning);
  }
}

// 弹窗内按钮圆角与项目风格保持一致
:deep(.el-button) {
  border-radius: var(--btn-radius);
}
</style>
