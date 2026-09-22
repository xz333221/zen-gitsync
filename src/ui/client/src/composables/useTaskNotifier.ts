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
// 任务执行结束提示（2026-09-22）。
//
// 为什么要在 App 层单开一条 SSE，而不是挂在现有那条上：
//   现有 SSE 在 `useWorkbenchData` 里，由 WorkbenchView 在 mount/unmount 时连断
//   （App.vue 用的是 `v-if="activeView === 'workbench'"`）。也就是说用户一旦切到
//   Git / 编辑器 / AI Agent 视图，那条连接就没了 —— 而"任务跑完时我正看着别的面板"
//   恰恰是这个功能要解决的主场景。所以这里独立订阅一次，只做一件事：把
//   「跑着 → 结束」的状态跃迁翻译成一条提示。
//   副作用是工作台开着时浏览器里会有两条 SSE：服务端 bus 是广播模型，多一个订阅者
//   不影响推送语义，代价可以接受（比把整个 workbench 数据层提成全局 store 小得多）。
//
// 提示形态按「人现在能不能看到这个页面」分：
//   - 页面在前台 → 应用内 toast（看得见，不必再弹系统窗口）
//   - 页面在后台 / 别的窗口 → 系统通知（否则等于没提示）
// 权限被拒时系统通知发不出去，会退回 toast 兜一手。

import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import { useConfigStore } from '@stores/configStore'
import { notifySystem, shouldUseSystemNotification } from '@/utils/taskNotify'

export type JobFinishKind = 'done' | 'error' | 'cancelled'

/** 还在跑的状态：由这些状态变成终态才算「执行完了」 */
export function isLiveJobStatus(s: unknown): boolean {
  return s === 'pending' || s === 'running'
}

/** 终态 → 提示类型；非终态返回 null */
export function finishKind(status: unknown): JobFinishKind | null {
  if (status === 'done') return 'done'
  if (status === 'error') return 'error'
  if (status === 'cancelled') return 'cancelled'
  return null
}

/**
 * 这一帧该不该提示：**上一帧还在跑、这一帧是终态**。
 * 用跃迁判定而不是"看到终态就提示"，是因为同一条 job 的终态帧可能重复到达
 * （SSE 重连后的 hello 快照、多实例广播），而"页面刚打开时看到一堆已完成的老 job"
 * 也绝不该触发提示。
 */
export function shouldAnnounce(prev: unknown, next: unknown): boolean {
  return isLiveJobStatus(prev) && finishKind(next) !== null
}

/**
 * 提示里显示的任务名。
 * job.title 的形态是 `${task.title} / ${sub.title}`，简单任务下两半逐字相同
 * （sub 是 task 的虚拟副本），直接显示会变成 "xxx / xxx" 这种复读。
 * 只在两半完全相同时折叠，避免把真的含 " / " 的标题改坏。
 */
export function jobNoticeTitle(job: { title?: unknown } | null | undefined): string {
  const raw = String(job?.title ?? '').trim()
  if (!raw) return $t('@WORKBENCH:未命名任务')
  const parts = raw.split(' / ')
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0]
  return raw
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 通知正文的第二行：出错给错误信息，正常完成给最后一行输出（通常就是模型的结论） */
export function jobNoticeDetail(job: Record<string, any> | null | undefined): string {
  if (!job) return ''
  const err = typeof job.error === 'string' ? job.error.trim() : ''
  if (err) return clip(err.replace(/\s+/g, ' '), 200)
  const out = typeof job.output === 'string' ? job.output : ''
  const lines = out.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length ? clip(lines[lines.length - 1], 200) : ''
}

// 文案一律写成字面量（形如「美元符号 t 左括号 ' 命名空间:键 '）」：
// i18n 体检脚本按字面量提取引用点，收进 Record 里当"值"用的 key 会被它判成
// "定义了但零引用"（见 scripts/verify-i18n-keys.mjs）。
// ⚠️ 也别在注释里写出完整的调用样例 —— 那个脚本是纯文本匹配，注释里的样例同样会被算作引用点。

export function useTaskNotifier() {
  let es: EventSource | null = null
  let stopped = false
  /** jobId → 上一次看到的状态。只做跃迁判定，不缓存 job 本体 */
  const lastStatus = new Map<string, string>()

  /** 发一条提示。系统通知发不出去（权限被拒 / 不支持）时退回应用内 toast */
  function announce(kind: JobFinishKind, job: Record<string, any>) {
    const name = jobNoticeTitle(job)
    const detail = jobNoticeDetail(job)
    const tag = `zen-gitsync-job-${job.id || ''}`
    if (shouldUseSystemNotification()) {
      let sent = false
      if (kind === 'done') {
        sent = notifySystem({ title: $t('@WORKBENCH:任务执行完成'), body: detail ? `${name}\n${detail}` : name, tag })
      } else if (kind === 'error') {
        sent = notifySystem({ title: $t('@WORKBENCH:任务执行出错'), body: detail ? `${name}\n${detail}` : name, tag })
      } else {
        sent = notifySystem({ title: $t('@WORKBENCH:任务已停止'), body: name, tag })
      }
      if (sent) return
    }
    if (kind === 'done') ElMessage.success($t('@WORKBENCH:已完成：{name}', { name }))
    else if (kind === 'error') ElMessage.error($t('@WORKBENCH:执行出错：{name}', { name }))
    else ElMessage.info($t('@WORKBENCH:已停止：{name}', { name }))
  }

  function handleJob(job: Record<string, any> | null | undefined) {
    if (!job || typeof job.id !== 'string' || !job.id) return
    const prev = lastStatus.get(job.id)
    const next = String(job.status || '')
    lastStatus.set(job.id, next)
    if (!shouldAnnounce(prev, next)) return
    const kind = finishKind(next)
    if (!kind) return
    // 开关在 config.json（全局），每次读实时值：用户在设置里关掉后立刻生效
    let enabled = false
    try { enabled = !!useConfigStore().notifyOnTaskDone } catch { enabled = false }
    if (!enabled) return
    announce(kind, job)
  }

  function handleRaw(evt: string, payload: any) {
    if (evt === 'hello') {
      // 首帧快照只记状态：页面刚打开时看到的一堆"已完成"是老账，不该弹提示
      for (const j of (Array.isArray(payload?.jobs) ? payload.jobs : [])) {
        if (j && typeof j.id === 'string') lastStatus.set(j.id, String(j.status || ''))
      }
      return
    }
    if (evt === 'job:update') handleJob(payload)
  }

  function start() {
    if (es || stopped || typeof EventSource === 'undefined') return
    es = new EventSource('/api/workbench/events')
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        handleRaw(data.event, data.payload)
      } catch { /* 坏帧忽略，与其它 SSE 消费方同口径 */ }
    }
    es.onerror = () => {
      es?.close()
      es = null
      if (stopped) return
      setTimeout(() => { if (!stopped) start() }, 3000)
    }
  }

  function stop() {
    stopped = true
    es?.close()
    es = null
  }

  return { start, stop }
}
