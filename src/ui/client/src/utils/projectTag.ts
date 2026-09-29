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
// 项目色标：看板卡片 / 列表行上「这条任务属于哪个项目」那一小格的颜色。
//
// 为什么要上色：视图切到「全部项目」时，同一列里混着好几个项目的任务，
// 而这一格过去只是一行灰字——扫一眼分不出哪几张是同一个项目的，
// 可"分得出"恰恰是这一格存在的唯一理由。给每个项目一个稳定色相之后，
// 「这几张大概是一伙的」就成了不用读字的第二通道。
// （是提示不是键：色相只有 8 档而项目有 20 个，撞色会发生，
//   认项目始终以标签里的项目名为准，见 HUES 的注释。）
//
// 颜色只由**项目路径**推出，不是数组下标、也不是"第几个出现的项目"：
// 看板会随筛选 / 排序 / 轮询重算，顺序一变颜色就跳，用户刚记住的对应关系立刻作废。
// 路径先归一化再哈希——同一个项目在 Windows 上可能写成 `C:\ws\X` 也可能写成 `c:/ws/x`，
// 不归一化会算出两个颜色。

import type { CSSProperties } from 'vue'

/**
 * 色相档位：140°→350° 这半圈上**等距**的 8 档，而不是"随便取 0-360"。
 *
 * 为什么只占半圈：卡片自己的"报错红"（--color-danger，≈0°）与"运行橙"
 * （--color-warning，≈38°）已经在用暖色说话，标签再取正红 / 正橙就会被读成状态而不是身份；
 * 剩下的黄绿一带（40°–130°）浅色调既发飘又和正文抢眼。于是可用弧段就只剩 140°–350°，
 * 在这段上等距切 8 刀 = 每档隔 30°，是"最大可分辨档数"与"每档间距"的折中。
 *
 * 8 档装不下本机 20 个项目 —— 撞色必然发生，所以这只是**提示**不是键：
 * 判断"是不是同一个项目"始终以旁边那行项目名为准，色相只负责把"大概哪几张是一伙的"
 * 变成不用逐字读的第二通道。（把档位调多并不能解决：色相多了相邻两档就分不出来，
 * 得到的是更密的撞色和更差的观感。）
 */
const HUES = [140, 170, 200, 230, 260, 290, 320, 350]

/** 归一化：反斜杠 → 正斜杠、去空白、转小写（Windows 路径的三种常见写法差异都在这里抹平） */
function normalizeSeed(seed: string): string {
  return (seed || '').replace(/\\/g, '/').trim().toLowerCase()
}

/**
 * 项目路径 → 色相（deg）。
 *
 * 两步，缺一不可：
 * 1. FNV-1a —— 不用常见的 `h * 31 + c`：本机所有项目路径共享一长串前缀
 *    （`c:/workspace/github_workspace/...`），前向哈希的低位区分度会被公共前缀吃掉。
 * 2. 收尾混淆（MurmurHash3 finalizer）—— 这里最后要的是 `h % 8`，只用最低 3 位；
 *    而 FNV 的低位对"前半段相同、尾部不同"的串仍然偏弱。实测本机 6 个项目，
 *    单用 FNV 时 `zen-gitsync` 与 `zen-ai-chat-ui`（恰好是看板上并排的两张卡）双双落在同一档，
 *    补一步混淆后这两个才分开。
 */
export function projectHue(seed: string): number {
  const s = normalizeSeed(seed)
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // MurmurHash3 finalizer：把高位的差异翻搅到低位，供下面的取模用
  h ^= h >>> 16
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  h = Math.imul(h, 3266489909)
  h ^= h >>> 16
  return HUES[(h >>> 0) % HUES.length]
}

/**
 * 标签元素的行内样式：这里只给**色相**。
 *
 * 底色 / 描边 / 文字三层都留给 CSS 用 color-mix 按主题混（见 WorkbenchKanban.vue 的
 * .kb-card__project-chip），这样深色主题不用再维护第二组颜色——多一组就要多一组"挑得对不对"。
 */
export function projectTagStyle(seed: string): CSSProperties {
  return { '--tag-hue': String(projectHue(seed)) }
}
