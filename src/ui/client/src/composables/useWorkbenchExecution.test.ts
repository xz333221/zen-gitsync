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
// 任务执行中「排队续聊」的回归测试（2026-10-07）。
//
// 需求：任务在跑的时候输入框照样能用，发出去的内容先排队，等这一轮 job 进终态自动接上，
// 附件也要跟着走。这条链路的坑几乎全在**时序**上，不是肉眼看一眼就能确认的：
//   1. 在跑的时候发 → 必须只入队，不能直接 POST（否则等于插队/并发两轮）
//   2. job 从 running 变终态 → 才把队首发出去；**连着来的终态事件不能把两条一起发**
//   3. 附件**等真正发出去那一刻才上传**（排队时就传的话，用户把这条删了会留孤儿附件）
//   4. 「重新执行 / 清空执行」会把 job 全删掉，那时也会走到终态分支 —— 不该补发
//
// 刻意直接驱动 composable（不挂组件）：这里要守的是队列时序，不是渲染。

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { computed, nextTick, ref, watchEffect } from 'vue'
import type { Job, Task } from '@/types/workbench'
import type { TaskExecutorId } from '@/utils/taskExecutor'
import type { SelectedFile } from 'zen-ai-chat-ui'

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  ElMessageBox: { confirm: vi.fn(async () => 'confirm') }
}))

import { useWorkbenchExecution } from './useWorkbenchExecution'
import { ElMessage } from 'element-plus'

function makeTask(patch: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '任务',
    desc: '描述',
    simpleOverride: '',
    projectPath: 'C:\\proj',
    status: 'todo',
    ...patch
  } as Task
}

function makeJob(patch: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    taskId: 't1',
    subId: 't1__simple',
    title: '任务',
    status: 'running',
    prompt: '看下目录',
    output: '',
    pid: null,
    startedAt: '2026-10-07T08:00:00.000Z',
    endedAt: null,
    exitCode: null,
    error: null,
    ...patch
  }
}

function makeFile(name = 'a.png'): SelectedFile {
  return { id: `f-${name}`, file: new File(['x'], name, { type: 'image/png' }) }
}

/** 让 watch → async flush 这条链跑完（终态事件之后要用） */
async function settle() {
  await nextTick()
  await new Promise(r => setTimeout(r, 0))
  await nextTick()
}

let continueBodies: any[] = []
/** 打开后 /continue 会挂住不返回，用来把「一笔在途请求」这个瞬间钉住 */
let holdContinue = false
let releaseContinue: (() => void) | null = null

beforeEach(() => {
  continueBodies = []
  holdContinue = false
  releaseContinue = null
  vi.mocked(ElMessage.error).mockClear()
  vi.mocked(ElMessage.success).mockClear()
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/continue')) {
      continueBodies.push(JSON.parse(init.body))
      if (holdContinue) await new Promise<void>(res => { releaseContinue = res })
      return { json: async () => ({ success: true, message: '已加入续接队列' }) }
    }
    return { json: async () => ({ success: true }) }
  }))
})

function setup(initialJobs: Job[]) {
  const jobs = ref<Job[]>(initialJobs)
  const tasks = ref<Task[]>([makeTask()])
  const selectedTask = computed<Task | null>(() => tasks.value[0] ?? null)
  const uploadAttachment = vi.fn(async () => {})
  const api = useWorkbenchExecution(jobs, tasks, selectedTask, {
    clearJobsByTask: vi.fn(async () => 0),
    persistTask: vi.fn(async () => true),
    uploadAttachment,
    getExecutor: () => 'claude' as TaskExecutorId
  })
  return { jobs, tasks, uploadAttachment, api }
}

describe('排队续聊', () => {
  test('执行中发送 → 只入队，不直接发请求', async () => {
    const { api } = setup([makeJob({ status: 'running' })])

    await api.onContinueSendFromChat(makeTask(), { text: '顺便把 README 也更新了', files: [] })
    await settle()

    expect(continueBodies).toHaveLength(0)
    expect(api.queuedChatsOf('t1').map(q => q.text)).toEqual(['顺便把 README 也更新了'])
  })

  test('job 进终态 → 队首自动发出去，队列清空', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '第一条', files: [] })

    // 这一条断言是反证时补上的：不写它，把「在跑就排队」那段撤掉之后
    // 本用例照样绿（直接发也能凑出「请求里有第一条 + 队列为空」）
    expect(continueBodies).toHaveLength(0)

    jobs.value[0] = makeJob({ status: 'done' })
    await settle()

    expect(continueBodies.map(b => b.userMessage)).toEqual(['第一条'])
    expect(api.queuedChatsOf('t1')).toHaveLength(0)
  })

  test('队里两条：只发队首，第二条等下一轮终态（不能一次全发出去）', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '第一条', files: [] })
    await api.onContinueSendFromChat(makeTask(), { text: '第二条', files: [] })
    expect(api.queuedChatsOf('t1')).toHaveLength(2)

    jobs.value[0] = makeJob({ status: 'done' })
    await settle()
    expect(continueBodies.map(b => b.userMessage)).toEqual(['第一条'])
    expect(api.queuedChatsOf('t1').map(q => q.text)).toEqual(['第二条'])

    // 新一轮跑完 → 第二条才出去
    jobs.value.push(makeJob({ id: 'j2', subId: 't1__simple__r1', status: 'running' }))
    await settle()
    jobs.value[1] = makeJob({ id: 'j2', subId: 't1__simple__r1', status: 'done' })
    await settle()
    expect(continueBodies.map(b => b.userMessage)).toEqual(['第一条', '第二条'])
    expect(api.queuedChatsOf('t1')).toHaveLength(0)
  })

  test('附件等真正发出去那一刻才上传（排队时不动它）', async () => {
    const { jobs, uploadAttachment, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '带张图', files: [makeFile('shot.png')] })

    expect(uploadAttachment).not.toHaveBeenCalled()
    expect(api.queuedChatsOf('t1')[0].files.map(f => f.file.name)).toEqual(['shot.png'])

    jobs.value[0] = makeJob({ status: 'done' })
    await settle()

    expect(uploadAttachment).toHaveBeenCalledTimes(1)
    expect(continueBodies[0].userMessage).toBe('带张图')
  })

  test('「清空执行」把 job 全删掉时不补发、也不弹「没有可续接的会话」', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '排队中', files: [] })

    jobs.value = []
    await settle()

    expect(continueBodies).toHaveLength(0)
    // 这条才是守卫真正买到的东西：没有它，flush 会一路走到 continueChat，
    // 那边发现没有 job 就弹一个错误提示 —— 用户会莫名其妙挨一下，
    // 而队列其实还好好地留着（等下一轮跑完照发）
    expect(ElMessage.error).not.toHaveBeenCalled()
    expect(api.queuedChatsOf('t1')).toHaveLength(1)
  })

  test('空闲时发送 → 直接发，不进队列', async () => {
    const { api } = setup([makeJob({ status: 'done' })])

    await api.onContinueSendFromChat(makeTask(), { text: '直接发', files: [] })
    await settle()

    expect(continueBodies.map(b => b.userMessage)).toEqual(['直接发'])
    expect(api.queuedChatsOf('t1')).toHaveLength(0)
  })

  test('连点「立即发送」/ 终态与手动重试撞车时也只发一条（在途闩锁）', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: 'A', files: [] })
    await api.onContinueSendFromChat(makeTask(), { text: 'B', files: [] })

    // 把第一笔请求挂住，制造「还在途」这个瞬间
    holdContinue = true
    jobs.value[0] = makeJob({ status: 'done' })
    await settle()
    expect(continueBodies.map(b => b.userMessage)).toEqual(['A'])

    // 这一笔还没回来时又来了两次触发（「立即发送」连点两下；
    // watch 那一路是按「在跑→不跑」的转变触发的，第二次终态事件不会重复进这里，
    // 所以真正需要闩锁的是这个手动的入口）
    void api.flushNextQueued('t1')
    void api.flushNextQueued('t1')
    await settle()
    // 没有闩锁的话这里会变成 ['A','A','A'] —— 队首被发好几遍
    expect(continueBodies.map(b => b.userMessage)).toEqual(['A'])

    holdContinue = false
    releaseContinue?.()
    await settle()
    expect(continueBodies.map(b => b.userMessage)).toEqual(['A'])
    expect(api.queuedChatsOf('t1').map(q => q.text)).toEqual(['B'])
  })

  test('最后一条移除后，模板读到的 length 要真的被推到 0（依赖链不能断）', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: 'A', files: [] })

    // 模板那边就是 `v-if="selectedTaskQueue.length"`，这里照同一读法建依赖：
    // 只断言 queuedChatsOf() 的返回值是**假绿** —— 2026-10-07 真机探针上就是
    // 「最后一条发完/移除后排队条还挂着」，而直接读数组的断言照样通过。
    const queueLen = computed(() => api.queuedChatsOf('t1').length)
    const seen: number[] = []
    watchEffect(() => { seen.push(queueLen.value) })
    expect(queueLen.value).toBe(1)

    jobs.value[0] = makeJob({ status: 'done' })
    await settle()

    expect(queueLen.value).toBe(0)
    expect(seen).toContain(0)
  })

  test('移出队列', async () => {
    const { api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '不要了', files: [] })
    const id = api.queuedChatsOf('t1')[0].id

    api.removeQueuedChat('t1', id)
    await settle()

    expect(api.queuedChatsOf('t1')).toHaveLength(0)
  })

  test('发送失败时留在队里，不静默丢掉', async () => {
    const { jobs, api } = setup([makeJob({ status: 'running' })])
    await api.onContinueSendFromChat(makeTask(), { text: '会失败', files: [] })

    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/continue')) return { json: async () => ({ success: false, error: 'boom' }) }
      return { json: async () => ({ success: true }) }
    }))

    jobs.value[0] = makeJob({ status: 'done' })
    await settle()

    expect(api.queuedChatsOf('t1').map(q => q.text)).toEqual(['会失败'])
  })
})
