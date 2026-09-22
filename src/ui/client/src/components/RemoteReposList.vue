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
// GitHub / Gitee 仓库列表面板(App.vue 的「{平台} 仓库」Tab)。
//
// 同一个组件服务两个平台,差异全在 provider 上:
//   github → gh        (winget / brew / apt 装)
//   gitee  → gitee     (npm 装 @gitee/gitee-cli)
// 服务端 /api/remote-repos 把"命令、参数、安装方式"全部决定好,这里只渲染,
// 不拼任何命令 —— 与 ToolInstallDialog 同一条原则。
//
// 四种状态(都不是"错误",各自有对应的下一步):
//   1. 未安装 CLI   → 给出平台对应的安装命令 + 一键安装,装完自动轮询刷新
//   2. 已装未登录   → 给出登录命令 + 一键登录。登录是**交互式**的
//                     (选平台/协议、跳浏览器授权、粘贴 token),UI 代劳不了,
//                     所以一键登录只负责在新终端窗口里把命令跑起来,
//                     然后轮询等 authenticated 翻真 —— 成功后列表自动出来
//   3. 已登录       → 仓库卡片网格 + 搜索 + 刷新
//   4. 拉取失败     → 就地展示原因(网络/代理/超时),不影响上面三层
//
// 凭据全部由 CLI 自己保管 —— 这个组件和服务端都不接触、不转发用户的 token。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CircleCheck,
  Connection,
  DocumentCopy,
  Download,
  Key,
  Link,
  Loading,
  Refresh,
  Search,
  Star,
  WarningFilled,
} from '@element-plus/icons-vue'
import { $t } from '@/lang/static'

/** 服务端 /api/remote-repos 的仓库条目 */
interface RemoteRepo {
  name: string
  fullName: string
  description: string
  isPrivate: boolean
  isFork: boolean
  language: string | null
  stars: number
  updatedAt: string | null
  url: string
}

/** 服务端给前端的安装方式(命令已经在服务端按平台选好) */
interface InstallerInfo {
  supported: boolean
  command: string
  packageManager: string
  docsUrl: string
  note: string
}

interface RemoteReposPayload {
  provider: string
  cli: string
  label: string
  platform: string
  docsUrl: string
  loginCommand: string
  installer: InstallerInfo | null
  installed: boolean
  version: string | null
  authenticated: boolean
  user: string | null
  repos: RemoteRepo[]
  truncated: boolean
  error: string | null
}

const props = defineProps<{ provider: 'github' | 'gitee' }>()

/** 安装白名单里的工具 id。provider 名和工具 id 不是一回事(github → gh)。 */
const TOOL_ID = { github: 'gh', gitee: 'gitee' } as const

/** 卡片网格每列最小宽度:和「最近项目」保持同一档,切 Tab 时卡片不会跳尺寸 */
const CARD_MIN_WIDTH = '420px'

/** 安装后自动轮询:5 秒一次,最多 24 次(2 分钟)。
 *  与 ToolInstallDialog 同一档 —— 装包管理器跑完通常在这个区间内,
 *  超时后仍可手动「重新检测」。 */
const POLL_INTERVAL_MS = 5000
const POLL_MAX_TRIES = 24

/** 登录的轮询窗口给得长得多:一键登录只是把终端窗口开起来,真正的问答
 *  (选平台/协议、跳浏览器授权、粘贴 token)是用户在终端里手动走完的,
 *  光跳浏览器那一步就可能好几分钟。2 分钟远不够。 */
const LOGIN_MAX_TRIES = 120

const data = ref<RemoteReposPayload | null>(null)
// 初值为 true:onMounted 触发首次加载之前会先渲染一帧,那时 data 还是 null。
// 若这里是 false,'loading/error' 的判定会先给出 error —— 界面会闪一下红字。
const isLoading = ref(true)
const loadError = ref('')
const searchQuery = ref('')

// 一键安装:点完之后进入等待态并开始轮询
const isInstalling = ref(false)
const installMessage = ref('')
// 一键登录:同样是"开个终端窗口 + 轮询等结果",只是等的是 authenticated
const isLoggingIn = ref(false)
const loginMessage = ref('')
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollTries = 0
/** 这轮轮询在等什么状态。安装等 installed、登录等 authenticated ——
 *  两个动作共用一套定时器,但"进行中"的标志各自归位(否则装完的提示
 *  会挂在登录屏上,反过来也一样)。 */
let pollUntil: ((payload: RemoteReposPayload) => boolean) | null = null

const platformLabel = computed(() => (props.provider === 'github' ? 'GitHub' : 'Gitee'))
const title = computed(() => $t('@REPOLIST:{name} 仓库', { name: platformLabel.value }))
const cliName = computed(() => data.value?.cli || (props.provider === 'github' ? 'gh' : 'gitee'))
const installer = computed(() => data.value?.installer || null)

/**
 * 这次安装是不是必然要过 UAC。
 *
 * Windows 上 winget 装的是**机器级 MSI**(GitHub.cli 是 wix 包，`winget show`
 * 里连 Scope 字段都没有，所以没有 `--scope user` 这条退路)，安装和升级都必须
 * 提权；而一键安装开的是普通权限的 cmd 窗口，msiexec 只能自己弹 UAC。
 *
 * 踩过的坑(2026-09-22 实测)：用户点了「一键安装」，下载 3 分 20 秒 → 校验通过
 * → 启动 MSI → 2 分 28 秒后 winget 报
 *     ShellExecute installer failed: 1602
 * MSI 日志的原话是「用户取消了安装」。1602 是 ERROR_INSTALL_USEREXIT，
 * 也就是那个把屏幕变暗的 UAC 弹窗没人点(本机 PromptOnSecureDesktop=1，
 * 只能手动确认，不会自动放行)。用户全程在盯进度条，压根没注意到它。
 *
 * 所以在这类安装方式旁边把话说在前面 —— 否则用户只会看到一个光秃秃的错误码。
 * npm 装 gitee 不需要提权(全局前缀在用户目录)，不显示这句。
 */
const needsElevation = computed(
  () => data.value?.platform === 'win32' && installer.value?.packageManager === 'winget',
)

/** 有仓库可展示吗?没登录/没安装时都为 false,走各自的引导态 */
const hasRepos = computed(() => (data.value?.repos.length || 0) > 0)

/** 当前应该渲染哪一屏。顺序即优先级:先解决"有没有装",再解决"有没有登录"。 */
const view = computed<'loading' | 'install' | 'login' | 'error' | 'list'>(() => {
  if (!data.value) return isLoading.value ? 'loading' : 'error'
  if (!data.value.installed) return 'install'
  if (!data.value.authenticated) return 'login'
  // 已登录但一条都没拉到 + 有错误 → 单独一屏讲清楚原因(否则是个空列表,像没数据)
  if (data.value.error && !hasRepos.value) return 'error'
  return 'list'
})

const items = computed(() => {
  const list = data.value?.repos || []
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return list
  return list.filter((repo) =>
    repo.name.toLowerCase().includes(q)
    || repo.fullName.toLowerCase().includes(q)
    || (repo.description || '').toLowerCase().includes(q)
  )
})

/** 卡片的悬浮提示:仓库名 + 完整路径 + 描述 + 更新时间 */
function repoTooltip(repo: RemoteRepo) {
  const lines = [repo.fullName]
  if (repo.description) lines.push(repo.description)
  const date = formatDate(repo.updatedAt)
  if (date) lines.push($t('@REPOLIST:更新于 {date}', { date }))
  return lines.join('\n')
}

function formatDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// ── 数据加载 ────────────────────────────────────────────────────────────────

/**
 * 读 JSON 响应，把"拿到的其实是 HTML"翻译成一句能指导动作的话。
 *
 * 场景(实测遇到):服务端还是旧进程、没有 /api/remote-repos 这个路由时，
 * Express 会落到 SPA 兜底，返回 index.html(200 + text/html)。此时直接
 * `res.json()` 抛的是
 *   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
 * —— 用户看到这行完全无从下手。这里显式把最常见的原因(服务未重启，新增接口
 * 还没生效)说出来，前端改完重新构建时特别容易撞上：页面已经是新版，后端却还是旧的。
 */
async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error($t('@REPOLIST:接口返回的不是 JSON，通常是服务未重启（新增接口需重启 ZenGitSync 服务后生效）'))
  }
}

async function load() {
  isLoading.value = true
  try {
    const res = await fetch(`/api/remote-repos?provider=${props.provider}`, { cache: 'no-store' })
    const payload = await readJson(res)
    if (!res.ok || !payload?.success) {
      loadError.value = payload?.error || $t('@REPOLIST:仓库列表加载失败')
      data.value = null
      return
    }
    loadError.value = ''
    data.value = payload as RemoteReposPayload
    // 等到目标状态就收工:退出"进行中"态并停表 —— 否则这个标志会一直挂着,
    // 下次回到这一屏时按钮还显示"安装中..."
    if (pollUntil?.(data.value)) {
      finishAction()
      stopPolling()
    }
  } catch (error) {
    loadError.value = (error as Error).message || $t('@REPOLIST:仓库列表加载失败')
    data.value = null
  } finally {
    isLoading.value = false
  }
}

/** 停表。只管理计时器与"在等什么",不动两个"进行中"标志 ——
 *  标志的归位统一走 finishAction(),免得停表时把刚设好的提示语一起擦掉。 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  pollUntil = null
}

/** 退出"进行中"态:装完 / 登录成功 / 轮询超时都走这里 */
function finishAction() {
  isInstalling.value = false
  isLoggingIn.value = false
  installMessage.value = ''
  loginMessage.value = ''
}

/**
 * 动作发出后开始轮询。`until` 判断"目标状态到了没":
 * 安装看 installed,登录看 authenticated。
 *
 * 超时也一并收工(finishAction)—— 否则按钮会永远停在"安装中..."且点不动,
 * 只能靠用户手动点「重新检测」解套,而那时候界面上没有任何提示告诉他该点。
 */
function startPolling(until: (payload: RemoteReposPayload) => boolean, maxTries = POLL_MAX_TRIES) {
  stopPolling()
  pollUntil = until
  pollTries = 0
  pollTimer = setInterval(async () => {
    pollTries += 1
    await load()
    if (pollTries >= maxTries) {
      finishAction()
      stopPolling()
    }
  }, POLL_INTERVAL_MS)
}

// ── 动作 ────────────────────────────────────────────────────────────────────

/** 一键安装。命令由服务端按平台从白名单选,这里只提交 tool id。 */
async function installCli() {
  if (isInstalling.value) return
  isInstalling.value = true
  installMessage.value = ''
  try {
    const res = await fetch('/api/install-tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: TOOL_ID[props.provider] }),
    })
    const result = await readJson(res)
    if (!res.ok || !result.success) throw new Error(result.error || $t('@REPOLIST:启动安装失败'))
    ElMessage.success(result.message || $t('@REPOLIST:安装命令已在新终端中启动'))
    installMessage.value = $t('@REPOLIST:正在等待安装完成，完成后会自动刷新列表')
    startPolling((payload) => payload.installed)
  } catch (error) {
    isInstalling.value = false
    ElMessage.error((error as Error).message)
  }
}

/**
 * 一键登录:在新终端窗口里跑 `gh auth login` / `gitee auth login`。
 *
 * 登录本身代劳不了 —— 它是**交互式**的(选平台、选协议、走浏览器授权还是
 * 粘贴 token),必须有 TTY。所以这里只负责把窗口开起来(命令由服务端从白名单
 * 取,前端不拼命令),之后再轮询等 authenticated 翻真:用户在终端里走完问答,
 * 仓库列表就自动出来了,不用回来点「重新检测」。
 */
async function login() {
  if (isLoggingIn.value) return
  isLoggingIn.value = true
  loginMessage.value = ''
  try {
    const res = await fetch('/api/remote-repos/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: props.provider }),
    })
    const result = await readJson(res)
    if (!res.ok || !result.success) throw new Error(result.error || $t('@REPOLIST:启动登录失败'))
    ElMessage.success($t('@REPOLIST:登录命令已在新终端中启动'))
    loginMessage.value = $t('@REPOLIST:请在终端中完成登录，成功后会自动刷新列表')
    startPolling((payload) => payload.authenticated, LOGIN_MAX_TRIES)
  } catch (error) {
    isLoggingIn.value = false
    ElMessage.error((error as Error).message)
  }
}

async function copyText(text: string, successMessage: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    ElMessage.success(successMessage)
  } catch {
    ElMessage.error($t('@REPOLIST:复制失败'))
  }
}

function openUrl(url: string) {
  if (!url) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

function openDocs() {
  openUrl(data.value?.docsUrl || installer.value?.docsUrl || '')
}

/** 「重新检测」= 手动跑一次 load,并退出等待态(用户可能已经用别的方式
 *  装好了,或者自己在终端里登录完了) */
async function recheck() {
  finishAction()
  stopPolling()
  await load()
}

onMounted(load)
onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="repo-list">
    <div class="repo-list__head">
      <span class="repo-list__title">{{ title }}</span>
      <div class="repo-list__head-actions">
        <!-- 状态一行说清:装了哪个版本 / 登录成谁。没有这些信息时不留占位 -->
        <span v-if="data?.installed" class="repo-list__status">
          <template v-if="data.version">{{ $t('@REPOLIST:{cli} {version}', { cli: cliName, version: data.version }) }}</template>
          <template v-else>{{ cliName }}</template>
        </span>
        <span v-if="data?.authenticated && data.user" class="repo-list__status">
          <el-icon aria-hidden="true"><Connection /></el-icon>
          {{ $t('@REPOLIST:已登录 {user}', { user: data.user }) }}
        </span>
        <span v-if="data?.authenticated && hasRepos" class="repo-list__hint">
          {{ $t('@REPOLIST:共 {count} 个仓库', { count: data.repos.length }) }}
        </span>
        <button
          v-if="view === 'list' || view === 'error'"
          type="button"
          class="repo-list__action"
          :disabled="isLoading"
          :title="$t('@REPOLIST:重新拉取仓库列表')"
          @click="load"
        >
          <el-icon :class="{ 'is-spinning': isLoading }" aria-hidden="true"><Refresh /></el-icon>
          <span>{{ $t('@REPOLIST:刷新') }}</span>
        </button>
      </div>
    </div>

    <!-- ① 加载中 -->
    <div v-if="view === 'loading'" class="repo-list__center">
      <el-icon class="is-loading" aria-hidden="true"><Loading /></el-icon>
      <span>{{ $t('@REPOLIST:加载中...') }}</span>
    </div>

    <!-- ② 未安装 CLI:给出平台对应的安装命令 -->
    <div v-else-if="view === 'install'" class="repo-list__guide">
      <div class="repo-list__guide-icon" aria-hidden="true">
        <Download />
      </div>
      <h3 class="repo-list__guide-title">{{ $t('@REPOLIST:未检测到 {cli}', { cli: cliName }) }}</h3>
      <p class="repo-list__guide-desc">
        {{ $t('@REPOLIST:安装后即可在这里浏览你在 {name} 上的全部仓库（含私有仓库）。', { name: platformLabel }) }}
      </p>

      <div class="repo-list__cmd">
        <span class="repo-list__cmd-label">{{ installer?.packageManager || $t('@REPOLIST:安装命令') }}</span>
        <div class="repo-list__cmd-row">
          <code>{{ installer?.command || $t('@REPOLIST:请查看官方文档') }}</code>
          <button
            v-if="installer?.command"
            type="button"
            class="repo-list__icon-btn"
            :aria-label="$t('@REPOLIST:复制安装命令')"
            :title="$t('@REPOLIST:复制安装命令')"
            @click="copyText(installer.command, $t('@REPOLIST:安装命令已复制'))"
          >
            <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
          </button>
        </div>
        <p v-if="installer?.note" class="repo-list__cmd-note">{{ installer.note }}</p>
      </div>

      <p v-if="needsElevation" class="repo-list__guide-note repo-list__guide-note--warn">
        <el-icon aria-hidden="true"><WarningFilled /></el-icon>
        <span>{{ $t('@REPOLIST:winget 装的是机器级安装包，过程中会弹出 UAC 提权窗口（屏幕会变暗），必须点「是」；没人确认时安装会以错误码 1602 失败。') }}</span>
      </p>

      <div class="repo-list__guide-actions">
        <button
          v-if="installer?.supported"
          type="button"
          class="repo-list__btn repo-list__btn--primary"
          :disabled="isInstalling"
          @click="installCli"
        >
          <el-icon v-if="isInstalling" class="is-loading" aria-hidden="true"><Loading /></el-icon>
          {{ isInstalling ? $t('@REPOLIST:安装中...') : $t('@REPOLIST:一键安装') }}
        </button>
        <button type="button" class="repo-list__btn" :disabled="isLoading" @click="recheck">
          <el-icon aria-hidden="true"><Refresh /></el-icon>
          {{ $t('@REPOLIST:重新检测') }}
        </button>
        <button type="button" class="repo-list__btn" @click="openDocs">
          <el-icon aria-hidden="true"><Link /></el-icon>
          {{ $t('@REPOLIST:官方文档') }}
        </button>
      </div>

      <p v-if="installMessage" class="repo-list__guide-note repo-list__guide-note--waiting">
        {{ installMessage }}
      </p>
      <p v-if="isInstalling" class="repo-list__guide-note">
        {{ $t('@REPOLIST:若安装完成后仍未检测到，请重启 ZenGitSync 服务以刷新 PATH') }}
      </p>
    </div>

    <!-- ③ 已安装但未登录 -->
    <div v-else-if="view === 'login'" class="repo-list__guide">
      <div class="repo-list__guide-icon" aria-hidden="true">
        <Key />
      </div>
      <h3 class="repo-list__guide-title">
        {{ $t('@REPOLIST:{cli} 尚未登录', { cli: cliName }) }}
      </h3>
      <p class="repo-list__guide-desc">
        {{ $t('@REPOLIST:在终端执行下面的命令完成授权。凭据由 {cli} 自己保管，ZenGitSync 不会读取你的令牌。', { cli: cliName }) }}
      </p>

      <div class="repo-list__cmd">
        <div class="repo-list__cmd-row">
          <code>{{ data?.loginCommand }}</code>
          <button
            type="button"
            class="repo-list__icon-btn"
            :aria-label="$t('@REPOLIST:复制登录命令')"
            :title="$t('@REPOLIST:复制登录命令')"
            @click="copyText(data?.loginCommand || '', $t('@REPOLIST:登录命令已复制'))"
          >
            <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
          </button>
        </div>
      </div>

      <div class="repo-list__guide-actions">
        <button
          type="button"
          class="repo-list__btn repo-list__btn--primary"
          :disabled="isLoggingIn"
          @click="login"
        >
          <el-icon v-if="isLoggingIn" class="is-loading" aria-hidden="true"><Loading /></el-icon>
          <el-icon v-else aria-hidden="true"><Key /></el-icon>
          {{ isLoggingIn ? $t('@REPOLIST:登录中...') : $t('@REPOLIST:一键登录') }}
        </button>
        <button type="button" class="repo-list__btn" :disabled="isLoading" @click="recheck">
          <el-icon :class="{ 'is-spinning': isLoading }" aria-hidden="true"><Refresh /></el-icon>
          {{ $t('@REPOLIST:我已登录，重新检测') }}
        </button>
        <button type="button" class="repo-list__btn" @click="openDocs">
          <el-icon aria-hidden="true"><Link /></el-icon>
          {{ $t('@REPOLIST:官方文档') }}
        </button>
      </div>

      <p v-if="loginMessage" class="repo-list__guide-note repo-list__guide-note--waiting">
        {{ loginMessage }}
      </p>
    </div>

    <!-- ④ 已登录但拉取失败 -->
    <div v-else-if="view === 'error'" class="repo-list__center repo-list__center--error">
      <el-icon aria-hidden="true"><WarningFilled /></el-icon>
      <span>{{ loadError || data?.error || $t('@REPOLIST:仓库列表加载失败') }}</span>
      <button type="button" class="repo-list__btn" :disabled="isLoading" @click="load">
        {{ $t('@REPOLIST:重试') }}
      </button>
    </div>

    <!-- ⑤ 仓库列表 -->
    <template v-else>
      <div class="repo-list__search">
        <el-icon class="repo-list__search-icon" aria-hidden="true"><Search /></el-icon>
        <input
          v-model="searchQuery"
          type="text"
          class="repo-list__search-input"
          :placeholder="$t('@REPOLIST:搜索仓库...')"
          :aria-label="$t('@REPOLIST:搜索仓库')"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="repo-list__search-clear"
          :aria-label="$t('@REPOLIST:清空搜索')"
          @click="searchQuery = ''"
        >×</button>
      </div>

      <!-- 拉取失败但有旧数据:不打断列表,只在顶部补一条说明 -->
      <div v-if="data?.error" class="repo-list__banner">
        <el-icon aria-hidden="true"><WarningFilled /></el-icon>
        <span>{{ data.error }}</span>
      </div>

      <div v-if="data?.truncated" class="repo-list__banner repo-list__banner--info">
        <el-icon aria-hidden="true"><WarningFilled /></el-icon>
        <span>{{ $t('@REPOLIST:仓库较多，仅显示前 {count} 个', { count: data.repos.length }) }}</span>
      </div>

      <div v-if="items.length === 0" class="repo-list__center">
        <template v-if="searchQuery">
          {{ $t('@REPOLIST:没有匹配 "{q}" 的仓库', { q: searchQuery }) }}
        </template>
        <template v-else>
          {{ $t('@REPOLIST:该账号下暂无仓库') }}
        </template>
      </div>

      <ul v-else class="repo-list__items" :style="{ '--repo-card-min': CARD_MIN_WIDTH }" :aria-label="title">
        <li v-for="repo in items" :key="repo.fullName" class="repo-card" :title="repoTooltip(repo)">
          <button
            type="button"
            class="repo-card__btn"
            :aria-label="$t('@REPOLIST:在浏览器中打开 {name}', { name: repo.fullName })"
            @click="openUrl(repo.url)"
          >
            <el-icon class="repo-card__icon" aria-hidden="true"><Connection /></el-icon>
            <span class="repo-card__name">
              <span class="repo-card__name-base">{{ repo.name }}</span>
              <span class="repo-card__name-path">
                {{ repo.description || repo.fullName }}
              </span>
            </span>
            <span class="repo-card__tags">
              <span v-if="repo.isFork" class="repo-card__tag repo-card__tag--plain">{{ $t('@REPOLIST:Fork') }}</span>
              <span v-if="repo.isPrivate" class="repo-card__tag repo-card__tag--plain">{{ $t('@REPOLIST:私有') }}</span>
              <span v-if="repo.language" class="repo-card__tag repo-card__tag--plain">{{ repo.language }}</span>
              <!-- 星标只在有人 star 时才出现:满屏 ★0 是没有信息量的噪音 -->
              <span v-if="repo.stars > 0" class="repo-card__tag repo-card__tag--star">
                <el-icon aria-hidden="true"><Star /></el-icon>{{ repo.stars }}
              </span>
            </span>
          </button>
          <span class="repo-card__actions">
            <button
              type="button"
              class="repo-card__action"
              :title="$t('@REPOLIST:复制仓库地址')"
              :aria-label="$t('@REPOLIST:复制仓库地址 {name}', { name: repo.fullName })"
              @click.stop="copyText(repo.url, $t('@REPOLIST:仓库地址已复制'))"
            >
              <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
            </button>
            <button
              type="button"
              class="repo-card__action"
              :title="$t('@REPOLIST:在浏览器中打开')"
              :aria-label="$t('@REPOLIST:在浏览器中打开 {name}', { name: repo.fullName })"
              @click.stop="openUrl(repo.url)"
            >
              <el-icon aria-hidden="true"><Link /></el-icon>
            </button>
          </span>
        </li>
      </ul>

      <p v-if="items.length > 0 && !searchQuery" class="repo-list__footnote">
        <el-icon aria-hidden="true"><CircleCheck /></el-icon>
        {{ $t('@REPOLIST:点击卡片在浏览器中打开仓库主页') }}
      </p>
    </template>
  </div>
</template>

<style scoped>
/* 外壳沿用「最近项目」面板的形态(卡片化 + 标题行 + 内部滚动),
   两个 Tab 之间切换时视觉不跳。 */
.repo-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  /* 父级(App.vue 的 .git-pane__body)是列方向 flex:用 flex 撑满而不是 height:100%,
     否则自带的 margin 会把总高顶成 100%+2*margin,底部被父级 overflow 切掉。
     height:100% 只作为"父级不是 flex 容器"时的兜底。 */
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  margin: var(--spacing-md);
  padding: var(--spacing-xl);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  text-align: left;
  line-height: var(--line-height-normal);
}

.repo-list__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm) var(--spacing-base);
}
.repo-list__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  letter-spacing: -0.2px;
  color: var(--text-primary);
}
.repo-list__head-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm) var(--spacing-base);
}
.repo-list__status,
.repo-list__hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}
.repo-list__status .el-icon {
  font-size: 13px;
}

/* 有边框的动作按钮:与「刷新全部」同一套语汇 —— 要花几秒的动作值得一个明确的
   可点击边界,而不是 hover 才显形的图标 */
.repo-list__action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.repo-list__action:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-08);
}
.repo-list__action:disabled {
  opacity: 0.55;
  cursor: default;
}
.repo-list__action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.repo-list__action .el-icon {
  font-size: 14px;
}
.repo-list__action .el-icon.is-spinning {
  animation: repo-list-spin 0.9s linear infinite;
}
@keyframes repo-list-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .repo-list__action .el-icon.is-spinning { animation: none; }
}

/* ── 居中态(加载中 / 空 / 失败) ──────────────────────────────────── */
.repo-list__center {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xl) var(--spacing-md);
  color: var(--text-secondary);
  font-size: 13px;
  text-align: center;
}
.repo-list__center .el-icon {
  font-size: 20px;
}
.repo-list__center--error {
  color: var(--text-primary);
}
.repo-list__center--error .el-icon {
  color: var(--el-color-warning);
  font-size: 26px;
}
.repo-list__center .repo-list__btn {
  margin-top: var(--spacing-sm);
}

/* ── 引导态(未安装 / 未登录) ─────────────────────────────────────── */
.repo-list__guide {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-base);
  padding: var(--spacing-xl) var(--spacing-md);
  text-align: center;
}
.repo-list__guide-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex: 0 0 52px;
  border-radius: 14px;
  color: var(--color-primary);
  background: var(--tint-primary-08);
}
.repo-list__guide-icon svg {
  width: 26px;
  height: 26px;
}
.repo-list__guide-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}
.repo-list__guide-desc {
  margin: 0;
  max-width: 560px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-secondary);
}
.repo-list__cmd {
  width: min(560px, 100%);
  padding: var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  text-align: left;
}
.repo-list__cmd-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.repo-list__cmd-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.repo-list__cmd-row code {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border-radius: var(--radius-base);
  background: var(--bg-container);
  color: var(--text-primary);
  font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  /* 换行而不是横向滚动:winget 的安装命令有 100+ 字符,横向滚动会让尾巴
     (--accept-source-agreements)看不见 —— 而用户来这里就是为了看清并复制它。
     实测 1600px 宽下也会被截断,所以不能指望容器够宽。 */
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.6;
}
.repo-list__cmd-note {
  margin: 9px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.repo-list__icon-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.repo-list__icon-btn:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-08);
}
.repo-list__icon-btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.repo-list__guide-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
}
.repo-list__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 var(--spacing-lg);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.repo-list__btn:hover:not(:disabled) {
  color: var(--color-primary);
  border-color: var(--color-primary);
  background: var(--tint-primary-08);
}
.repo-list__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.repo-list__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.repo-list__btn--primary {
  border-color: var(--color-primary);
  background: var(--color-primary);
  color: var(--btn-primary-color);
}
.repo-list__btn--primary:hover:not(:disabled) {
  color: var(--btn-primary-color);
  background: var(--color-primary-dark);
  border-color: var(--color-primary-dark);
}
.repo-list__btn .el-icon {
  font-size: 14px;
}
.repo-list__guide-note {
  margin: 0;
  max-width: 560px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.repo-list__guide-note--waiting {
  color: var(--color-primary);
}
/* UAC 提权提醒:这不是普通提示,而是"不照做就会失败"的前提条件
   (不点「是」→ MSI 退出码 1602),所以给底色 + 警示色 + 左对齐,
   别让它混在灰色小字里被跳过。 */
.repo-list__guide-note--warn {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  max-width: 620px;
  padding: 8px 12px;
  text-align: left;
  border-radius: 6px;
  color: var(--color-warning);
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.repo-list__guide-note--warn .el-icon {
  flex: none;
  margin-top: 2px;
  font-size: 14px;
}

/* ── 搜索框 ───────────────────────────────────────────────────────── */
.repo-list__search {
  position: relative;
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: 10px;
  background: var(--bg-panel);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.repo-list__search:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}
.repo-list__search-icon {
  flex-shrink: 0;
  margin-right: var(--spacing-base);
  color: var(--text-secondary);
  font-size: var(--font-size-md);
}
.repo-list__search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: var(--font-size-base);
  color: var(--text-primary);
}
.repo-list__search-input::placeholder {
  color: var(--text-tertiary);
}
.repo-list__search-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: var(--spacing-sm);
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--bg-component-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  line-height: 1;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.repo-list__search-clear:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}

/* ── 提示条 ───────────────────────────────────────────────────────── */
.repo-list__banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-base);
  background: var(--tint-danger-06);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.5;
}
.repo-list__banner .el-icon {
  flex-shrink: 0;
  color: var(--el-color-warning);
}
.repo-list__banner--info {
  background: var(--tint-primary-08);
}
.repo-list__banner--info .el-icon {
  color: var(--color-primary);
}

/* ── 卡片网格 ─────────────────────────────────────────────────────── */
.repo-list__items {
  list-style: none;
  margin: calc(-1 * var(--spacing-xs));
  padding: var(--spacing-xs);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--repo-card-min, 420px), 100%), 1fr));
  align-content: start;
  gap: var(--spacing-md);
}
.repo-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-sm) var(--spacing-base);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.repo-card:hover {
  background: var(--bg-component-hover);
  border-color: var(--border-color);
}
.repo-card:active {
  background: var(--tint-primary-08);
}
.repo-card__btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.repo-card__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-base);
}
.repo-card__icon {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 16px;
}
.repo-card__name {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
/* 第一行仓库名:短、必须能读全,不缩 */
.repo-card__name-base {
  font-weight: var(--font-weight-medium, 500);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 第二行放描述(没有描述时退回 fullName):次要信息,允许省略 */
.repo-card__name-path {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo-card__tags {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.repo-card__tag {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  /* 与「最近项目」的 .dir-card__tag 用同一套尺寸:两个 Tab 切换时徽标高度一致 */
  line-height: 1.4;
  padding: 2px var(--spacing-sm);
  font-size: var(--font-size-xs);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}
.repo-card__tag .el-icon {
  font-size: var(--font-size-xs);
}
.repo-card__tag--plain {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}
.repo-card__tag--star {
  background: var(--tint-primary-08);
  color: var(--color-primary);
}
/* 操作按钮:静止时不占位,hover 卡片时与徽标交叉淡入 —— 与「最近项目」卡片同一套做法 */
.repo-card__actions {
  position: absolute;
  right: var(--spacing-base);
  top: 50%;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}
.repo-card:hover .repo-card__actions,
.repo-card:focus-within .repo-card__actions {
  opacity: 1;
  pointer-events: auto;
}
.repo-card:hover .repo-card__tags,
.repo-card:focus-within .repo-card__tags {
  opacity: 0;
}
.repo-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.repo-card__action:hover {
  color: var(--color-primary);
  background: var(--tint-primary-12);
}
.repo-card__action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.repo-list__footnote {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}
.repo-list__footnote .el-icon {
  color: var(--el-color-success);
  font-size: 12px;
}
</style>
