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
// 对话轮次结束提示（2026-09-29）—— g ai / claude / codex 那一轮流式回复收尾时"叮"一声。
//
// 为什么不复用 useTaskNotifier 的那条链路：
//   那边的触发源是 SSE 帧（工作台 job 的 job:update），而对话结束是**本地 fetch 的
//   finally** —— 没有帧可订阅，也不需要订阅：谁起的流谁收尾，天然拿得到终态。
//   能力（系统通知 / 提示音）仍复用 taskNotify + taskSound，只有"什么该提示、
//   提示成什么样"这层策略搬到这里，与任务提示各自独立演进。
//
// 判定顺序与任务提示同口径（同一套三通道开关，都在全局设置里）：
//   1. 三个开关全关 = 整条链路都不走
//   2. 先出声：与页面在不在前台无关 —— 系统通知那点动静经常被静音/被折叠，
//      一声"叮"是人不用看屏幕也能知道的信号
//   3. 该发系统通知时（浏览器通知开着，且页面提示关着或页面不在前台）→ 发；
//      发不出去（权限被拒 / 环境不支持）再退回应用内 toast
//   4. 页面提示关着 → 到第 3 步为止，不拿一条他没要的 toast 顶上

import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import { notifySystem, shouldUseSystemNotification } from '@/utils/taskNotify'
import { playFinishSound } from '@/utils/taskSound'
import type { JobFinishKind, NotifySwitches } from '@/composables/useTaskNotifier'
import { anyChannelOn } from '@/composables/useTaskNotifier'

/**
 * 对话只可能落在这两种终态上。
 *
 * 用户自己按的「停止」不在其中：那一声提示音本来就是"任务结束了"的正向反馈，
 * 人正在页面上点停止，再响一声纯属打扰（见 taskSound 里 cancelled 留空的理由）。
 * 那一轮由调用点直接不提示，而不是靠这里把声音关掉。
 */
export type AgentTurnKind = Extract<JobFinishKind, 'done' | 'error'>

/** 通知正文的第二行：出错给错误信息，正常完成给最后一行输出（通常是模型的结论） */
export function agentTurnDetail(text: unknown, max = 200): string {
  const raw = typeof text === 'string' ? text : ''
  if (!raw.trim()) return ''
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  const last = lines.length ? lines[lines.length - 1] : ''
  const flat = last.replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 系统通知的标题（应用内 toast 另有文案：那边要把会话名写进句子里） */
export function agentTurnNoticeTitle(kind: AgentTurnKind): string {
  return kind === 'done' ? $t('@AGENT:对话已完成') : $t('@AGENT:对话出错')
}

/**
 * 发一条"这一轮对话结束了"的提示。返回是否真的提示出去了（开关关着 → false）。
 *
 * alreadyToast：调用点自己已经弹过应用内提示时传 true（出错那条 ElMessage.error
 * 就在 catch 里），否则同一条错误会在页面上弹两遍。
 */
export function announceAgentTurn(opts: {
  kind: AgentTurnKind
  title: string
  detail?: string
  tag?: string
  alreadyToast?: boolean
}): boolean {
  // 开关在 config.json（全局），每次读实时值：用户在设置里关掉后立刻生效
  const sw: NotifySwitches = { page: false, browser: false, sound: false }
  try {
    const store = useConfigStore()
    sw.page = !!store.notifyPageOnTaskDone
    sw.browser = !!store.notifyBrowserOnTaskDone
    sw.sound = !!store.notifySoundOnTaskDone
  } catch { /* store 不可用（单测 / 极早的启动期）→ 三个都保持 false，即不提示 */ }
  if (!anyChannelOn(sw)) return false

  const name = String(opts.title || '').trim() || $t('@AGENT:无标题')
  const detail = agentTurnDetail(opts.detail)
  const tag = opts.tag || 'zen-gitsync-agent'
  const body = detail ? `${name}\n${detail}` : name

  // 先出声：这一句跟"页面在不在前台"无关
  if (sw.sound) playFinishSound(opts.kind)
  if (shouldUseSystemNotification(sw)) {
    if (notifySystem({ title: agentTurnNoticeTitle(opts.kind), body, tag })) return true
  }
  if (!sw.page) return true
  if (opts.alreadyToast) return true
  if (opts.kind === 'done') ElMessage.success($t('@AGENT:对话完成：{name}', { name }))
  else ElMessage.error($t('@AGENT:对话出错：{name}', { name }))
  return true
}
