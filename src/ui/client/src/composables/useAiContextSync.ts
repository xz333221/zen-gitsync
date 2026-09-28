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
/**
 * 面板切换 → 通知服务端刷新「工作区状态快照」里对应的板块。
 *
 * 为什么需要它:g ai 的上下文快照是服务端生成的(见 server/routes/aiContext/)，
 * 它不知道用户此刻在看哪一块。用户切到「系统监控」，多半接下来就要问"我这 CPU 怎么了"——
 * 这时候把 system 板块刷一遍，比让模型自己现场跑 PowerShell 快得多。
 *
 * 三条刻意的口径:
 *
 * 1) **按板块刷,不是全量刷。** 七个板块的取数成本差两个数量级:git 状态是本地毫秒级,
 *    `gh` / `gitee` 拉列表要联网、单条命令 25s 超时。切个 Git 面板没必要顺带联网拉仓库列表。
 *    所以这里只报"这次该刷哪几块",剩下的判定全在服务端。
 *
 * 2) **fire-and-forget,不等响应。** 一次全量取数要 6~7 秒,没有任何交互该等它。
 *    失败也完全无所谓——快照没更新最多是模型看到旧的,界面一点不受影响。
 *
 * 3) **force 由服务端把关。** 这里一律传 force,不怕刷爆:服务端每个板块有自己的
 *    forceTtlMs 地板(联网板块 60s),前端点得再快也只按地板走。把频率控制放在服务端,
 *    前端就不必记"上次刷是什么时候"这种状态——那种状态迟早和真实情况不一致。
 *
 * 服务端对应的接口是 POST /api/ai-context/refresh(sections / force)。
 */

/** 空数组 = 全部板块（服务端认这个语义）；null = 这次不用刷 */
export type AiContextSections = string[] | null

/** 「全部板块」 */
export const ALL_AI_CONTEXT_SECTIONS: string[] = []

/**
 * 视图 → 该刷的板块。
 *
 * git 视图是 null:它有子 Tab(当前项目 / GitHub / Gitee),对应板块完全不同,
 * 由下面那张表按 gitTab 决定。console / editor / source-map 与快照无关,一律 null ——
 * 切过去什么都不刷,别为了"整齐"给它们硬塞一个板块。
 */
export const AI_CONTEXT_SECTIONS_BY_VIEW: Record<string, AiContextSections> = {
  git: null,
  console: null,
  editor: null,
  'source-map': null,
  workbench: ['tasks'],
  monitor: ['system'],
  mindmap: ['mindmap'],
  // 智能体页:用户可能在这里问任何一块,所以全刷。
  // 联网板块被服务端的 60s 地板挡着,不会因为反复进出这个页面而疯狂拉列表。
  agent: ALL_AI_CONTEXT_SECTIONS,
}

/** Git 视图内三个子 Tab → 该刷的板块 */
export const AI_CONTEXT_SECTIONS_BY_GIT_TAB: Record<string, AiContextSections> = {
  current: ['git'],
  github: ['github'],
  gitee: ['gitee'],
}

/**
 * 请求服务端刷新指定板块。不返回 Promise —— 调用方永远不该等它。
 * @param sections null 表示不用刷;空数组表示全部
 */
export function refreshAiContext(sections: AiContextSections): void {
  if (sections === null) return
  void fetch('/api/ai-context/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sections, force: true }),
  }).catch(() => {
    // 静默:快照刷新失败不影响任何界面功能，模型那边退化成"按实时查询方法自己跑"
  })
}

/**
 * 按当前所在视图算出该刷的板块，并触发刷新。
 * @param view 当前活动视图
 * @param gitTab Git 视图内的子 Tab（view 不是 git 时忽略）
 */
export function refreshAiContextForView(view: string, gitTab: string): void {
  const sections = view === 'git'
    ? AI_CONTEXT_SECTIONS_BY_GIT_TAB[gitTab] ?? null
    : AI_CONTEXT_SECTIONS_BY_VIEW[view] ?? null
  refreshAiContext(sections)
}
