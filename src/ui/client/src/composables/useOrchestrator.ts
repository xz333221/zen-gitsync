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
// 主 Agent 控制台数据源：GET /api/workbench/orchestrator 及其六个写接口
// （调度开关 / 派发 / 全局默认提示词 / 项目默认提示词 / 立即报告 / 报告间隔）。
//
// 关于「暂停调度」的真实语义（别在 UI 上把它说成别的）：
//   暂停只拦**自动派发** —— 通过控制台派发的指令在暂停期间只建任务不执行；
//   手动点执行、子任务单独执行一概不受影响。暂停的是主 Agent 的自主行为，不是用户的手。
//   拦截在服务端（routes/workbench/index.js），前端这个开关只是同一份状态的镜像。
//
// 关于「默认提示词」：
//   两级（全局 + 每个项目一条），派发时服务端按**落点项目**解析后拼在指令之前，
//   并抄进任务的 simpleOverride —— 前端只负责编辑与显示，不自己拼提示词
//   （两边各拼一次必然会分叉）。生效规则见服务端 resolveDispatchPrompt。
//
// 关于「进度报告」：
//   报告**由服务端生成**（自动报告是服务端定时器，前端定时器在标签页隐藏后就不跑了，
//   而那正是最需要"回来看看刚才发生了什么"的时刻）。所以这个组合式函数里
//   没有报告相关的定时器，只有三件事：读列表、手动触发一次、改间隔。
//   间隔走轮询下发的 reportIntervalMs（多标签页 / 多实例共用同一份设置），
//   报告正文走单独接口 —— 一份几 KB × 20 份塞进 5s 轮询里纯属浪费。
//
// 活动流是服务端把 job 的起止事实 + 人类指令合成的结构化行，**文案由前端渲染**，
// 所以这里不要把 taskTitle 拼成句子，交给组件里带 $t() 的模板。
// （右栏的「活动日志」已经换成进度报告，这条流现在只供顶栏「今日完成」计数。）

import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import type {
  Attachment,
  OrchestratorActivity,
  OrchestratorInstruction,
  ProgressReport,
  ProjectPromptEntry,
  RunningAgent,
  Task,
} from '@/types/workbench'
import type { TaskExecutorId } from '@/utils/taskExecutor'
import { DEFAULT_REPORT_INTERVAL_MS, normalizeReportInterval } from '@/utils/progressReport'
import { useConfigStore } from '@/stores/configStore'
import { useWorkbenchStatusStore } from '@/stores/workbenchStatus'

/**
 * 指令正文上限的**本地兜底值**。
 *
 * 真实值由服务端 /api/workbench/orchestrator 的 maxInstructionChars 下发
 * （见服务端 shared.js 的 MAX_INSTRUCTION_CHARS —— 那是派发校验的唯一出处）。
 * 这里的数字只服务于"首帧还没拿到状态"的那几百毫秒：宁可先用一份与服务端
 * 一致的值，也不要让输入框在状态到达前短暂显示成别的上限。
 *
 * ⚠️ 改这个数字必须同步改 shared.js 的 MAX_INSTRUCTION_CHARS，两边分叉的表现是
 * "刷新前能发、刷新后发不出去"。dispatchInstruction 的单测钉住了服务端那一侧。
 */
export const DEFAULT_MAX_INSTRUCTION_CHARS = 100000

export interface DispatchPayload {
  text: string
  projectPath?: string
  autoRun?: boolean
  /** 已上传到暂存区的附件。只回传 id / ext / originalName，服务端自己按 id 找文件 */
  attachments?: Attachment[]
  /** false = 本次派发不附加默认提示词（默认附加） */
  useDefaultPrompt?: boolean
  /** 本次派发建的任务用哪个本地 CLI 执行（claude | opencode | codex）。缺省走服务端配置默认 */
  executor?: TaskExecutorId
}

export function useOrchestrator() {
  const active = ref(true)
  const instructions = ref<OrchestratorInstruction[]>([])
  const activity = ref<OrchestratorActivity[]>([])
  /**
   * 指令正文上限（字符）。**以服务端下发的为准**，本地这份只是首次渲染前的兜底。
   *
   * 为什么不在前端写死：派发校验在服务端（dispatchInstruction.js），两边各写一份
   * 就会出现"输入框显示还有余量、点下去服务端 400"，而指令正文已经发出去了。
   * 与 reportIntervalMs 同一套口径（值以服务端为准，本地只是镜像）。
   */
  const maxInstructionChars = ref(DEFAULT_MAX_INSTRUCTION_CHARS)
  const running = ref<RunningAgent[]>([])
  const updatedAt = ref<string | null>(null)
  const loaded = ref(false)
  const togglingSchedule = ref(false)
  const dispatching = ref(false)
  /** 全局默认提示词（'' = 没设置） */
  const defaultPrompt = ref('')
  /** 各项目默认提示词，键为归一化项目路径（与 ProjectSummary.key 同口径） */
  const projectPrompts = ref<Record<string, ProjectPromptEntry>>({})
  /** 进度报告历史（新的在前）。正文走单独接口，不在这份 5s 轮询里 */
  const reports = ref<ProgressReport[]>([])
  const loadingReports = ref(false)
  /** 正在生成一份报告（手动触发期间；自动报告在服务端跑，前端看不到这个态） */
  const generatingReport = ref(false)
  /** 自动报告间隔（毫秒，0 = 关闭）。值以服务端为准，本地只是镜像 */
  const reportIntervalMs = ref(DEFAULT_REPORT_INTERVAL_MS)

  /** @param silent 静默刷新（轮询用），失败不弹 toast */
  async function loadOrchestrator(silent = false): Promise<boolean> {
    try {
      const res = await fetch('/api/workbench/orchestrator', { cache: 'no-store' }).then(r => r.json())
      if (!res?.success) {
        if (!silent) ElMessage.error(res?.error || $t('@WORKBENCH:读取编排状态失败'))
        return false
      }
      active.value = res.active !== false
      // 只认正整数：老服务端没有这个字段（undefined）时保留本地兜底值，
      // 别把计数器的上限渲染成 0 / undefined
      if (Number.isInteger(res.maxInstructionChars) && res.maxInstructionChars > 0) {
        maxInstructionChars.value = res.maxInstructionChars
      }
      instructions.value = Array.isArray(res.instructions) ? res.instructions : []
      activity.value = Array.isArray(res.activity) ? res.activity : []
      running.value = Array.isArray(res.running) ? res.running : []
      // 左栏工作台角标用的就是这一个数（口径 = 看板表头「活跃执行」）：
      // 服务端已经把 running | pending 和别的 g ui 实例的 job 都算好了，
      // 前端不再自己从本地 jobs 数组里数一份（那会漏 pending、漏跨实例，见 stores/workbenchStatus.ts）。
      useWorkbenchStatusStore().setRunning(running.value.length)
      updatedAt.value = res.updatedAt || null
      defaultPrompt.value = typeof res.defaultPrompt === 'string' ? res.defaultPrompt : ''
      projectPrompts.value = res.projectPrompts && typeof res.projectPrompts === 'object'
        ? res.projectPrompts
        : {}
      reportIntervalMs.value = normalizeReportInterval(res.reportIntervalMs)
      loaded.value = true
      return true
    } catch (err: any) {
      if (!silent) ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    }
  }

  /**
   * 读报告历史。
   *
   * 与轮询分开取：一份报告几 KB，历史 20 份就是几十 KB，5s 一轮地拖着走纯属浪费
   * （与「任务详情不进看板轮询」同一个理由）。由调用方在挂载时取一次、
   * 之后按 30s 的节奏刷新 —— 自动报告是服务端定时器产生的，前端不知道它什么时候落盘。
   */
  async function loadReports(silent = false): Promise<boolean> {
    if (loadingReports.value) return false
    loadingReports.value = true
    try {
      const res = await fetch('/api/workbench/orchestrator/reports', { cache: 'no-store' }).then(r => r.json())
      if (!res?.success) {
        if (!silent) ElMessage.error(res?.error || $t('@WORKBENCH:读取进度报告失败'))
        return false
      }
      reports.value = Array.isArray(res.reports) ? res.reports : []
      return true
    } catch (err: any) {
      // 报告读不到不该打断看板：静默刷新时连 toast 都不弹，下一轮自然会重试
      if (!silent) ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    } finally {
      loadingReports.value = false
    }
  }

  /**
   * 立即生成一份进度报告。
   *
   * 语言按当前界面语言传给服务端 —— 自动报告那边读的是配置里的语言，
   * 手动这一下如果用户刚切了语言，以他眼前看到的界面为准更合理。
   *
   * 服务端在没有任务在跑时返回 `report: null`（不生成、也不落盘一条空报告，
   * 见 routes/workbench/index.js 的 runProgressReport）。这一下是用户主动点的，
   * 必须有回应 —— 否则面板看不出任何变化，用户会以为按钮没生效、再点一下，
   * 历史里就会出现重复记录。所以这里弹一句实话。
   */
  async function generateReport(): Promise<ProgressReport | null> {
    if (generatingReport.value) return null
    generatingReport.value = true
    try {
      const locale = String(useConfigStore().locale || '').startsWith('en') ? 'en' : 'zh'
      const res = await fetch('/api/workbench/orchestrator/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale }),
      }).then(r => r.json())
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:生成进度报告失败'))
        return null
      }
      if (!res.report) {
        ElMessage.info($t('@WORKBENCH:当前没有正在执行的任务，没有可汇报的进度'))
        return null
      }
      // 就地把新报告插到最前，不再多打一次列表接口：这一份就是刚生成的那份
      reports.value = [res.report, ...reports.value].slice(0, 20)
      return res.report
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return null
    } finally {
      generatingReport.value = false
    }
  }

  /** 改自动报告间隔（毫秒，0 = 关闭自动报告）。服务端是白名单的唯一权威 */
  async function setReportInterval(ms: number): Promise<boolean> {
    try {
      const res = await fetch('/api/workbench/orchestrator/report-interval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMs: ms }),
      }).then(r => r.json())
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:保存失败'))
        return false
      }
      reportIntervalMs.value = normalizeReportInterval(res.reportIntervalMs)
      return true
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    }
  }

  /**
   * 写全局默认提示词（'' = 清除）。
   *
   * 成功后就地更新本地值而不是再拉一次整份状态：这个弹窗可能正开在用户面前，
   * 让「保存」按钮的生命周期和一次网络往返绑在一起就够，不必多打一轮轮询接口。
   */
  async function saveDefaultPrompt(prompt: string): Promise<boolean> {
    try {
      const res = await fetch('/api/workbench/orchestrator/default-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      }).then(r => r.json())
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:保存失败'))
        return false
      }
      defaultPrompt.value = typeof res.defaultPrompt === 'string' ? res.defaultPrompt : ''
      ElMessage.success($t('@WORKBENCH:已保存全局默认提示词'))
      return true
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    }
  }

  /** 写某个项目的默认提示词（'' = 清除该项目这一条） */
  async function saveProjectPrompt(projectPath: string, prompt: string): Promise<boolean> {
    try {
      const res = await fetch('/api/workbench/orchestrator/project-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, prompt }),
      }).then(r => r.json())
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:保存失败'))
        return false
      }
      projectPrompts.value = res.projectPrompts && typeof res.projectPrompts === 'object'
        ? res.projectPrompts
        : {}
      ElMessage.success($t('@WORKBENCH:已保存项目默认提示词'))
      return true
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
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
          // 省缺即附加：默认提示词的默认行为是"生效"，勾掉才不带
          useDefaultPrompt: payload.useDefaultPrompt !== false,
          // 执行器缺省时服务端回落到配置默认；非法值也是同一个回落，不用前端兜底
          executor: payload.executor,
          // 只给 id / ext / originalName：路径由服务端在暂存区里自己拼，
          // 前端拿不到、也指定不了 absolutePath。
          attachments: (payload.attachments || []).map(a => ({
            id: a.id,
            ext: a.ext,
            originalName: a.originalName,
          })),
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
    togglingSchedule, dispatching, maxInstructionChars,
    defaultPrompt, projectPrompts,
    reports, loadingReports, generatingReport, reportIntervalMs,
    loadOrchestrator, setSchedulingActive, dispatch,
    saveDefaultPrompt, saveProjectPrompt,
    loadReports, generateReport, setReportInterval,
  }
}
