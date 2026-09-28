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
// 发布后自更新「这一轮要不要真调 npm install」的判定 —— 纯函数,不碰网络/IO,便于单测。
//
// 为什么要把这个判定单独抽出来(2026-09-29 v2.17.21 事故):
// 原来的写法是 `if (probe.ok) { 真装 }` —— 探针(直接 GET 一次 tarball URL)是**硬闸门**。
// 那次探针连着 35 轮全报 `HTTP 404`,于是 600s 里 `npm install` **一次都没被执行**,
// 唯一发生的事就是每 15s 打印一行"还取不到";而发布脚本放弃后,用户手动
// `npm install -g zen-gitsync@2.17.21` 16s 就装上了。
//
// 结论:探针只是"省一次注定失败的调用"的**优化**,不是事实。真正的判据只有 npm 自己。
// 所以判定改为「两个就绪信号任一为真就真试 + 探针不可信时按节奏强制真试」,
// 超时前还会补最后一次真试(见 scripts/release.js: selfUpdateGlobal)。
//
// 两个就绪信号各自对应一条能绕开对方缓存的安装路径(这就是为什么两条都要看):
//   - packument 里已有这个版本 → `npm install -g <pkg>@<ver>` 能解析;
//   - tarball 可取             → `npm install -g <tarball URL>` 直连能装(不经过 packument 缓存)。

// 探针一直说"取不到"时,每隔几轮强制真试一次。
// 4 轮 × 默认 15s ≈ 每 1 分钟一次真试:600s 的窗口里能拿到约 8 次真装机会,
// 而不是 0 次;单次失败(npm 报 404/ETARGET)只花几秒,不心疼。
export const FORCE_INSTALL_EVERY = 4

/**
 * 判定这一轮是否真的调用 npm 安装。
 *
 * @param {object} input
 * @param {number} input.attempt - 从 1 开始的轮次
 * @param {{ok: boolean, status?: number, error?: string, unknown?: boolean}} input.probe
 *   isTarballFetchable() 的结果:`ok=true/status=0(网络错)/status=404` 三种形态
 * @param {boolean} input.packumentHasVersion - `npm view <pkg>@<ver> version` 是否拿得到
 * @param {number} [input.forceEvery] - 强制真试的间隔轮数,0/负数 = 不强制
 * @returns {{attempt: boolean, reason: string}}
 *   reason: packument-ready | tarball-ready | probe-failed | forced | probe-says-missing
 */
export function shouldAttemptInstall({ attempt, probe, packumentHasVersion, forceEvery = FORCE_INSTALL_EVERY }) {
  // ① 任何一条路已被证实可用 → 立刻真装,不浪费窗口
  if (packumentHasVersion) return { attempt: true, reason: 'packument-ready' }
  if (probe?.ok) return { attempt: true, reason: 'tarball-ready' }

  // ② 探针"没结论"(网络抖动 / 拿不到 fetch / 超时返回 status=0)→ 当成可用,由 npm 自己去判。
  //    探针失败 ≠ tarball 不存在;把它当"取不到"会平白削掉一整轮机会。
  if (!probe || probe.status === 0 || probe.error) return { attempt: true, reason: 'probe-failed' }

  // ③ 探针明确说"这个路径 404":这是唯一允许跳过的情形,但必须按期强制真试 ——
  //    404 可能来自边缘节点的负缓存 / 透明代理,而不是 registry 真的没有这个对象。
  if (Number.isFinite(forceEvery) && forceEvery > 0 && attempt % forceEvery === 0) {
    return { attempt: true, reason: 'forced' }
  }

  return { attempt: false, reason: 'probe-says-missing' }
}

/**
 * 轮询窗口用尽时,还要不要补最后一次真试。
 *
 * 只在这一整轮"从头到尾没真装过"时才补:那种情况下窗口的内容是纯等待,
 * 一次事实判据都没取到(探针误报时就是这个形态,等于白等 600s)。
 * 若最后一轮刚试过(只差几秒),再试一次没意义。
 *
 * @param {{installAttempts: number, lastRoundAttempted: boolean}} input
 * @returns {boolean}
 */
export function shouldFinalAttempt({ installAttempts, lastRoundAttempted }) {
  if (lastRoundAttempted) return false
  // installAttempts === 0 是主目标(整轮零真试);> 0 但最后一轮在跳过,也顺手补一次。
  return true
}
