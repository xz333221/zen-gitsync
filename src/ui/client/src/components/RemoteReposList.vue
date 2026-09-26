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
  FolderAdd,
  Key,
  Link,
  Loading,
  Refresh,
  Search,
  Star,
  WarningFilled,
} from '@element-plus/icons-vue'
import { storeToRefs } from 'pinia'
import { FilePickerModal as FilePicker } from 'local-file-picker/client'
import { $t } from '@/lang/static'
import { useConfigStore } from '@/stores/configStore'
import { useLocaleStore } from '@/stores/localeStore'
import { loadLocalClones, rescanLocalClones } from '@/utils/localClones'
import { launchGuiInNewTab } from '@/composables/useDirectoryOpenActions'
import { toRepoKey, toSshUrl } from '@/utils/remoteUrl'
import {
  dropRemoteReposCache,
  readRemoteReposCache,
  writeRemoteReposCache,
} from '@/utils/remoteReposCache'

/** 服务端 /api/remote-repos 的仓库条目 */
interface RemoteRepo {
  name: string
  fullName: string
  description: string
  isPrivate: boolean
  isFork: boolean
  language: string | null
  stars: number
  forks: number
  license: string | null
  defaultBranch: string | null
  updatedAt: string | null
  /** 最近推送。排序默认看它 —— "更新" 在有 wiki/issue 活动时也会变,
   *  推送时间才代表"代码最近动过" */
  pushedAt: string | null
  createdAt: string | null
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

/** 排序方式。
 *
 *  为什么要显式排序:两个平台的 CLI 原始顺序**并不一致** —— gh 按推送时间倒序,
 *  gitee 按 owner/name 字母序(它的 --sort 默认值是 full_name)。同一个面板、
 *  切个 Tab 就换一种排法,用户没法形成预期。这里统一在前端排,顺带把选择权交出去。
 *
 *  默认「最近推送」:仓库列表最常被用来回答"我最近在动哪个项目"。 */
type SortKey = 'pushed' | 'created' | 'stars' | 'name'

const SORT_OPTIONS: Array<{ value: SortKey, labelKey: string }> = [
  { value: 'pushed', labelKey: '@REPOLIST:最近推送' },
  { value: 'created', labelKey: '@REPOLIST:最近创建' },
  { value: 'stars', labelKey: '@REPOLIST:星标最多' },
  { value: 'name', labelKey: '@REPOLIST:仓库名' },
]

/**
 * 分组维度。
 *
 *  为什么需要:纯按时间平铺时,**同一个空间下的仓库会被打散在整屏里** ——
 *  账号下有 sync_space / flowdash / xz_web 好几个空间,每个空间又只有三五个仓库,
 *  想回答"我这个空间下都有哪些项目"得靠肉眼在几十张卡里捞(用户实测反馈)。
 *
 *  默认按工作空间分组。组间顺序跟随当前排序规则(即"最近有推送的空间排前面"),
 *  组内也是同一条规则 —— 分组不改变"谁更新",只把同一空间的收拢到一起。
 *  不想被分组打断"我最近在动哪个项目"的连贯视角时,切回不分组。
 */
type GroupKey = 'workspace' | 'none'

const GROUP_OPTIONS: Array<{ value: GroupKey, labelKey: string }> = [
  { value: 'workspace', labelKey: '@REPOLIST:按工作空间' },
  { value: 'none', labelKey: '@REPOLIST:不分组' },
]

/** 默认分支是这两个之一就不在卡片上占一行 —— 满屏 "main" 是没有信息量的噪音
 *  (与「★0 不显示」同一条原则)。 */
const COMMON_BRANCHES = ['main', 'master']

/** 日期容器的兜底:两个平台都给 ISO 串,解析不出来时按"没有这个时间"处理 */
function timeValue(value: string | null) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

/** 名称比较:统一小写再比 —— 和 gitee CLI 的字母序口径一致(它也按全名排),
 *  同时避免 ASCII 下 'Z' < 'a' 让大写开头的仓库名显得随机。
 *  不用 localeCompare:它依赖运行时 ICU,node 与浏览器可能给出不同顺序,
 *  排序结果会变得不可测。 */
function compareFullName(a: RemoteRepo, b: RemoteRepo) {
  const left = a.fullName.toLowerCase()
  const right = b.fullName.toLowerCase()
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** 安装后自动轮询:5 秒一次,最多 24 次(2 分钟)。
 *  与 ToolInstallDialog 同一档 —— 装包管理器跑完通常在这个区间内,
 *  超时后仍可手动「重新检测」。 */
const POLL_INTERVAL_MS = 5000
const POLL_MAX_TRIES = 24

/** 登录的轮询窗口给得长得多:一键登录只是把终端窗口开起来,真正的问答
 *  (选平台/协议、跳浏览器授权、粘贴 token)是用户在终端里手动走完的,
 *  光跳浏览器那一步就可能好几分钟。2 分钟远不够。 */
const LOGIN_MAX_TRIES = 120

/**
 * 缓存多久算"还新鲜"。
 *
 *   比这新 → 切回 Tab 直接拿缓存渲染，一个请求都不发（列表页最舒服的状态）；
 *   比这旧 → 先把缓存画出来（不转圈），再在后台静默重拉一遍，拿到新数据替换 ——
 *           也就是 stale-while-revalidate。这样"刚从别处推了代码"不会一直停在旧快照上，
 *           用户也不必为了刷新干等一次 CLI。
 * 用户主动点的「刷新」「重试」「重新检测」不受这个 TTL 限制，永远真的去拉。
 */
const CACHE_TTL_MS = 60_000

/**
 * 上次拉到的 payload，按平台各存一份。
 *
 * 为什么需要它：App.vue 里两个仓库面板是 v-if —— 切走就卸载、切回就重新挂载，
 * 每次 onMounted 都会重新跑一遍 load()。用户看到的就是"每点一次 Tab 就转一次圈"。
 * 而这一次 load() 背后是服务端起一个 `gh repo list --json ...` / `gitee repos` 子进程
 * 再等网络往返，秒级；仓库列表本身几分钟内几乎不会变。为它每次都等一遍并不划算。
 *
 * 缓存的实体在 utils/remoteReposCache.ts —— 必须放独立模块，写在 <script setup> 里的
 * Map 是每个实例一份，切 Tab 重建就没了（见那个文件头）。
 */
// 挂载那一刻读一次就够：这个组件只在挂载时决定"要不要立刻发请求"，
// 之后自己拉回来的数据会写回缓存，不需要在渲染过程中反复读
const cached = readRemoteReposCache<RemoteReposPayload>(props.provider)
const data = ref<RemoteReposPayload | null>(cached?.payload ?? null)
// 初值：没有缓存时必须先当作"加载中" —— onMounted 触发首次加载之前会先渲染一帧，
// 那时 data 还是 null，若这里是 false，'loading/error' 的判定会先给出 error，
// 界面会闪一下红字。有缓存时反过来，初值必须是 false —— 直接拿缓存画列表，
// 闪一下 loading 就白缓存了。
const isLoading = ref(!cached)
const loadError = ref('')
const searchQuery = ref('')
const sortKey = ref<SortKey>('pushed')
const groupKey = ref<GroupKey>('workspace')

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

/** 头部数量提示。搜索时先说"命中了几个" —— 只说总数会让人以为搜索没生效
 *  (搜完还是"共 70 个仓库",看不出筛掉了多少)。 */
const countHint = computed(() => {
  const total = data.value?.repos.length || 0
  if (searchQuery.value.trim()) {
    return $t('@REPOLIST:匹配 {matched} / 共 {total} 个仓库', { matched: items.value.length, total })
  }
  return $t('@REPOLIST:共 {count} 个仓库', { count: total })
})

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
  const filtered = q
    ? list.filter((repo) =>
      repo.name.toLowerCase().includes(q)
      || repo.fullName.toLowerCase().includes(q)
      || (repo.description || '').toLowerCase().includes(q)
    )
    : list

  // 复制一份再排:list 是响应式源数据,原地 sort 会连着 data.value.repos 一起改,
  // 排序切换后就再也回不到"服务端给的原始顺序"了。
  const sorted = [...filtered]
  sorted.sort((a, b) => {
    switch (sortKey.value) {
      case 'created':
        return timeValue(b.createdAt) - timeValue(a.createdAt) || compareFullName(a, b)
      case 'stars':
        return b.stars - a.stars || compareFullName(a, b)
      case 'name':
        return compareFullName(a, b)
      case 'pushed':
      default:
        // 有的仓库还没推过(pushedAt 为空),退回 updatedAt;两个都没有 = 排到最后
        return timeValue(b.pushedAt || b.updatedAt) - timeValue(a.pushedAt || a.updatedAt)
          || compareFullName(a, b)
    }
  })
  return sorted
})

/** 一个分组(一个工作空间下的仓库) */
interface RepoGroup {
  /** 归一化后的分组键(小写),只用于 v-for 的 key */
  key: string
  /** 取第一次出现的原样写法展示 —— 空间名在平台上是大小写敏感的 */
  owner: string
  repos: RemoteRepo[]
}

/**
 * 从 `owner/name` 里取 owner(gitee 叫「空间/组织」,github 叫 owner)。
 *
 * 拿不到 `/` 的异常数据不硬编一个假空间名,而是**退回全名当键** ——
 * 那样每个异常仓库自成一组,至少不会把无关的仓库塞进同一个组里。
 */
function ownerOf(repo: RemoteRepo) {
  const slash = repo.fullName.indexOf('/')
  return slash > 0 ? repo.fullName.slice(0, slash) : repo.fullName
}

/**
 * 分组结果。输入是**已经过滤 + 排好序**的 items,所以:
 *   - 搜索命中的仓库照样按空间分组(搜 "book" 也想看清它属于哪个空间)
 *   - 组内顺序 = 当前排序规则;组间顺序 = 组内排最前的那个仓库的位次
 *     (Map 保序),也就是"最近活跃的空间排前面",和组内用的是同一条规则
 */
const groups = computed<RepoGroup[]>(() => {
  const list = items.value
  if (groupKey.value === 'none') return [{ key: '__all__', owner: '', repos: list }]

  const byOwner = new Map<string, RepoGroup>()
  for (const repo of list) {
    const owner = ownerOf(repo)
    const key = owner.toLowerCase()
    const group = byOwner.get(key)
    if (group) group.repos.push(repo)
    else byOwner.set(key, { key, owner, repos: [repo] })
  }
  return [...byOwner.values()]
})

/** 只有一个组时不渲染组头 —— 组头是用来**分开不同空间**的,只有一组时
 *  它只是把每张卡片的前缀重复一遍(不分组时同理恒为 false)。 */
const showGroupHeaders = computed(() => groups.value.length > 1)

/**
 * 卡片第二行。
 *
 * 分组态下组头已经写明空间名,再逐张卡重复 `owner/name` 是纯噪音 ——
 * 这时只显示描述,没描述就整行不渲染(与"没有信息的项不留占位"同一条原则)。
 * 不分组 / 只有一个组时保持原样,退回 fullName 兜底 —— 那种情况下
 * 第二行仍是"这张卡是谁"的唯一线索。
 */
function repoSubtitle(repo: RemoteRepo) {
  if (showGroupHeaders.value) return repo.description || ''
  return repo.description || repo.fullName
}

/**
 * 卡片第三行的元信息:最近推送 / Fork 数 / 默认分支 / 许可证。
 *
 * 全是**可选**项 —— 缺哪条就少哪条,不留空占位。这样同一屏里每张卡片
 * 带的信息量不同,但读到的每一段都是有意义的(而不是一片 "0 / main / 无")。
 */
function repoMeta(repo: RemoteRepo) {
  const parts: string[] = []
  const date = formatDate(repo.pushedAt || repo.updatedAt)
  if (date) parts.push($t('@REPOLIST:更新于 {date}', { date }))
  if (repo.forks > 0) parts.push($t('@REPOLIST:{count} 个 Fork', { count: repo.forks }))
  if (repo.defaultBranch && !COMMON_BRANCHES.includes(repo.defaultBranch)) {
    parts.push($t('@REPOLIST:分支 {branch}', { branch: repo.defaultBranch }))
  }
  if (repo.license) parts.push(repo.license)
  return parts.join(' · ')
}

/* ── 卡片上的两个视觉件:左侧字母块 / 语言色点 ─────────────────────── */

/**
 * 字母块的色相只从这 6 档里取,不铺满整圈 360°。
 *
 *  为什么不是随机色相:一屏几十个块,色相转满一圈就成了调色盘,反而更乱 ——
 *  这里要的是"能区分",不是"够鲜艳"。档位少还有个好处:相邻分组的块常撞色,
 *  看上去仍是同一套色系,而不是"同一屏里塞了好几套 UI"。
 */
const AVATAR_HUES = [217, 199, 168, 262, 32, 340]

/** 名字 → 稳定的色相档位:同一张卡刷新 / 换排序 / 换分组都不变色 */
function avatarHue(seed: string) {
  let h = 0
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 9973
  return AVATAR_HUES[h % AVATAR_HUES.length]
}

/** 字母块里放什么:仓库名 / 空间名的首字符。按码点取,别把 emoji 切成半个 */
function avatarInitial(seed: string) {
  return [...seed][0]?.toUpperCase() ?? '#'
}

/**
 * 语言 → 官方品牌色(GitHub linguist 那一套)。
 *
 *  只收录常出现的几种:算不出准确颜色的语言(比如 gitee 会返回的 "Node.js")
 *  退回中性灰点 —— 宁可少一个色点,也不要给一个错的色点。
 */
const LANGUAGE_COLORS: Record<string, string> = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Vue: '#41b883',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Less: '#1d365d',
  Python: '#3572a5',
  Java: '#b07219',
  Go: '#00add8',
  Rust: '#dea584',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  PHP: '#4f5d95',
  Ruby: '#701516',
  Shell: '#89e051',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  Dart: '#00b4ab',
  Lua: '#000080',
  Markdown: '#083fa1',
}

function languageColor(language: string) {
  return LANGUAGE_COLORS[language] ?? 'var(--text-tertiary)'
}

/** 卡片的悬浮提示:比卡片多给"本地克隆到哪 / 创建时间 / 默认分支 / 许可证"——
 *  卡片上放不下的次要信息都在这里,不用点开浏览器就能核对。
 *  本地克隆那句排在描述前面:决定"要不要点克隆"时,它比仓库简介有用。 */
function repoTooltip(repo: RemoteRepo) {
  const lines = [repo.fullName]
  const localPath = clonedPathOf(repo)
  if (localPath) {
    lines.push($t('@REPOLIST:本地已克隆：{path}', { path: localPath }))
    // 悬浮提示是这条快捷键唯一的说明处：徽标在 hover 时会淡出给操作按钮让位，
    // 所以没法把提示挂在徽标上
    lines.push($t('@REPOLIST:按住 Ctrl 点击用 g ui 打开'))
  }
  if (repo.description) lines.push(repo.description)
  const pushed = formatDate(repo.pushedAt)
  const created = formatDate(repo.createdAt)
  if (pushed) lines.push($t('@REPOLIST:最近推送 {date}', { date: pushed }))
  if (created) lines.push($t('@REPOLIST:创建于 {date}', { date: created }))
  if (repo.defaultBranch) lines.push($t('@REPOLIST:默认分支 {branch}', { branch: repo.defaultBranch }))
  if (repo.license) lines.push($t('@REPOLIST:许可证 {license}', { license: repo.license }))
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

/**
 * 拉一次仓库列表,成功就顺手写进 payloadCache。
 *
 * `silent` 是给"屏幕上已经有东西可看"的场合用的(切回 Tab 时的后台重拉):
 * 不翻 isLoading(不闪转圈),失败也不把 data 清空 —— 否则一次网络抖动
 * 会把已经画好的列表直接换成错误屏,而用户什么都没做。
 * 用户主动点的「刷新」「重试」「重新检测」走非静默:该给的转圈反馈要给,
 * 失败了也要如实变成错误屏,不能拿旧数据糊弄过去。
 */
async function load(options: { silent?: boolean } = {}) {
  const silent = options.silent === true
  if (!silent) isLoading.value = true
  try {
    const res = await fetch(`/api/remote-repos?provider=${props.provider}`, { cache: 'no-store' })
    const payload = await readJson(res)
    if (!res.ok || !payload?.success) {
      loadError.value = payload?.error || $t('@REPOLIST:仓库列表加载失败')
      if (!silent) {
        data.value = null
        dropRemoteReposCache(props.provider)
      }
      return
    }
    loadError.value = ''
    data.value = payload as RemoteReposPayload
    writeRemoteReposCache(props.provider, data.value)
    // 等到目标状态就收工:退出"进行中"态并停表 —— 否则这个标志会一直挂着,
    // 下次回到这一屏时按钮还显示"安装中..."
    if (pollUntil?.(data.value)) {
      finishAction()
      stopPolling()
    }
  } catch (error) {
    loadError.value = (error as Error).message || $t('@REPOLIST:仓库列表加载失败')
    if (!silent) {
      data.value = null
      dropRemoteReposCache(props.provider)
    }
  } finally {
    // 静默重拉不动 isLoading —— 它可能是别处(用户点的刷新)设上的,别替人收尾
    if (!silent) isLoading.value = false
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

// ── 本地已克隆 ──────────────────────────────────────────────────────────────
// 卡片上的「已克隆」徽标：这个仓库在本地某个常用目录里已经有克隆了。
//
// 判据是**地址对上**，不是目录名相同 —— 本地目录叫什么、克隆在哪个盘，和仓库名
// 都不必一致（把仓库克隆成别的目录名是常事），只有 origin 指向谁才是可靠依据。
// 归一化规则在 utils/remoteUrl.ts 的 toRepoKey，这里只查表。
//
// 它是**补充信息**：拿不到（服务端还没重启、接口报错）就只是没有徽标，不影响
// 列表、不弹错。缓存与并发去重都在 utils/localClones.ts —— 必须是独立模块，
// 写在组件里的模块级变量随 Tab 切换重建就没了（见那个文件头）。
const localClones = ref<Record<string, string>>({})

/** 该仓库本地是否已有克隆？有则返回本地目录（给 tooltip 用），没有返回空串 */
function clonedPathOf(repo: RemoteRepo) {
  const key = toRepoKey(repo.url)
  return key ? localClones.value[key] || '' : ''
}

/** 拉一份「本地已克隆」映射。失败静默：徽标有就有、没有就没有。
 *  force 用于"刚克隆完一个仓库"—— 服务端那一刻已就地登记了它，这一趟只取回新快照 */
async function refreshLocalClones(force = false) {
  localClones.value = await loadLocalClones(force)
}

/**
 * 「刷新」：重拉仓库列表之外，还让服务端**重扫一遍本机仓库**。
 *
 * 为什么刷新要带上重扫：本机仓库清单是落盘缓存（TTL 10 分钟），而用户完全可能
 * 在终端里 clone 完再回来点刷新 —— 不重扫的话那张卡片还是没徽标，看着就像
 * "刷新没生效"。重扫要十几秒，所以**不 await**：列表先出来，徽标扫完自己补上。
 */
function refreshAll() {
  void rescanLocalClones().then((map) => { localClones.value = map })
  return load()
}

/**
 * Ctrl+点击「已克隆」徽标 → 在本地那个目录里**新开一个终端标签页跑 `g ui`**。
 *
 * 走 launchGuiInNewTab（useDirectoryOpenActions）：它复用服务端的 /api/open-new-tab-gui，
 * 那边负责平台差异（Windows 走 `start /D`、macOS 走 Terminal.app、Linux 走 gnome-terminal）
 * 并剥掉 PORT，让新实例自己挑空闲端口 —— 所以不会和当前这个实例抢 5545。
 *
 * 只给 error 提示、不给成功提示：新窗口弹出来本身就是反馈，再补一句 toast 是噪音
 * （与 RecentDirectoriesList 的「在新标签页打开」保持一致）。
 */
async function openClonedInGuiUi(dirPath: string) {
  if (!dirPath) return
  const result = await launchGuiInNewTab(dirPath)
  if (!result.success) {
    ElMessage.error(result.error || $t('@REPOLIST:无法在该目录启动 g ui'))
  }
}

/**
 * 卡片点击。
 *
 * - 普通点击 = 在浏览器打开仓库主页（一直以来的行为，不变）
 * - Ctrl/Cmd+点击 **且本地已有克隆** = 到那个目录里新开标签页跑 `g ui`
 *
 * 为什么挂在整张卡片而不是「已克隆」徽标上：徽标在卡片 hover 时会淡出给右侧操作
 * 按钮让位（交叉淡入那一套），做成点击区就等于让它在最该被点的时刻消失。
 *
 * 没克隆时 Ctrl+点击退回原行为 —— 没有本地目录可去，不该只是"这次点击没反应"。
 */
function onCardClick(repo: RemoteRepo, event: MouseEvent) {
  const localPath = clonedPathOf(repo)
  if (localPath && (event.ctrlKey || event.metaKey)) {
    void openClonedInGuiUi(localPath)
    return
  }
  openUrl(repo.url)
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

const configStore = useConfigStore()
const { currentLocale } = storeToRefs(useLocaleStore())

/** 文件选择器的主题跟随界面主题(与 DirectorySelector / MindmapView 同一套判断) */
const isDark = computed(() => {
  const t = configStore.theme
  if (t === 'dark') return true
  if (t === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
})

// ── 克隆到文件夹 ────────────────────────────────────────────────────────
// 交互:点卡片上的「克隆到文件夹」→ 选一个父目录 → 在它下面建出以仓库名命名的
// 子目录(与命令行 `git clone` 的落点规则一致)。
//
// 用哪个地址:SSH(由 utils/remoteUrl.ts 从仓库页地址推导)。理由在凭据 ——
// 用户在两个平台的 SSH key 都已经配好,而 HTTPS 会去撞 Git Credential Manager
// 的图形弹窗,服务端子进程又没有 TTY,弹不出来就会一路挂到超时。
//
// 推导不出 SSH 地址的仓库干脆不渲染这个按钮(与「复制 SSH 地址」同一条件):
// 宁可少给一个入口,也不给一个点下去必然失败的按钮。
const clonePickerVisible = ref(false)
/** 正在克隆的仓库 fullName;null = 当前没有进行中的克隆 */
const cloningRepo = ref<string | null>(null)
const cloneTargetRepo = ref<RemoteRepo | null>(null)

function openClonePicker(repo: RemoteRepo) {
  cloneTargetRepo.value = repo
  clonePickerVisible.value = true
}

/** local-file-picker 的 confirm 回调:paths[0] 就是选中的父目录绝对路径 */
async function onCloneDirConfirm(paths: string[]) {
  clonePickerVisible.value = false
  const repo = cloneTargetRepo.value
  cloneTargetRepo.value = null
  const parentDir = paths?.[0]
  if (!repo || !parentDir) return

  const url = toSshUrl(repo.url)
  if (!url) {
    ElMessage.error($t('@REPOLIST:无法解析该仓库的克隆地址'))
    return
  }

  cloningRepo.value = repo.fullName
  try {
    const response = await fetch('/api/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, parentDir }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok || !result?.success) {
      // 后端把 git 的最后一句话原样带出来了(目标已存在 / 认证失败 / 网络不通),
      // 直接显示 —— 它比任何"克隆失败"的笼统说法都有用
      ElMessage.error(result?.error || $t('@REPOLIST:克隆失败'))
      return
    }
    const clonedPath = String(result.path || '')
    ElMessage.success($t('@REPOLIST:已克隆到 {path}', { path: clonedPath }))
    // 刚克隆出来的仓库立刻标「已克隆」：服务端在 clone 成功那一刻就把它登记进
    // 本机仓库清单了，这一趟 force 只取回新快照（不重扫盘，几十毫秒）。
    // 少了这一步就要等下一次全盘扫（十几秒）或 TTL 过期 —— 而那十几秒正是
    // 用户盯着这张卡看的时刻，看起来就像"功能没生效"。
    void refreshLocalClones(true)
    // 克隆完顺手打开那个目录：用户接下来八成要进去，而它可能被建在一个
    // 刚选的、他自己都不熟的路径下
    void openDirectory(clonedPath)
  } catch (error) {
    ElMessage.error((error as Error).message || $t('@REPOLIST:克隆失败'))
  } finally {
    cloningRepo.value = null
  }
}

/**
 * 在系统文件管理器里打开一个目录(克隆完成后用)。
 *
 * 走服务端的 /api/open_directory(它用 `open` 包,跨平台),前端不拼 shell 命令 ——
 * 与"命令一律由服务端从白名单给"同一条原则。
 * 失败只给一句 warning:克隆本身已经成功了,打开文件夹是顺手的下一步,
 * 报成 error 会让用户以为克隆出了问题。
 */
async function openDirectory(dirPath: string) {
  if (!dirPath) return
  try {
    const res = await fetch('/api/open_directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dirPath }),
    })
    const data = await readJson(res).catch(() => null)
    if (!data?.success) ElMessage.warning(data?.error || $t('@REPOLIST:打开文件夹失败'))
  } catch (error) {
    ElMessage.warning((error as Error).message || $t('@REPOLIST:打开文件夹失败'))
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

onMounted(() => {
  // 「已克隆」是独立的一份数据(本地磁盘 → 本地接口),与仓库列表的缓存无关:
  // 放在下面的早退**之前**,保证"列表直接拿缓存画出来"时徽标也能补上。
  // 它自带请求级去重,两个 Tab 同时挂载也只会真发一次。
  void refreshLocalClones()

  // 缓存还新鲜 → 一个请求都不发。首帧直接就是列表,和上次离开这一屏时一模一样
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return
  // 有缓存但过期了 → 先把缓存画出来,再在后台静默重拉(拉失败也不打断用户);
  // 没缓存(第一次切到这一屏)→ 老老实实进加载态
  void load({ silent: Boolean(cached) })
})
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
          {{ countHint }}
        </span>
        <button
          v-if="view === 'list' || view === 'error'"
          type="button"
          class="repo-list__action"
          :disabled="isLoading"
          :title="$t('@REPOLIST:重新拉取仓库列表')"
          @click="refreshAll()"
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
      <button type="button" class="repo-list__btn" :disabled="isLoading" @click="load()">
        {{ $t('@REPOLIST:重试') }}
      </button>
    </div>

    <!-- ⑤ 仓库列表 -->
    <template v-else>
      <div class="repo-list__toolbar">
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

        <!-- 分组。同款原生 select,与排序并排 —— 两个都是"换个看法"的开关,
             同一行里读起来是一组控件。放排序**左边**:排序是最常用的那个,
             位置保持不动,不会因为多了个分组而被挤走。 -->
        <label class="repo-list__control">
          <span class="repo-list__control-label">{{ $t('@REPOLIST:分组') }}</span>
          <select v-model="groupKey" class="repo-list__group-select" :aria-label="$t('@REPOLIST:分组方式')">
            <option v-for="option in GROUP_OPTIONS" :key="option.value" :value="option.value">
              {{ $t(option.labelKey) }}
            </option>
          </select>
        </label>

        <!-- 排序。用原生 select 而不是 el-select:同一个面板里的搜索框就是原生 input,
             两处控件高度/边框/圆角可以完全对齐;原生下拉也不会在窄宽度下被 popper 挤歪。
             (深色主题下 option 的可读性由 styles/common.scss 的 `select option` 规则兜底。) -->
        <label class="repo-list__control">
          <span class="repo-list__control-label">{{ $t('@REPOLIST:排序') }}</span>
          <select v-model="sortKey" class="repo-list__sort-select" :aria-label="$t('@REPOLIST:排序方式')">
            <option v-for="option in SORT_OPTIONS" :key="option.value" :value="option.value">
              {{ $t(option.labelKey) }}
            </option>
          </select>
        </label>
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

      <div v-else class="repo-list__items" :style="{ '--repo-card-min': CARD_MIN_WIDTH }" :aria-label="title">
        <section v-for="group in groups" :key="group.key" class="repo-group" :aria-label="group.owner || title">
          <!-- 组头:空间名 + 该空间下的仓库数。只有一个组(含"不分组")时整块不渲染 ——
               那时它只是把每张卡片的前缀重复一遍。 -->
          <div v-if="showGroupHeaders" class="repo-group__head">
            <span
              class="repo-group__avatar"
              :style="{ '--avatar-hue': avatarHue(group.owner) }"
              aria-hidden="true"
            >{{ avatarInitial(group.owner) }}</span>
            <span class="repo-group__owner">{{ group.owner }}</span>
            <span class="repo-group__count">{{ group.repos.length }}</span>
          </div>

          <ul class="repo-group__grid">
            <li
              v-for="repo in group.repos"
              :key="repo.fullName"
              class="repo-card"
              :style="{ '--avatar-hue': avatarHue(repo.name) }"
              :title="repoTooltip(repo)"
            >
              <button
                type="button"
                class="repo-card__btn"
                :aria-label="$t('@REPOLIST:在浏览器中打开 {name}', { name: repo.fullName })"
                @click="onCardClick(repo, $event)"
              >
                <!-- 字母块:纯装饰(名字本身就在右边),但它是"快速定位到某张卡"的
                     锚点 —— 整屏几十张同构卡片,光靠文字扫得很慢 -->
                <span class="repo-card__avatar" aria-hidden="true">{{ avatarInitial(repo.name) }}</span>
                <span class="repo-card__name">
                  <span class="repo-card__name-base">{{ repo.name }}</span>
                  <!-- 第二行:描述。分组态下空间名已经在组头上,这里不再重复 fullName,
                       没描述就整行不渲染;不分组时退回 fullName 兜底 -->
                  <span v-if="repoSubtitle(repo)" class="repo-card__name-path">{{ repoSubtitle(repo) }}</span>
                  <!-- 第三行:最近推送 / Fork / 默认分支 / 许可证。全空时整行不渲染 -->
                  <span v-if="repoMeta(repo)" class="repo-card__meta">{{ repoMeta(repo) }}</span>
                </span>
                <span class="repo-card__tags">
                  <!-- 「已克隆」排在最前:它是"本地已经有了"的结论,比 Fork / 私有 /
                       语言这类仓库自身的属性更该被一眼看到(尤其在点克隆按钮之前)。
                       Ctrl+点击整张卡片 = 到那个目录里跑 g ui(见 onCardClick);
                       徽标自己不做点击区 —— hover 时它会淡出给操作按钮让位。 -->
                  <span v-if="clonedPathOf(repo)" class="repo-card__tag repo-card__tag--cloned">
                    <el-icon aria-hidden="true"><CircleCheck /></el-icon>
                    {{ $t('@REPOLIST:已克隆') }}
                  </span>
                  <span v-if="repo.isFork" class="repo-card__tag repo-card__tag--plain">{{ $t('@REPOLIST:Fork') }}</span>
                  <span v-if="repo.isPrivate" class="repo-card__tag repo-card__tag--plain">{{ $t('@REPOLIST:私有') }}</span>
                  <!-- 语言色点用官方品牌色,算不出颜色的语言退回中性灰点(见 languageColor) -->
                  <span v-if="repo.language" class="repo-card__tag repo-card__tag--plain">
                    <span
                      class="repo-card__lang-dot"
                      :style="{ background: languageColor(repo.language) }"
                      aria-hidden="true"
                    />{{ repo.language }}
                  </span>
                  <!-- 星标只在有人 star 时才出现:满屏 ★0 是没有信息量的噪音 -->
                  <span v-if="repo.stars > 0" class="repo-card__tag repo-card__tag--star">
                    <el-icon aria-hidden="true"><Star /></el-icon>{{ repo.stars }}
                  </span>
                </span>
              </button>
              <span class="repo-card__actions">
                <button
                  v-if="toSshUrl(repo.url)"
                  type="button"
                  class="repo-card__action"
                  :disabled="cloningRepo === repo.fullName"
                  :title="$t('@REPOLIST:克隆到文件夹')"
                  :aria-label="$t('@REPOLIST:克隆 {name} 到指定文件夹', { name: repo.fullName })"
                  @click.stop="openClonePicker(repo)"
                >
                  <el-icon
                    :class="{ 'is-spinning': cloningRepo === repo.fullName }"
                    aria-hidden="true"
                  >
                    <Loading v-if="cloningRepo === repo.fullName" />
                    <FolderAdd v-else />
                  </el-icon>
                </button>
                <button
                  type="button"
                  class="repo-card__action"
                  :title="$t('@REPOLIST:复制 HTTPS 地址')"
                  :aria-label="$t('@REPOLIST:复制 HTTPS 地址 {name}', { name: repo.fullName })"
                  @click.stop="copyText(repo.url, $t('@REPOLIST:HTTPS 地址已复制'))"
                >
                  <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
                </button>
                <button
                  v-if="toSshUrl(repo.url)"
                  type="button"
                  class="repo-card__action"
                  :title="$t('@REPOLIST:复制 SSH 地址')"
                  :aria-label="$t('@REPOLIST:复制 SSH 地址 {name}', { name: repo.fullName })"
                  @click.stop="copyText(toSshUrl(repo.url), $t('@REPOLIST:SSH 地址已复制'))"
                >
                  <el-icon aria-hidden="true"><Key /></el-icon>
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
        </section>
      </div>

      <p v-if="items.length > 0 && !searchQuery" class="repo-list__footnote">
        <el-icon aria-hidden="true"><CircleCheck /></el-icon>
        {{ $t('@REPOLIST:点击卡片在浏览器中打开仓库主页') }}
      </p>
    </template>

    <!-- 克隆目标文件夹选择（local-file-picker）。选中的是**父目录** ——
         仓库会在它下面建出以仓库名命名的子目录，与命令行 git clone 一致。
         「全局」开关的状态与其它入口共用 ui.pickerGlobalSearch（记住上次的选择）。 -->
    <FilePicker
      :visible="clonePickerVisible"
      mode="directory"
      :theme="isDark ? 'dark' : 'light'"
      :locale="currentLocale"
      :default-global-search="configStore.ui.pickerGlobalSearch"
      @global-search-change="(active: boolean) => { configStore.ui.pickerGlobalSearch = active }"
      @close="clonePickerVisible = false"
      @confirm="onCloneDirConfirm"
    />
  </div>
</template>

<style scoped>
/* 外壳沿用「最近项目」面板的形态(卡片化 + 标题行 + 内部滚动),
   两个 Tab 之间切换时视觉不跳。 */
/* 组头是 sticky 的,而 scoped 样式给子元素加的 data 属性会挡住
   `html.dark .repo-card__avatar` 这类选择器 —— 深色下的字母块配色写在
   :global 里,靠 .repo-list 这个根类限定作用域,不会漏到别的面板。 */
:global(html.dark .repo-list .repo-card__avatar),
:global(html.dark .repo-list .repo-group__avatar) {
  color: hsl(var(--avatar-hue, 217) 80% 74%);
  background: color-mix(in srgb, hsl(var(--avatar-hue, 217) 65% 62%) 22%, transparent);
}
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

/* ── 工具行:搜索 + 排序 ───────────────────────────────────────────── */
.repo-list__toolbar {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
}
/* 搜索框吃掉剩余宽度,排序固定宽 —— 窗口变窄时先压搜索框(它是可选的),
   不让排序被挤出去。 */
.repo-list__toolbar .repo-list__search {
  flex: 1 1 auto;
  min-width: 0;
}
.repo-list__control {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 13px;
  color: var(--text-secondary);
}
/* 两个下拉(分组 / 排序)共用一套外观:`__sort-select` 这个名字是历史原因保留的
   (验收脚本按它取排序下拉),分组那个用 `__group-select`,样式完全一致 */
.repo-list__sort-select,
.repo-list__group-select {
  height: 40px; /* 与搜索框同高:一行里两个控件视觉齐平 */
  padding: 0 28px 0 12px;
  border: 1px solid var(--border-color-light);
  border-radius: 10px;
  /* ⚠️ 必须是**不透明**的 --bg-container,不能用 --bg-panel:后者在深色主题下是
     rgba(255,255,255,.06),而原生下拉的弹出层是独立画布,会拿 select 自身的
     background-color 当底色 → 半透明叠在 UA 浅色兜底上 = 白底弹出层。
     (详细原理与回归脚本见 styles/common.scss 的 `select option` 注释) */
  background-color: var(--bg-container);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  /* 自绘 chevron,与工作台的 .wb-select 同一个图形,避免默认箭头的视觉噪音 */
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5l3 3 3-3' fill='none' stroke='%236b7280' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 12px 12px;
  -webkit-appearance: none;
  appearance: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.repo-list__sort-select:hover,
.repo-list__group-select:hover {
  border-color: var(--color-primary);
}
.repo-list__sort-select:focus,
.repo-list__group-select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
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

/* ── 卡片网格(按工作空间分段) ─────────────────────────────────────── */
/* 滚动容器本身不再是网格,而是"一叠分组":每个分组是一张独立的卡片网格。
   分组之间的间距比卡片之间大一档 —— 分组的边界先靠间隔读出来,组头再把它写明。 */
.repo-list__items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  /* 负 margin + 等量 padding:给卡片的 hover 描边留出空间,不让滚动容器把外扩的
     outline 裁掉(与原来作为 grid 时同一个处理) */
  margin: calc(-1 * var(--spacing-xs));
  padding: var(--spacing-xs);
}
.repo-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}
/* 组头:空间名 + 该空间下的仓库数,右边拉一条细线到容器边缘 ——
   一行就把"下面是这一组"的范围画清楚,不用色块或分隔条。
   吸顶(sticky):一个空间下仓库多时,滚到第二屏就不知道自己在哪一组了;
   组头贴着滚动容器顶走,`background` 必须是不透明的 —— 否则卡片会从字缝里透出来。 */
.repo-group__head {
  position: sticky;
  /* 滚动容器有 padding(= --spacing-xs),贴 0 会在头顶留一条透光的缝,
     所以往上顶同样的距离,再用等量 padding 把字放回来 */
  top: calc(-1 * var(--spacing-xs));
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) 2px;
  background: var(--bg-container);
}
.repo-group__head::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color-light);
}
.repo-group__owner {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.01em;
  color: var(--text-primary);
}
.repo-group__count {
  flex: none;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-component-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}
.repo-group__grid {
  list-style: none;
  margin: 0;
  padding: 0;
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
  /* 上下比原来(4px)宽:三行文字贴着上下边框会显得很挤,卡片本身却看不出原因 */
  padding: 10px var(--spacing-md);
  border: 1px solid var(--border-color-light);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  /* 静止时一层极浅的投影:让"这是张卡"在一屏灰底里自己成立,不靠描边硬撑 */
  box-shadow: var(--shadow-sm);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  transition: background var(--transition-fast), border-color var(--transition-fast),
    box-shadow var(--transition-fast), transform var(--transition-fast);
}
.repo-card:hover {
  background: var(--bg-component-hover);
  border-color: var(--tint-primary-45);
  box-shadow: var(--shadow-md);
  /* 抬 1px:和「最近项目」的卡片一样,状态变化只动背景与描边 ——
     位移仅 1px,不引起重排,但鼠标扫过一排卡时能明确"现在指着哪张" */
  transform: translateY(-1px);
}
.repo-card:active {
  background: var(--tint-primary-08);
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .repo-card:hover {
    transform: none;
  }
}

/* 左侧字母块:整屏几十张同构卡片,纯文字扫起来很慢 ——
   一个等宽的彩色块就是"定位到某张卡"的锚点,顺便把卡片左侧的留白用起来。
   色相由名字算(avatarHue),块与块之间能区分,整体仍是同一套色系。 */
.repo-card__avatar,
.repo-group__avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  font-weight: var(--font-weight-semibold);
  line-height: 1;
  user-select: none;
  color: hsl(var(--avatar-hue, 217) 72% 38%);
  background: color-mix(in srgb, hsl(var(--avatar-hue, 217) 70% 52%) 14%, transparent);
}
/* 深色下的配色见文件顶部 <style> 里的 :global 规则(scoped 的 data 属性
   会挡住 `html.dark .repo-card__avatar` 这种跨层选择器) */
.repo-card__avatar {
  width: 36px;
  height: 36px;
  font-size: 14px;
}
/* 组头的块比卡片小一档:它是分组的标点,不该和卡片本身抢注意力 */
.repo-group__avatar {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-md);
  font-size: 11px;
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
/* 第三行是元信息(最近推送 / Fork / 分支 / 许可证):比描述更低一档,同样单行省略 */
.repo-card__meta {
  font-size: var(--font-size-xs);
  color: var(--text-tertiary);
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
/* 语言色点:7px 的小圆,颜色由后端返回的语言名映射(见 LANGUAGE_COLORS)。
   比"语言名前面加个图标"轻,也比只写文字多一层可扫的颜色线索 */
.repo-card__lang-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.repo-card__tag--plain {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}
.repo-card__tag--star {
  background: var(--tint-primary-08);
  color: var(--color-primary);
}
/* 本地已有克隆:用成功色,和「这件事已经成了」的语义一致(它比 Fork / 私有
   更需要被看到)。底色取淡档,不做无边界强调 —— 它是个状态说明,不是荣誉标记,
   不该和星标抢同一块的注意力。 */
.repo-card__tag--cloned {
  background: var(--tint-success-14);
  color: var(--text-success);
}
/* 操作按钮:静止时不占位,hover 卡片时与徽标交叉淡入 —— 与「最近项目」卡片同一套做法。
   ⚠️ 用 `:has(操作按钮:focus-visible)` 而不是 `.repo-card:focus-within`:
   点击卡片主体按钮后 Chrome 会把焦点留在它上面,用 :focus-within 会让操作按钮
   在鼠标移出卡片后**一直挂着**(徽标也一直隐身);只有键盘 Tab 真正落到操作按钮上
   才需要让位。这个坑「最近项目」面板先踩过一遍,那边是同一个写法。 */
.repo-card__actions {
  position: absolute;
  right: var(--spacing-base);
  top: 50%;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
  opacity: 0;
  /* 隐藏时不可点,否则会在徽标位置吞掉本该落到卡片的点击 */
  pointer-events: none;
  transition: opacity var(--transition-fast);
}
.repo-card:hover .repo-card__actions,
.repo-card:has(.repo-card__action:focus-visible) .repo-card__actions {
  opacity: 1;
  pointer-events: auto;
}
.repo-card:hover .repo-card__tags,
.repo-card:has(.repo-card__action:focus-visible) .repo-card__tags {
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
.repo-card__action:hover:not(:disabled) {
  color: var(--color-primary);
  background: var(--tint-primary-12);
}
.repo-card__action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
/* 克隆进行中:图标从 FolderAdd 换成转圈的 Loading,同时禁掉重复点击 */
.repo-card__action:disabled {
  cursor: default;
  opacity: 0.6;
}
.repo-card__action .el-icon.is-spinning {
  animation: repo-card-spin 0.9s linear infinite;
}
@keyframes repo-card-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .repo-card__action .el-icon.is-spinning { animation: none; }
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
