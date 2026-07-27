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

/**
 * 启动耗时打点工具(dev 专用)。
 *
 * 用法:
 *   import { perfMark, perfNow } from './utils/perfMark.js'
 *   perfMark('express + socket.io 创建完成')  // -> [PERF] +123ms (+45ms) express + socket.io 创建完成
 *
 * 输出格式: [PERF] +<进程启动以来 ms> (+<距上次打点 ms>) <label>
 *   第一列定位"何时就绪",第二列定位"这一段花了多少"。
 *
 * 门控: 仅 ZEN_PERF 环境变量为真时打印。生产 `g ui` 与 dev 共用 startUIServer,
 *   不能给终端用户刷性能日志;dev:server 脚本通过 cross-env ZEN_PERF=1 开启。
 *   关闭时 perfMark 是空函数,开销可忽略。
 */

const ENABLED = !!process.env.ZEN_PERF

// performance.now() 在 Node 中相对进程启动(performance.timeOrigin = 进程启动时刻),
// 正好符合"从 node 进程起来到现在过了多久"的语义,无需自己记 t0。
let _last = 0

/**
 * 打一个没有标签前缀的时间戳,返回当前 performance.now()。
 * 供 server.js 在动态 import 前后手动相减(那时还没拿到本模块)。
 * @returns {number} 进程启动以来的毫秒数
 */
export function perfNow() {
  return performance.now()
}

/**
 * 打印一个耗时打点。label 建议用"XX 完成"的完成时措辞,读日志时一眼对应里程碑。
 * @param {string} label 里程碑描述
 */
export function perfMark(label) {
  if (!ENABLED) return
  const now = performance.now()
  const total = now.toFixed(0).padStart(5)
  const delta = (now - _last).toFixed(0).padStart(5)
  _last = now
  // 用 console.log 直出,不走 logger(避免 redact/时间戳包装干扰对齐)
  console.log(`[PERF] +${total}ms (+${delta}ms) ${label}`)
}

/**
 * 手动记一个分段起点,配合 perfMark 使用:
 *   const t = perfSince()  ...  perfMark(`xxx 耗时 ${perfSince() - t}ms`)
 * 一般不需要,perfMark 自带的 (+delta) 列已覆盖分段计时。
 * @returns {number}
 */
export function perfSince() {
  return performance.now()
}
