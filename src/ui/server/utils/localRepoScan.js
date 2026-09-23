// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 扫出本机所有的 Git 仓库（及其 origin 地址）。
//
// 用途：远程仓库列表的「已克隆」徽标 —— 要回答"这个远程仓库本地已经有了吗"。
//
// 为什么是全盘扫，而不是只看「常用目录」：
//   "本地有没有" 和 "有没有进过最近打开的目录" 是两件事。刚克隆到别的盘、
//   或者很久以前克隆但从没在这个应用里打开过，都仍然是"本地已经有了"。
//   判据只能是磁盘本身。
//
// 全盘扫的代价（2026-09-23 本机实测，C:/ + D:/ 共 8613 个目录）：约 12 秒。
// 所以这里的策略是「缓存优先 + 后台刷新」：
//   - 结果落盘 ~/.zen-gitsync/local-repos.json，服务重启后仍然秒回上一次的结果；
//   - getLocalRepos() **永不阻塞**：先把手上这份交出去，过期了就在后台重扫；
//   - 用户刚克隆完一个仓库时走 rememberRepo() 就地登记，不必等重扫（12 秒里
//     界面上的徽标是空的，那正是用户最容易以为"没生效"的时刻）。
//
// 跳过名单是**性能保护，不是安全边界**：node_modules / AppData / Windows 这些
// 目录里几乎不会有用户自己 clone 的仓库，却占了目录总数的绝大部分 —— 实测跳过
// 之后 8613 个目录就能覆盖两个盘。名单刻意保守（只列"放仓库属于极罕见"的名字），
// 所以像 softwares 这种真放项目的目录不会被跳掉。
//
// 不跟随符号链接 / junction（Dirent.isDirectory() 对它们返回 false）：
// 一是避免目录环，二是 Windows 上 System32 之类的 junction 会把同一棵子树反复扫。
import fs from 'node:fs/promises'
import { accessSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import logger from './logger.js'
import { probeDirectoryOrigins } from './directoryGitState.js'

/** 扫描结果多久算过期。过期只是触发后台重扫，不影响本次返回 */
export const CACHE_TTL_MS = 10 * 60 * 1000

/** 遍历并发。readdir 是 IO 密集，开大一点收益明显（实测 64 路下两个盘 12 秒） */
const SCAN_CONCURRENCY = 64
/** 读 origin 的并发。每次是一个 git 子进程，不能像 readdir 那样开得猛 */
const ORIGIN_CONCURRENCY = 8
/** 深度上限：防御性，正常项目不会嵌这么深 */
const MAX_DEPTH = 16
/** 单次扫描时长上限：遇到网络盘/坏盘时不至于无限跑下去 */
const SCAN_BUDGET_MS = 3 * 60 * 1000

/**
 * 不往下走的目录名（小写比较）。见文件头"性能保护"那段。
 * 只写"放用户仓库属于极罕见"的名字 —— 宁可多扫，不可漏掉真仓库。
 */
export const SKIP_DIR_NAMES = new Set([
  // 依赖 / 构建产物（都在仓库内部，本来也不会下探，列在这里是防止仓库被拷出来当普通目录）
  'node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'target',
  // 包管理 / 语言工具链缓存（动辄几十万文件）
  '.npm', '.pnpm-store', '.yarn', '.gradle', '.m2', '.cargo', '.rustup', '.nuget',
  '.conda', 'anaconda3', 'miniconda3', 'site-packages', '__pycache__', 'venv', '.venv',
  '.cache', '.parcel-cache', '.turbo', '.next', '.nuxt', '.svelte-kit',
  // Windows 系统 / 用户配置
  'windows', 'windows.old', 'program files', 'program files (x86)', 'programdata',
  'appdata', 'perflogs', 'recovery', 'msocache', 'system volume information',
  'intel', 'amd', 'nvidia', 'drivers',
  // 明显的临时目录
  'temp', 'tmp', 'logs',
])

/** 缓存文件路径。走环境变量是为了让单测能指到临时文件上，不碰用户真实的缓存 */
export function cacheFilePath() {
  return process.env.ZEN_LOCAL_REPOS_CACHE || path.join(os.homedir(), '.zen-gitsync', 'local-repos.json')
}

/** 模块状态。repos 的键是仓库目录（原样，含 Windows 反斜杠），值是 origin 地址 */
let state = {
  status: 'idle', // idle | scanning | ready
  startedAt: null,
  finishedAt: null,
  scannedDirs: 0,
  repos: {},
  roots: [],
  error: null,
}
let cacheLoaded = false
/** 正在跑的扫描。同一时刻只允许一个（并发触发时复用同一个 Promise） */
let inflight = null

/** 本机存在的盘符。不存在的（软驱/空光驱）accessSync 会抛，直接跳过 */
export function listDrives() {
  const drives = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:/`
    try {
      accessSync(root)
      drives.push(root)
    } catch {
      /* 不存在 / 未就绪 */
    }
  }
  return drives
}

/**
 * 遍历目录树，收集所有 Git 仓库目录。纯遍历、不读 origin（单测主要钉这一层）。
 *
 * 判定：目录里存在名为 `.git` 的条目就算仓库 —— 不看它是目录还是文件，
 * 因为 `git worktree` 出来的工作区里 `.git` 就是文件。
 * 一旦确认是仓库就**不再往里下探**：仓库里不会再有"另一个仓库"，
 * 下探只会白扫 node_modules（跳过名单挡不住所有写法）。
 *
 * @param {{ roots?: string[], concurrency?: number, budgetMs?: number }} [options]
 * @returns {Promise<{ dirs: string[], scannedDirs: number, truncated: boolean }>}
 */
export async function walkGitDirs({ roots, concurrency = SCAN_CONCURRENCY, budgetMs = SCAN_BUDGET_MS } = {}) {
  const startRoots = (Array.isArray(roots) && roots.length ? roots : listDrives()).filter(Boolean)
  const queue = startRoots.map(dir => ({ dir, depth: 0 }))
  const dirs = []
  let cursor = 0
  let scannedDirs = 0
  let truncated = false
  const deadline = Date.now() + budgetMs

  // 共享游标的极简工作池：边扫边往队尾追加，谁空闲谁取。
  // 不能改成"启动前把任务分发完" —— 目录树是遍历过程中才展开的。
  const worker = async () => {
    while (cursor < queue.length) {
      if (Date.now() > deadline) {
        truncated = true
        return
      }
      const { dir, depth } = queue[cursor]
      cursor += 1
      scannedDirs += 1

      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        // 权限拒绝 / 目录刚被删 / 坏扇区：跳过这一棵，不影响其它分支
        continue
      }

      if (entries.some(e => e.name === '.git')) {
        dirs.push(dir)
        continue
      }
      if (depth >= MAX_DEPTH) continue

      for (const e of entries) {
        if (!e.isDirectory()) continue // symlink / junction 在这里被挡掉
        const name = e.name.toLowerCase()
        if (SKIP_DIR_NAMES.has(name) || name.startsWith('$')) continue
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { dirs, scannedDirs, truncated }
}

/** 给调用方看的快照（不含内部字段，也不把 state 引用交出去） */
function snapshot() {
  return {
    scanning: state.status === 'scanning',
    scannedAt: state.finishedAt,
    scannedDirs: state.scannedDirs,
    roots: state.roots,
    repos: state.repos,
    error: state.error,
  }
}

async function loadCache() {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = JSON.parse(await fs.readFile(cacheFilePath(), 'utf8'))
    const repos = raw && typeof raw.repos === 'object' && raw.repos ? raw.repos : {}
    state = {
      ...state,
      status: 'ready',
      repos,
      finishedAt: Number(raw?.scannedAt) || null,
      scannedDirs: Number(raw?.scannedDirs) || 0,
      roots: Array.isArray(raw?.roots) ? raw.roots : [],
    }
  } catch {
    // 首次运行没有缓存 / 文件损坏：保持空状态，交给 getLocalRepos 触发一次扫描
  }
}

async function saveCache() {
  try {
    await fs.mkdir(path.dirname(cacheFilePath()), { recursive: true })
    await fs.writeFile(
      cacheFilePath(),
      JSON.stringify({
        scannedAt: state.finishedAt,
        scannedDirs: state.scannedDirs,
        roots: state.roots,
        repos: state.repos,
      }, null, 2),
      'utf8'
    )
  } catch (error) {
    logger.warn('[local-repos] 写缓存失败:', error?.message || error)
  }
}

/**
 * 真扫一遍。同一时刻只有一个在跑：并发调用（两个 Tab 同时挂载、或扫描中点刷新）
 * 复用同一个 Promise，不会把磁盘读两遍。
 *
 * @param {{ roots?: string[] }} [options] roots 只为单测留：生产走 listDrives()
 */
export function refreshLocalRepos({ roots } = {}) {
  if (inflight) return inflight

  inflight = (async () => {
    const startedAt = Date.now()
    state = { ...state, status: 'scanning', startedAt, finishedAt: null, scannedDirs: 0, error: null }
    try {
      const useRoots = Array.isArray(roots) && roots.length ? roots : listDrives()
      const { dirs, scannedDirs, truncated } = await walkGitDirs({ roots: useRoots })
      // 发现仓库后统一读 origin。没有 origin 的仓库不进结果 —— 对「已克隆」没有信息量，
      // 却会把响应撑大（用户 23 个仓库里有几个是本地 init 的）。
      const origins = await probeDirectoryOrigins(dirs, { concurrency: ORIGIN_CONCURRENCY })
      const repos = {}
      for (const [dir, url] of Object.entries(origins)) {
        if (url) repos[dir] = url
      }

      state = {
        status: 'ready',
        startedAt,
        finishedAt: Date.now(),
        scannedDirs,
        repos,
        roots: useRoots,
        error: null,
      }
      await saveCache()
      logger.info(
        `[local-repos] 扫描完成：${scannedDirs} 个目录 / ${dirs.length} 个仓库 / ` +
        `${Object.keys(repos).length} 个有 origin${truncated ? '（超时提前结束）' : ''}`
      )
    } catch (error) {
      state = { ...state, status: 'ready', finishedAt: Date.now(), error: String(error?.message || error) }
      logger.error('[local-repos] 扫描失败:', error?.message || error)
    } finally {
      inflight = null
    }
    return snapshot()
  })()

  return inflight
}

/**
 * 取当前知道的本地仓库快照。**不阻塞**：
 *   - 有缓存（不管新不新鲜）→ 立刻返回手上这份；过期了顺手在后台重扫一遍；
 *   - 没缓存（首次运行）→ 立刻返回 { scanning: true }，扫描在后台进行，
 *     调用方过几秒再问一次就有了（前端就是这么做的）。
 */
export async function getLocalRepos({ ttlMs = CACHE_TTL_MS, roots } = {}) {
  await loadCache()
  const fresh = state.finishedAt && Date.now() - state.finishedAt < ttlMs
  // roots 同 refreshLocalRepos：只为单测留 —— 否则"过期触发后台重扫"这条路径
  // 没法测（一测就真去遍历全盘）。
  if (!fresh) void refreshLocalRepos({ roots })
  return snapshot()
}

/**
 * 就地登记一个刚克隆出来的仓库。
 *
 * 为什么不让前端等下一次全盘扫：clone 成功那一刻正是用户盯着看的时候，
 * 而重扫要十几秒 —— 那十几秒里徽标是空的，看起来就像"功能没生效"。
 * 克隆的目标目录是服务端自己算出来的，登记它是零成本且准确的。
 */
export async function rememberRepo(dir, originUrl) {
  const target = String(dir || '').trim()
  const url = String(originUrl || '').trim()
  if (!target || !url) return

  // 必须先加载缓存：否则 memory 里只有这一个仓库，把缓存里的其它仓库盖没了
  await loadCache()
  state = { ...state, repos: { ...state.repos, [target]: url } }
  await saveCache()
}

/** 单测用：清掉模块状态与"缓存已加载"标记 */
export function resetLocalRepoScan() {
  state = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    scannedDirs: 0,
    repos: {},
    roots: [],
    error: null,
  }
  cacheLoaded = false
  inflight = null
}
