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
// 「每次页面加载只做一次」的门闸。
//
// 为什么需要它，而不是在组件里写一句模块级 let：
//   Vue 的 <script setup> 整块都会被编译进 setup() 函数 —— 写在那里的是**每个实例一份**
//   的状态。组件一旦卸载重建（切目录、切 Tab 都会），标记就跟着重置，
//   "整页只刷新一次"就退化成"每个面板实例刷一次"，联网动作会随切换次数成倍增长。
//   放进独立模块再 import 进来，才是真正的模块作用域（每次页面加载一份）。
//
// 为什么不用 sessionStorage / localStorage：那会把"一次"的边界推到标签页存活期甚至
// 永久，跨会话的语义与"启动时跑一遍"对不上，也难在开发时清掉。

const fired = new Set<string>()

/**
 * 首次以该 key 调用返回 true（并记住），之后同一个 key 一律 false。
 * key 用调用点的语义命名（如 'recent-dirs-refresh'），不要用组件名 ——
 * 同一个组件在不同语境下可能要各自算一次。
 */
export function oncePerLoad(key: string): boolean {
  if (fired.has(key)) return false
  fired.add(key)
  return true
}

/**
 * 重置门闸：不传 key 清空全部。
 * 单测用（每个用例要有自己的"这一页"），也给将来"手动强制重跑一次"留了口子。
 */
export function resetOncePerLoad(key?: string): void {
  if (key === undefined) fired.clear()
  else fired.delete(key)
}
