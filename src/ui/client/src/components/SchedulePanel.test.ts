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
// SchedulePanel 的接线测试：列表渲染 / 开关 / 运行 / 删除确认 / 表单提交 / 查看会话。
//
// ⚠️ $t 在测试里是 identity（vitest.setup.ts）：断言文案时写的是 **key**，
// 且插值参数不生效（'@SCHED:每天 {time}' 原样返回），所以断言一律用 key 片段。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'

vi.mock('@stores/configStore', async () => {
  const { mockConfigStore } = await import('@/test-utils/mockStores')
  return { useConfigStore: () => mockConfigStore }
})

vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return {
    ...actual,
    ElMessage: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
  }
})

import SchedulePanel from './SchedulePanel.vue'
import { mockConfigStore } from '@/test-utils/mockStores'
import { mountWithSetup } from '@/test-utils/mount'

type Call = { url: string; method: string; body: any }

let calls: Call[] = []
let listPayload: any[] = []
let listStatus = 200
let listBodyOverride: any = null

function installFetchMock() {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const method = String(init?.method || 'GET').toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, method, body })
    let payload: any = { success: true }
    if (url.includes('/api/schedules') && method === 'GET') {
      payload = listBodyOverride ?? { success: true, tasks: listPayload }
    }
    return new Response(JSON.stringify(payload), {
      status: listStatus,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

function makeTask(over: Record<string, any> = {}) {
  return {
    id: 'sch-t1',
    name: '每日拉代码',
    enabled: true,
    schedule: '0 9 * * *',
    cwd: 'D:/work',
    prompt: '检查所有仓库远端更新',
    model: '',
    locale: 'zh',
    sessionMode: 'dedicated',
    onMissed: 'run',
    sessionId: 'ag-x1',
    lastFire: '',
    lastRun: null,
    createdAt: '',
    updatedAt: '',
    nextRunAt: '',
    running: null,
    ...over,
  }
}

const STUBS = {
  CommonDialog: {
    props: ['modelValue', 'title'],
    template: '<div class="stub-dialog"><slot /></div>',
  },
}

async function mountPanel() {
  const w = mountWithSetup(SchedulePanel, { global: { stubs: STUBS } })
  await flushPromises()
  await flushPromises()
  return w
}

function buttonByText(w: any, text: string) {
  return w.findAll('button').find((b: any) => b.text().includes(text))
}

describe('SchedulePanel 列表', () => {
  beforeEach(() => {
    mockConfigStore.currentDirectory = 'D:/work'
    listStatus = 200
    listBodyOverride = null
    installFetchMock()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('渲染任务卡:名称、计划描述、下次时间、上次结果;停用态出现在文案里', async () => {
    listPayload = [
      makeTask({ id: 'sch-a', name: '每日拉代码', lastRun: { at: 'x', status: 'ok', durationMs: 12000 } }),
      makeTask({ id: 'sch-b', name: '停用中的任务', enabled: false, schedule: '*/30 * * * *' }),
    ]
    const w = await mountPanel()
    const text = w.text()
    expect(text).toContain('每日拉代码')
    expect(text).toContain('@SCHED:每天 {time}')
    expect(text).toContain('@SCHED:上次 {status}')
    expect(text).toContain('12s')
    expect(text).toContain('停用中的任务')
    expect(text).toContain('@SCHED:已停用')
    expect(text).toContain('@SCHED:每 {n} 分钟')
    expect(text).toContain('@SCHED:{on} 个启用 · {off} 个停用')
    w.unmount()
  })

  it('空列表显示空态,不再渲染卡片', async () => {
    listPayload = []
    const w = await mountPanel()
    expect(w.text()).toContain('@SCHED:还没有定时任务')
    expect(w.findAll('.schedule-card').length).toBe(0)
    w.unmount()
  })

  it('列表请求失败显示错误条', async () => {
    listStatus = 500
    listBodyOverride = { success: false, error: '读盘炸了' }
    const w = await mountPanel()
    expect(w.text()).toContain('@SCHED:操作失败：{error}')
    // $t 是 identity、不插值 → 具体错误内容查组件状态，不查渲染文本
    expect((w.vm as any).errorMsg).toBe('读盘炸了')
    w.unmount()
  })
})

describe('SchedulePanel 操作', () => {
  beforeEach(() => {
    mockConfigStore.currentDirectory = 'D:/work'
    listStatus = 200
    listBodyOverride = null
    installFetchMock()
    listPayload = [makeTask()]
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('开关切换发 PUT enabled=false', async () => {
    const w = await mountPanel()
    await w.find('.sch-switch').trigger('click')
    await flushPromises()
    const put = calls.find(c => c.method === 'PUT')
    expect(put, '应发出 PUT').toBeTruthy()
    expect(put!.url).toContain('/api/schedules/sch-t1')
    expect(put!.body).toEqual({ enabled: false })
    w.unmount()
  })

  it('「运行」发 POST /run;running 时按钮变「停止」并发 /stop', async () => {
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:运行')!.trigger('click')
    await flushPromises()
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/schedules/sch-t1/run'))).toBe(true)
    w.unmount()

    // running 态：列表拉到的任务带 running 信息
    listPayload = [makeTask({ running: { taskId: 'sch-t1', sessionId: 'ag-x1', startedAt: 'x' } })]
    const w2 = await mountPanel()
    expect(w2.text()).toContain('@SCHED:运行中')
    await buttonByText(w2, '@SCHED:停止')!.trigger('click')
    await flushPromises()
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/api/schedules/sch-t1/stop'))).toBe(true)
    w2.unmount()
  })

  it('删除要先确认,确认后发 DELETE', async () => {
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:删除')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('@SCHED:确定删除「{name}」吗？已产生的会话会保留，但任务不再执行。')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)

    const confirmBtn = w.findAll('button').find((b: any) => b.text() === '@SCHED:删除' && b.element.closest('.stub-dialog'))
    expect(confirmBtn).toBeTruthy()
    await confirmBtn!.trigger('click')
    await flushPromises()
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('sch-t1'))).toBe(true)
    w.unmount()
  })

  it('「查看会话」把 sessionId emit 给父级', async () => {
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:查看会话')!.trigger('click')
    expect(w.emitted('open-session')).toEqual([['ag-x1']])
    w.unmount()
  })
})

describe('SchedulePanel 表单', () => {
  beforeEach(() => {
    mockConfigStore.currentDirectory = 'D:/current'
    listStatus = 200
    listBodyOverride = null
    installFetchMock()
    listPayload = []
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('新建:默认每天 9:00、项目目录取当前项目;提交发 POST,cron 与草稿字段正确', async () => {
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:新建任务')!.trigger('click')
    const vm: any = w.vm
    // 默认值：每天 09:00 + 当前项目目录
    expect(vm.form.cwd).toBe('D:/current')
    expect(vm.cronPreview).toBe('0 9 * * *')

    vm.form.name = '每周依赖体检'
    vm.form.prompt = '扫描依赖漏洞并汇报'
    vm.form.freq = 'weekly'
    vm.form.weekday = 1
    vm.form.hour = 10
    vm.form.minute = 30
    await flushPromises()
    expect(vm.cronPreview).toBe('30 10 * * 1')

    await vm.submitForm()
    await flushPromises()
    const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/api/schedules'))
    expect(post).toBeTruthy()
    expect(post!.body).toMatchObject({
      name: '每周依赖体检',
      schedule: '30 10 * * 1',
      cwd: 'D:/current',
      prompt: '扫描依赖漏洞并汇报',
      enabled: true,
      onMissed: 'run',
    })
    w.unmount()
  })

  it('编辑:回填任务字段,自定义 cron 原样提交', async () => {
    listPayload = [makeTask({ id: 'sch-e1', name: '工作日检查', schedule: '0 9 * * 1-5' })]
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:编辑')!.trigger('click')
    const vm: any = w.vm
    expect(vm.editingId).toBe('sch-e1')
    expect(vm.form.name).toBe('工作日检查')
    expect(vm.form.freq).toBe('custom')
    expect(vm.cronPreview).toBe('0 9 * * 1-5')

    vm.form.name = '工作日检查（改）'
    await vm.submitForm()
    await flushPromises()
    const put = calls.find(c => c.method === 'PUT')
    expect(put!.body).toMatchObject({ name: '工作日检查（改）', schedule: '0 9 * * 1-5' })
    w.unmount()
  })

  it('校验:任务名/提示词为空时不发请求', async () => {
    const w = await mountPanel()
    await buttonByText(w, '@SCHED:新建任务')!.trigger('click')
    const vm: any = w.vm
    vm.form.name = ''
    vm.form.prompt = ''
    await vm.submitForm()
    expect(vm.formError).toBe('@SCHED:任务名不能为空')
    vm.form.name = '有名字了'
    await vm.submitForm()
    expect(vm.formError).toBe('@SCHED:提示词不能为空')
    expect(calls.filter(c => c.method === 'POST' || c.method === 'PUT').length).toBe(0)
    w.unmount()
  })
})
