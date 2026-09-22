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
// 「GitHub / Gitee 仓库」列表的缓存（整页一份，按平台各存一份）。
//
// 为什么必须是独立模块，而不是组件里的一个模块级 const：
//   Vue 的 <script setup> 整块都会编译进 setup() —— 写在那儿的 Map 是**每个实例一份**。
//   App.vue 里两个仓库面板是用 v-if 切的（切走就卸载，理由见那儿的注释：不想在启动时
//   白跑一次 CLI 探测），于是每次切回来都是全新实例 —— 缓存留在实例里等于没缓存，
//   用户看到的还是"每点一次 Tab 转一次圈"。放进独立模块再 import 才是真正的整页一份。
//   （同一类坑的另两个实例见 utils/oncePerLoad.ts、utils/directorySummaryCache.ts）
//
// 为什么整份 payload 一起存，而不是只存 repos：/api/remote-repos 一次就把
// "装没装 CLI / 登没登录 / 仓库列表是什么 / 这次拉取报了什么错"全答了，
// 四件事在界面上是同一个 view 的四个分支（见组件的 view computed）。
// 只存其中一部分，回来还得把另外三件重新问一遍服务端 —— 那就不是缓存了。
//
// 类型由调用方给（具体形状是 components/RemoteReposList.vue 里的 RemoteReposPayload）：
// 这里只负责存取与新鲜度，不关心字段。这样"接口契约长什么样"留在用它的组件里，
// 不必为了缓存把一堆渲染相关的注释搬进 types/。

/** 缓存条目：payload + 写入时刻（调用方据此判断新鲜度） */
export interface RemoteReposCacheEntry<T> {
  payload: T
  at: number
}

/** provider（'github' / 'gitee'）→ 条目。key 只有两个，不需要容量上限。 */
const cache = new Map<string, RemoteReposCacheEntry<unknown>>()

/** 命中返回条目（含写入时刻），否则 undefined —— 调用方据此决定发不发请求 */
export function readRemoteReposCache<T>(provider: string): RemoteReposCacheEntry<T> | undefined {
  return cache.get(provider) as RemoteReposCacheEntry<T> | undefined
}

/** 记下一份 payload。时间戳取当前时刻 —— 新鲜度从这一刻起算 */
export function writeRemoteReposCache<T>(provider: string, payload: T): void {
  cache.set(provider, { payload, at: Date.now() })
}

/** 丢掉指定平台的缓存。用户主动刷新失败时用：那一刻界面已经如实变成错误屏了，
 *  缓存再留着，下次切回来就会"凭空"冒出一份旧列表，和刚才的失败自相矛盾。 */
export function dropRemoteReposCache(provider: string): void {
  cache.delete(provider)
}

/** 清空缓存：单测用（每个用例要有自己的"这一页"） */
export function resetRemoteReposCache(): void {
  cache.clear()
}
