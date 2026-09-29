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
// 任务结束提示音封装（2026-09-29）—— 任务从"跑着"变终态时"叮"一声。
//
// 音源：Kenney《Interface Sounds》，CC0 1.0（公共领域，无需署名）。
//   选 CC0 而不是随手下一个 mp3：本仓库以 Apache-2.0 发布到 npm，构建产物会带上
//   public/ 下的全部资源，带署名（CC BY）、相同方式共享（CC BY-SA）或"禁止再分发
//   原始文件"（Mixkit / Pixabay 系）条款的音源混进包里就是许可证污染。
//   出处、许可与换音色的方法见 public/sounds/CREDITS.txt。
//
// 为什么用音频文件而不是 Web Audio 现场合成正弦波：
//   合成出来只有"嘀"一声，听着像设备报错；这里是"任务结束了"的正向反馈，
//   要的是有衰减的"叮～"。而且合成的频率/包络参数要跟着音色调，不如换文件直观。
//
// 为什么按 src 缓存 Audio 实例：
//   任务成批跑完时会连着响好几声，每次都 new Audio() 就要重走一遍 fetch + decode，
//   偏偏这个时间点最不该多花几十毫秒；复用实例则是命中缓存立刻出声。
//   同一个实例上 currentTime 归零再 play，后一声会打断前一声而不是叠成噪音。
//
// 与 taskNotify.ts 同口径：**绝不抛异常、只返回布尔**。调用点在 SSE 回调里，
// 任何异常冒泡上去都会打断后续帧的处理。

import type { JobFinishKind } from '@/composables/useTaskNotifier'

/**
 * 每种终态对应的音源。空串 = 不响。
 * cancelled（用户自己按的停止）故意留空 —— 人就在页面上点的那一下，再响一声是打扰。
 */
const SOUND_SRC: Record<JobFinishKind, string> = {
  done: '/sounds/task-done.wav',
  error: '/sounds/task-error.wav',
  cancelled: '',
}

/** src → 已创建的 Audio 实例。懒创建：没触发过提示音就一个字节都不会去下载 */
const pool = new Map<string, HTMLAudioElement>()

/** 某种终态该用哪个音源（纯函数，方便测试直接断言映射关系，不用碰 Audio） */
export function soundUrlFor(kind: JobFinishKind): string {
  return SOUND_SRC[kind] || ''
}

function audioFor(src: string): HTMLAudioElement | null {
  // jsdom / 老环境没有 Audio 构造器
  if (typeof Audio === 'undefined') return null
  const cached = pool.get(src)
  if (cached) return cached
  try {
    const el = new Audio(src)
    // 提前把音频解码好：真正要响的那一刻（任务刚跑完）不该还在等网络
    el.preload = 'auto'
    pool.set(src, el)
    return el
  } catch {
    return null
  }
}

/**
 * 播一次结束提示音。
 *
 * ⚠️ 会被浏览器的自动播放策略拦下：用户从没跟页面交互过时 `play()` 直接 reject
 * （NotAllowedError）。这属于正常现象，静默吞掉即可 —— 工作台的任务都是用户点出来的，
 * 有交互史之后策略就不再拦。绝不能因为被拦就弹错误提示吓人。
 *
 * @returns 是否**已发起**播放。注意这不等于一定出声（可能被策略拦、也可能被系统静音），
 *          只表示代码走到了该走的地方；调用点不需要据此分支，留着是为了测试能断言。
 */
export function playFinishSound(kind: JobFinishKind): boolean {
  const src = soundUrlFor(kind)
  if (!src) return false
  const el = audioFor(src)
  if (!el) return false
  try {
    // 连响时从头开始，而不是接着上一声的尾巴
    el.currentTime = 0
  } catch {
    /* 元数据还没就绪时个别浏览器设 currentTime 会抛，忽略，直接播 */
  }
  try {
    const p = el.play()
    // jsdom 的 play() 返回 undefined（未实现），真浏览器返回 Promise
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* 自动播放被拦，静默降级 */ })
    }
  } catch {
    /* 同上：某些环境 play() 直接抛而不是 reject */
  }
  return true
}

/** 仅供测试：清空实例池，避免用例之间互相看到对方的 Audio */
export function __resetSoundPool(): void {
  pool.clear()
}
