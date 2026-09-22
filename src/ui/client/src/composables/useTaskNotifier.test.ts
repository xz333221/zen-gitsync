// useTaskNotifier 的回归测试。
//
// 这个 composable 最容易出错的不是"能不能弹提示"，而是**什么时候不该弹**：
// SSE 重连后的 hello 快照、重复的终态帧、页面刚打开时看到的一堆历史 job。
// 所以用例里"不该弹"的部分比"该弹"的部分还多。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// vi.hoisted：mock 工厂会在 import 期就执行，直接用普通 let 会撞 TDZ
const state = vi.hoisted(() => ({ notifyEnabled: false }))
const sys = vi.hoisted(() => ({ useSystem: false, canSend: true, sent: [] as any[] }))

vi.mock('@stores/configStore', () => ({
  useConfigStore: () => ({
    get notifyOnTaskDone() {
      return state.notifyEnabled
    },
  }),
}))

vi.mock('@/utils/taskNotify', () => ({
  shouldUseSystemNotification: () => sys.useSystem,
  notifySystem: (opts: any) => {
    sys.sent.push(opts)
    return sys.canSend
  },
}))

import { ElMessage } from 'element-plus'
import {
  useTaskNotifier,
  isLiveJobStatus,
  finishKind,
  shouldAnnounce,
  jobNoticeTitle,
  jobNoticeDetail,
} from './useTaskNotifier'

/** 假 EventSource：只保留被测代码用到的三个成员，并暴露 emit 让我们手动推帧 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  emit(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
  }
  frame(event: string, payload: unknown) {
    this.emit({ event, payload })
  }
}

const successCalls = () => (ElMessage.success as unknown as { mock: { calls: any[][] } }).mock.calls
const errorCalls = () => (ElMessage.error as unknown as { mock: { calls: any[][] } }).mock.calls
const infoCalls = () => (ElMessage.info as unknown as { mock: { calls: any[][] } }).mock.calls

/** 建一个实例 + 连上假 SSE，返回该连接 */
function connect() {
  const notifier = useTaskNotifier()
  notifier.start()
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  return { notifier, es }
}

const runningJob = (id: string, title = '写代码 / 写代码') => ({ id, title, status: 'running' })

beforeEach(() => {
  FakeEventSource.instances = []
  state.notifyEnabled = false
  sys.useSystem = false
  sys.canSend = true
  sys.sent = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ── 纯函数口径 ───────────────────────────────────────────────────────────

describe('isLiveJobStatus / finishKind', () => {
  it('只有 pending / running 算"还在跑"', () => {
    expect(isLiveJobStatus('pending')).toBe(true)
    expect(isLiveJobStatus('running')).toBe(true)
    for (const s of ['done', 'error', 'cancelled', '', undefined, null, 'foo']) {
      expect(isLiveJobStatus(s)).toBe(false)
    }
  })

  it('三个终态各有各的提示类型，其它状态返回 null', () => {
    expect(finishKind('done')).toBe('done')
    expect(finishKind('error')).toBe('error')
    expect(finishKind('cancelled')).toBe('cancelled')
    expect(finishKind('running')).toBeNull()
    expect(finishKind(undefined)).toBeNull()
  })
})

describe('shouldAnnounce', () => {
  it('只有"上一帧在跑、这一帧终态"才提示', () => {
    expect(shouldAnnounce('running', 'done')).toBe(true)
    expect(shouldAnnounce('pending', 'error')).toBe(true)
  })

  it('重复的终态帧不提示（SSE 重连 / 多实例广播会重复到达）', () => {
    expect(shouldAnnounce('done', 'done')).toBe(false)
    expect(shouldAnnounce('error', 'error')).toBe(false)
  })

  it('第一次见到就是终态不提示（页面刚打开时的一堆历史 job）', () => {
    expect(shouldAnnounce(undefined, 'done')).toBe(false)
    expect(shouldAnnounce(undefined, 'error')).toBe(false)
  })

  it('还在跑不提示', () => {
    expect(shouldAnnounce('pending', 'running')).toBe(false)
    expect(shouldAnnounce('running', 'running')).toBe(false)
  })
})

describe('jobNoticeTitle', () => {
  it('折叠"任务名 / 任务名"这种复读（历史数据的 job.title 两半相同）', () => {
    expect(jobNoticeTitle({ title: '写代码 / 写代码' })).toBe('写代码')
  })

  it('两半不同时原样保留（子任务 / 真的含 " / " 的标题不能被改坏）', () => {
    expect(jobNoticeTitle({ title: '大任务 / 子任务 A' })).toBe('大任务 / 子任务 A')
    expect(jobNoticeTitle({ title: 'a / b / c' })).toBe('a / b / c')
  })

  it('标题为空时回落到 i18n 文案（测试环境 $t 是 identity，直接拿到 key）', () => {
    expect(jobNoticeTitle({ title: '   ' })).toBe('@WORKBENCH:未命名任务')
    expect(jobNoticeTitle(null)).toBe('@WORKBENCH:未命名任务')
  })
})

describe('jobNoticeDetail', () => {
  it('有错误时优先给错误信息，并把换行压成空格', () => {
    expect(jobNoticeDetail({ error: '  boom\n\n  failed  ' })).toBe('boom failed')
  })

  it('正常完成时给最后一行非空输出（通常就是模型的结论）', () => {
    expect(jobNoticeDetail({ output: '第一步\n\n第二步\n\n' })).toBe('第二步')
  })

  it('输出为空 / 全空白时返回空串，而不是 undefined', () => {
    expect(jobNoticeDetail({ output: '   \n\n' })).toBe('')
    expect(jobNoticeDetail({})).toBe('')
    expect(jobNoticeDetail(null)).toBe('')
  })

  it('超长内容截到 200 字以内并以省略号收尾', () => {
    const detail = jobNoticeDetail({ output: 'x'.repeat(500) })
    expect(detail.length).toBeLessThanOrEqual(200)
    expect(detail.endsWith('…')).toBe(true)
  })
})

// ── SSE 订阅与提示决策 ───────────────────────────────────────────────────

describe('useTaskNotifier 订阅', () => {
  it('start 连一条 /api/workbench/events，重复 start 不叠加连接', () => {
    const { notifier } = connect()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/workbench/events')
    notifier.start()
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('环境没有 EventSource 时 start 静默跳过', () => {
    vi.stubGlobal('EventSource', undefined)
    const notifier = useTaskNotifier()
    expect(() => notifier.start()).not.toThrow()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('hello 快照只记状态，绝不提示（页面刚打开时看到的历史 job 是老账）', () => {
    state.notifyEnabled = true
    sys.useSystem = true
    const { es } = connect()
    es.frame('hello', { jobs: [{ id: 'old', title: 't / t', status: 'done' }] })
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(0)
  })

  it('坏帧（非 JSON）被忽略，不影响后续帧', () => {
    state.notifyEnabled = true
    const { es } = connect()
    expect(() => es.emit('{ not json')).not.toThrow()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: '写代码 / 写代码', status: 'done' })
    expect(successCalls()).toHaveLength(1)
  })

  it('缺少 id 的 job 帧被忽略', () => {
    state.notifyEnabled = true
    const { es } = connect()
    es.frame('job:update', { title: 'x', status: 'done' })
    es.frame('job:update', null)
    expect(successCalls()).toHaveLength(0)
  })
})

describe('useTaskNotifier 提示决策', () => {
  it('开关关着时跑完也不提示（默认关）', () => {
    sys.useSystem = true
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: '写代码 / 写代码', status: 'done' })
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(0)
  })

  it('开关打开 + 页面在后台 → 走系统通知，且不再叠一条应用内提示', () => {
    state.notifyEnabled = true
    sys.useSystem = true
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: '写代码 / 写代码', status: 'done', output: '做完了' })
    expect(sys.sent).toHaveLength(1)
    expect(sys.sent[0]).toMatchObject({
      title: '@WORKBENCH:任务执行完成',
      body: '写代码\n做完了',
      tag: 'zen-gitsync-job-j1',
    })
    expect(successCalls()).toHaveLength(0)
  })

  it('页面在前台 → 应用内提示（标题复用任务名，正文不再重复）', () => {
    state.notifyEnabled = true
    sys.useSystem = false
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: '写代码 / 写代码', status: 'done' })
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(1)
    // 测试环境的 $t 是 identity（setup 里 mock 掉了真实语言包），所以这里只能断言
    // 用的是"已完成"那条 key；插值进去的任务名在系统通知那条路径上另有断言覆盖。
    expect(successCalls()[0][0]).toBe('@WORKBENCH:已完成：{name}')
  })

  it('前台状态下出错走 error toast、停止走 info toast（提示级别不能一律 success）', () => {
    state.notifyEnabled = true
    sys.useSystem = false
    const { es } = connect()
    es.frame('job:update', runningJob('a'))
    es.frame('job:update', { id: 'a', title: '任务A / 任务A', status: 'error', error: 'boom' })
    es.frame('job:update', runningJob('b'))
    es.frame('job:update', { id: 'b', title: '任务B / 任务B', status: 'cancelled' })
    expect(errorCalls()).toHaveLength(1)
    expect(errorCalls()[0][0]).toBe('@WORKBENCH:执行出错：{name}')
    expect(infoCalls()).toHaveLength(1)
    expect(infoCalls()[0][0]).toBe('@WORKBENCH:已停止：{name}')
    expect(successCalls()).toHaveLength(0)
  })

  it('系统通知发不出去（权限被拒）时退回应用内提示，不让用户什么都收不到', () => {
    state.notifyEnabled = true
    sys.useSystem = true
    sys.canSend = false
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: '写代码 / 写代码', status: 'done' })
    expect(sys.sent).toHaveLength(1)
    expect(successCalls()).toHaveLength(1)
  })

  it('出错 / 主动停止各走各的文案', () => {
    state.notifyEnabled = true
    sys.useSystem = true
    const { es } = connect()
    es.frame('job:update', runningJob('a'))
    es.frame('job:update', { id: 'a', title: '任务A / 任务A', status: 'error', error: 'CLI 挂了' })
    expect(sys.sent[0].title).toBe('@WORKBENCH:任务执行出错')
    expect(sys.sent[0].body).toBe('任务A\nCLI 挂了')

    es.frame('job:update', runningJob('b'))
    es.frame('job:update', { id: 'b', title: '任务B / 任务B', status: 'cancelled' })
    expect(sys.sent[1].title).toBe('@WORKBENCH:任务已停止')
    expect(sys.sent[1].body).toBe('任务B')
  })

  it('同一条 job 的重复终态帧只提示一次', () => {
    state.notifyEnabled = true
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    es.frame('job:update', { id: 'j1', title: 't / t', status: 'done' })
    es.frame('job:update', { id: 'j1', title: 't / t', status: 'done' })
    expect(successCalls()).toHaveLength(1)
  })

  it('多条 job 状态互不干扰', () => {
    state.notifyEnabled = true
    const { es } = connect()
    es.frame('job:update', runningJob('a'))
    es.frame('job:update', runningJob('b'))
    es.frame('job:update', { id: 'a', title: 'A / A', status: 'done' })
    es.frame('job:update', { id: 'b', title: 'B / B', status: 'done' })
    expect(successCalls()).toHaveLength(2)
    expect(infoCalls()).toHaveLength(0)
  })

  it('开关是实时读的：任务跑的过程中关掉，结束时就不提示了', () => {
    state.notifyEnabled = true
    const { es } = connect()
    es.frame('job:update', runningJob('j1'))
    state.notifyEnabled = false
    es.frame('job:update', { id: 'j1', title: 't / t', status: 'done' })
    expect(successCalls()).toHaveLength(0)
  })
})

describe('useTaskNotifier 连接生命周期', () => {
  it('连接出错后 3 秒重连', () => {
    vi.useFakeTimers()
    const { es } = connect()
    es.onerror?.()
    expect(FakeEventSource.instances).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('stop 之后不再重连（组件卸载后不该继续拉连接）', () => {
    vi.useFakeTimers()
    const { notifier, es } = connect()
    es.onerror?.()
    notifier.stop()
    vi.advanceTimersByTime(10000)
    expect(FakeEventSource.instances).toHaveLength(1)
    // 重复 stop 也不该抛
    expect(() => notifier.stop()).not.toThrow()
  })

  it('stop 会关闭当前连接，stop 后 start 不再重新连（终态语义）', () => {
    const { notifier, es } = connect()
    notifier.stop()
    expect(es.close).toHaveBeenCalled()
    notifier.start()
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})
