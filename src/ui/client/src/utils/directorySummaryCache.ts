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
// 「最近项目 / 常用目录」AI 状态解读的缓存(整页一份)。
//
// 为什么必须是独立模块,而不是组件里的一个模块级 const:
//   Vue 的 <script setup> 整块都会编译进 setup() —— 写在那儿的 Map 是**每个实例一份**。
//   这块说明有两个入口(App 里的最近项目面板、切换工作目录弹窗的常用目录),
//   而且面板会随切目录反复卸载重建;缓存留在实例里,弹窗重开就重新问一次模型,
//   等于每开一次弹窗烧一次 token。放进独立模块再 import 才是真正的整页一份。
//   (同一类坑的另一个实例见 utils/oncePerLoad.ts)
//
// key 由调用方给(状态指纹 + 语言 + 模型),这里只负责存取与容量上限。

const MAX_ENTRIES = 20

/** key → 解读正文。Map 保持插入顺序,用来做"丢最早那条" */
const cache = new Map<string, string>()

/** 命中返回正文,否则 undefined(调用方据此决定要不要发请求) */
export function readDirectorySummary(key: string): string | undefined {
  return cache.get(key)
}

/**
 * 记下一份解读。超上限丢最早那条 —— 解读是"当前状态"的快照,
 * 状态变了就会产生新的 key,老的自然应该被挤出去。
 */
export function writeDirectorySummary(key: string, text: string): void {
  if (!key || !text) return
  cache.set(key, text)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 丢掉指定 key(手动"重新生成"时用,让下一次调用真的去问模型) */
export function dropDirectorySummary(key: string): void {
  cache.delete(key)
}

/** 清空缓存:单测用(每个用例要有自己的"这一页") */
export function resetDirectorySummaryCache(): void {
  cache.clear()
  inflight.clear()
}

// ── 正在生成中的那一份 ────────────────────────────────────────────────────
// 这块说明有两个入口(最近项目面板 / 常用目录弹窗)。面板刚发起解读、用户就打开了
// 弹窗时,弹窗会拿着**同一份状态**再问一次模型 —— 同一段文字花两份钱。
// 让后来者挂在先到的那个请求上等结果,落库后直接从缓存取。

/** key → 正在跑的生成任务(流读完 / 被中断后 resolve,不 reject) */
const inflight = new Map<string, Promise<void>>()

/** 登记一个正在跑的生成任务;任务结束时自动摘掉(成功失败都摘) */
export function trackPendingDirectorySummary(key: string, task: Promise<void>): void {
  if (!key) return
  inflight.set(key, task)
  const clear = () => {
    if (inflight.get(key) === task) inflight.delete(key)
  }
  task.then(clear, clear)
}

/** 同一份状态是否已经有实例在生成?有就返回那个任务,调用方等它即可 */
export function pendingDirectorySummary(key: string): Promise<void> | null {
  return inflight.get(key) ?? null
}
