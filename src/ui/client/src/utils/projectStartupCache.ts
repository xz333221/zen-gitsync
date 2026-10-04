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
// 「AI 推荐启动方式」的结果缓存(整页一份)。
//
// 与 directorySummaryCache 同样的两条理由:
//   1. 缓存必须是**独立模块**,不能写成组件里的模块级 const —— <script setup> 整块都会
//      编译进 setup(),写在那儿的 Map 是每个实例一份,弹窗重开就会重新问一次模型。
//   2. 同一个项目同时有两个入口(面板下拉菜单点两下、弹窗还没关又点一次)时,后来者
//      应该挂在先到的那个请求上等结果,而不是再烧一次 token。
//
// key 由调用方给(项目路径 + 语言 + 模型):换目录 / 换语言 / 换模型都不能读到上一份 ——
// 换目录尤其重要,SPA 切目录**不刷新页面**(只清空列表),key 里不带路径的话会把
// A 项目的启动方式显示在 B 项目上。
//
// 注意:这里只缓存**模型给的清单**,不缓存"用户点过启动"的状态 —— 那个是会话内的 UI 反馈,
// 不该跟着缓存跨弹窗复用。

export type StartupSuggestion = {
  id: string
  kind: 'npm' | 'shell'
  title: string
  order: number
  reason: string
  /** 展示用命令行(npm 类由服务端拼好,shell 类是模型原话) */
  command: string
  /** kind=npm:包目录绝对路径 + 脚本名,/api/run-npm-script 直接用 */
  packagePath?: string
  packageLabel?: string
  packageName?: string
  scriptName?: string
  /** kind=shell:执行目录绝对路径,/api/exec-in-terminal 的 workingDirectory */
  cwd?: string
  cwdLabel?: string
}

const MAX_ENTRIES = 8

/**
 * 缓存键的唯一出处。
 *
 * 面板(判断"有没有上次的结果"、要不要把菜单项点亮)和弹窗(读 / 写缓存)必须算出**同一个**
 * 字符串,所以键的拼法只能有一份 —— 两边各写一遍,改一处就等于悄悄失效(NPM 面板与弹窗
 * 分别算键,是这次最容易埋进去的坑)。
 */
export function startupSuggestionsKey(projectPath: string, locale: string, modelKey: string): string {
  return `${projectPath || ''}|${locale || ''}|${modelKey || ''}`
}

/** key → 建议清单。Map 保持插入顺序,用来做"丢最早那条" */
const cache = new Map<string, StartupSuggestion[]>()

export function readStartupSuggestions(key: string): StartupSuggestion[] | undefined {
  return cache.get(key)
}

export function writeStartupSuggestions(key: string, list: StartupSuggestion[]): void {
  if (!key) return
  cache.set(key, list)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 丢掉指定 key("重新分析"时用,让下一次真的去问模型) */
export function dropStartupSuggestions(key: string): void {
  cache.delete(key)
}

/** 清空:`清除推荐结果` 菜单项与单测用 */
export function resetStartupSuggestionsCache(): void {
  cache.clear()
  inflight.clear()
}

/** key → 正在跑的生成任务(成功失败都 resolve,不 reject) */
const inflight = new Map<string, Promise<void>>()

export function trackPendingStartupSuggestions(key: string, task: Promise<void>): void {
  if (!key) return
  inflight.set(key, task)
  const clear = () => {
    if (inflight.get(key) === task) inflight.delete(key)
  }
  task.then(clear, clear)
}

export function pendingStartupSuggestions(key: string): Promise<void> | null {
  return inflight.get(key) ?? null
}
