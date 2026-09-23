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
// 「本地已经克隆了哪些远程仓库」——远程仓库列表的卡片用它标「已克隆」。
//
// 数据来源：GET /api/local-repos（服务端**全盘扫**本机所有 Git 仓库、读各自的
// origin，结果落盘缓存）。这里把本地 origin 归一化成 `host/owner/repo`，产出
// `{ [repoKey]: 本地目录 }`：键够渲染徽标，带上路径是为了悬浮提示里能直接说清
// "克隆到哪了"。
//
// 为什么判据不只限于「常用目录」：用户要回答的是"这个远程仓库我本地有了吗"，
// 而"本地有"和"最近打开过"是两回事 —— 刚克隆到别的盘、或者早就克隆但从没在这个
// 应用里打开过，都仍然是"本地已经有了"。详见服务端 utils/localRepoScan.js 的文件头。
//
// 为什么必须是独立模块（而不是组件里的模块级变量）：`<script setup>` 整块都会编译
// 进 setup()，那里的变量**每个实例一份**；App.vue 的两个仓库面板是 v-if 切的两个
// 实例、还会随 Tab 反复卸载重建 —— 写在组件里就等于"每切一次 Tab 就重问一遍"。
// （同一个坑见 utils/remoteReposCache.ts、utils/oncePerLoad.ts）
//
// 首次运行那一次全盘扫要十几秒（实测本机 C:/ + D:/ 共 8613 个目录约 12 秒）。
// 服务端刻意不把 HTTP 请求挂在那次扫描上（GET 立刻回 `scanning: true`），于是
// **"过几秒再问一次"这件事落在这里** —— 否则第一次打开界面永远是满屏没有徽标。

import { toRepoKey } from '@/utils/remoteUrl'

/** 键 = host/owner/repo（小写）；值 = 本地目录绝对路径 */
export type LocalClones = Record<string, string>

/** 拿到结果后多久算新鲜（与仓库列表自己的 TTL 同档） */
const TTL_MS = 60_000
/** 服务端还在扫的时候，隔多久再问一次 */
const RETRY_DELAY_MS = 3_000
/** 最多问几次（3s × 8 = 24s；本机实测全盘 12 秒左右扫完，留一倍余量） */
const MAX_RETRIES = 8

let entry: { at: number, map: LocalClones } | null = null
/** 同一次页面加载里两个 Tab 同时挂载、以及扫描期间的连续重试，都只跑一条链 */
let inflight: Promise<LocalClones> | null = null

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 服务端的 `{ [仓库目录]: origin 地址 }` → `{ [host/owner/repo]: 仓库目录 }` */
function normalize(repos: unknown): LocalClones {
  if (!repos || typeof repos !== 'object') return {}
  const map: LocalClones = {}
  for (const [dir, url] of Object.entries(repos as Record<string, unknown>)) {
    const key = toRepoKey(String(url))
    // 同一个仓库被克隆到两个目录时，以先出现的为准（遍历顺序 = 服务端给的顺序）；
    // 徽标只需要"有 / 没有"，路径只进 tooltip
    if (key && !map[key]) map[key] = dir
  }
  return map
}

async function fetchLocalClones({ waitForScan = false } = {}): Promise<LocalClones> {
  let map: LocalClones = {}
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const res = await fetch('/api/local-repos', { cache: 'no-store' })
    const data = await res.json()
    if (!data?.success) return {}
    map = normalize(data.repos)

    // 扫完了 → 这就是定稿
    if (!data.scanning) return map
    // 等重扫的场合：手上这份是**重扫前**的，拿到也没意义，必须等到扫完
    if (waitForScan) {
      await sleep(RETRY_DELAY_MS)
      continue
    }
    // 还在扫、但服务端已经有一份旧快照（非首次运行）→ 先用着，不让用户干等
    if (Object.keys(map).length > 0) return map
    // 首次运行、还什么都不知道：等一会儿再问
    await sleep(RETRY_DELAY_MS)
  }
  return map
}

/**
 * 取「本地已克隆」映射。
 *
 * 拿不到（服务端还是旧进程、没这个接口 / 网络失败）一律回空对象 —— 徽标是补充
 * 信息，缺了不该影响仓库列表本身，更不该弹一个用户看不懂的错。
 *
 * `force` 用于"刚克隆完一个仓库"：服务端那一刻已经把它登记进快照了，
 * 这一趟只是把新快照取回来（命中缓存，不会重扫盘）。
 * `waitForScan` 用于"用户点了刷新"：见 rescanLocalClones。
 */
export async function loadLocalClones(force = false, { waitForScan = false } = {}): Promise<LocalClones> {
  if (!force && entry && Date.now() - entry.at < TTL_MS) return entry.map
  if (!force && inflight) return inflight

  const task: Promise<LocalClones> = fetchLocalClones({ waitForScan })
    .catch(() => ({} as LocalClones))
    .then((map) => {
      entry = { at: Date.now(), map }
      return map
    })
    .finally(() => {
      inflight = null
    })
  inflight = task
  return task
}

/**
 * 让服务端重扫一遍本机仓库，并**等它扫完**再回结果（用户点「刷新」时用）。
 *
 * 为什么不能沿用普通的 loadLocalClones(true)：那一条在服务端"正在扫"时会立刻把
 * **重扫之前**的旧快照交出来 —— 用户刚在终端里 clone 完一个仓库回来点刷新，看到的
 * 还是缺一条的旧列表，等于刷新没生效。服务端缓存 TTL 有 10 分钟，不主动重扫的话
 * 这个缺会一直挂着。
 *
 * 旧服务端没有 /scan 这条路由时静默降级成"只重取一次快照"，不报错。
 */
export async function rescanLocalClones(): Promise<LocalClones> {
  try {
    await fetch('/api/local-repos/scan', { method: 'POST' })
  } catch {
    /* 没有这条路由 / 网络抖动：下面照样重取快照，只是拿到的可能还是旧的 */
  }
  return loadLocalClones(true, { waitForScan: true })
}

/** 清空缓存：单测用（每个用例要有自己的"这一页"） */
export function resetLocalClones(): void {
  entry = null
  inflight = null
}
