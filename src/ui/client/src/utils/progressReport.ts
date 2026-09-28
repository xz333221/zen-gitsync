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
// 进度报告面板的展示口径：间隔档位、档位文案、失败原因码 → i18n key。
//
// 为什么档位是**白名单**而不是让用户自由填分钟数：这个值直接决定每多久烧一次模型额度。
// 服务端 shared.js 的 PROGRESS_REPORT_INTERVALS_MS 是同一份白名单的另一半 ——
// 两边必须逐值一致，否则前端能选的值会被服务端悄悄改成默认值（界面显示 7 分钟、
// 实际按 10 分钟跑），所以这里加了一条单测钉住两端相等。
//
// 报告**正文**是服务端写的自然语言（不可信数据里长出来的东西，但它本身是模型输出），
// 前端只渲染不改写；能改写的只有这些"码"（trigger / errorCode）对应的人话。

/** 自动报告间隔档位（毫秒）。0 = 关闭自动报告（手动「立即报告」不受影响） */
export const REPORT_INTERVAL_OPTIONS_MS = [0, 5, 10, 15, 30, 60].map(min => min * 60 * 1000)

/** 缺省 10 分钟。与服务端 DEFAULT_PROGRESS_REPORT_INTERVAL_MS 同值 */
export const DEFAULT_REPORT_INTERVAL_MS = 10 * 60 * 1000

/** 非法值（脏数据 / 手改配置）一律回落到默认，绝不凭空造一个新档位 */
export function normalizeReportInterval(ms: unknown): number {
  const n = Number(ms)
  return REPORT_INTERVAL_OPTIONS_MS.includes(n) ? n : DEFAULT_REPORT_INTERVAL_MS
}

/**
 * 档位 → 下拉里的文案 key。分钟数不写死在文案里，靠 $t 的 {n} 插值 ——
 * 五个档位各写一条"每 5 分钟 / 每 10 分钟…"会漏改。
 */
export function reportIntervalLabelKey(ms: number): string {
  if (!ms) return '@WORKBENCH:关闭自动报告'
  return ms >= 60 * 60 * 1000 ? '@WORKBENCH:每 {n} 小时报告' : '@WORKBENCH:每 {n} 分钟报告'
}

/** 档位 → 插值参数（与上面那个 key 配对使用） */
export function reportIntervalLabelParams(ms: number): Record<string, number> {
  if (!ms) return {}
  return { n: ms >= 60 * 60 * 1000 ? Math.round(ms / (60 * 60 * 1000)) : Math.round(ms / 60000) }
}

/**
 * 报告失败原因码 → i18n key。
 * 认不出来的码退回一句通用的"生成失败" —— 服务端将来加了新码，
 * 老前端显示的是一句实话，而不是把 codes 原样印在界面上。
 */
export function reportErrorKey(code: string): string {
  switch (code) {
    case 'NO_MODEL': return '@WORKBENCH:没有可用的 AI 模型，只记录了任务事实'
    case 'LLM_TIMEOUT': return '@WORKBENCH:生成超时，只记录了任务事实'
    case 'LLM_FAILED': return '@WORKBENCH:生成失败，只记录了任务事实'
    default: return '@WORKBENCH:生成失败，只记录了任务事实'
  }
}
