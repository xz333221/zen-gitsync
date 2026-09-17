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
// 主 Agent 控制台数据源：GET /api/workbench/orchestrator 及其两个写接口。
//
// 关于「暂停调度」的真实语义（别在 UI 上把它说成别的）：
//   暂停只拦**自动派发** —— 通过控制台派发的指令在暂停期间只建任务不执行；
//   手动点执行、子任务单独执行一概不受影响。暂停的是主 Agent 的自主行为，不是用户的手。
//   拦截在服务端（routes/workbench/index.js），前端这个开关只是同一份状态的镜像。
//
// 活动流是服务端把 job 的起止事实 + 人类指令合成的结构化行，**文案由前端渲染**，
// 所以这里不要把 taskTitle 拼成句子，交给组件里带 $t() 的模板。

import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import type {
  OrchestratorActivity,
  OrchestratorInstruction,
  RunningAgent,
  Task,
} from '@/types/workbench'

export interface DispatchPayload {
  text: string
  projectPath?: string
  autoRun?: boolean
}

export function useOrchestrator() {
  const active = ref(true)
  const instructions = ref<OrchestratorInstruction[]>([])
  const activity = ref<OrchestratorActivity[]>([])
  const running = ref<RunningAgent[]>([])
  const updatedAt = ref<string | null>(null)
  const loaded = ref(false)
  const togglingSchedule = ref(false)
  const dispatching = ref(false)

  /** @param silent 静默刷新（轮询用），失败不弹 toast */
  async function loadOrchestrator(silent = false): Promise<boolean> {
    try {
      const res = await fetch('/api/workbench/orchestrator', { cache: 'no-store' }).then(r => r.json())
      if (!res?.success) {
        if (!silent) ElMessage.error(res?.error || $t('@WORKBENCH:读取编排状态失败'))
        return false
      }
      active.value = res.active !== false
      instructions.value = Array.isArray(res.instructions) ? res.instructions : []
      activity.value = Array.isArray(res.activity) ? res.activity : []
      running.value = Array.isArray(res.running) ? res.running : []
      updatedAt.value = res.updatedAt || null
      loaded.value = true
      return true
    } catch (err: any) {
      if (!silent) ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    }
  }

  /** 暂停 / 恢复调度。返回是否成功，失败时回滚本地开关 */
  async function setSchedulingActive(next: boolean): Promise<boolean> {
    if (togglingSchedule.value) return false
    const prev = active.value
    active.value = next
    togglingSchedule.value = true
    try {
      const res = await fetch('/api/workbench/orchestrator/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      }).then(r => r.json())
      if (!res?.success) {
        active.value = prev
        ElMessage.error(res?.error || $t('@WORKBENCH:切换调度状态失败'))
        return false
      }
      active.value = res.active !== false
      ElMessage.success(
        active.value ? $t('@WORKBENCH:已恢复调度') : $t('@WORKBENCH:已暂停调度，派发将只建任务不执行')
      )
      return true
    } catch (err: any) {
      active.value = prev
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    } finally {
      togglingSchedule.value = false
    }
  }

  /**
   * 派发一条指令。成功返回新建的任务（调用方据此打开编辑器或刷新看板）。
   * 400 之外的失败不在这里 toast 之外做特殊处理 —— 服务端的错误文案（目录不存在等）
   * 比前端能编的更有信息量，直接透传。
   */
  async function dispatch(payload: DispatchPayload): Promise<{ task: Task | null; ran: boolean } | null> {
    if (dispatching.value) return null
    dispatching.value = true
    try {
      const res = await fetch('/api/workbench/orchestrator/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: payload.text,
          projectPath: payload.projectPath || '',
          autoRun: payload.autoRun !== false,
        }),
      }).then(r => r.json())
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:派发失败'))
        return null
      }
      await loadOrchestrator(true)
      return { task: res.task || null, ran: !!res.ran }
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return null
    } finally {
      dispatching.value = false
    }
  }

  return {
    active, instructions, activity, running, updatedAt, loaded,
    togglingSchedule, dispatching,
    loadOrchestrator, setSchedulingActive, dispatch,
  }
}
