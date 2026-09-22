// utils/taskNotify 的回归测试。
//
// 这层薄封装的唯一职责是"绝不抛、只返回布尔/枚举"，而浏览器通知的坑恰好全在
// 异常路径上（unsupported / permission-denied / 构造抛错）。所以用例重心不在
// 快乐路径，而在这些分支上必须**安静地降级**而不是把异常冒泡到 SSE 回调里。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  notificationPermission,
  requestNotificationPermission,
  shouldUseSystemNotification,
  notifySystem,
} from './taskNotify'

type AnyNotification = typeof Notification

let originalNotification: AnyNotification | undefined

/** 装一个假的 Notification 构造器；返回它本身与最近一次创建出来的实例 */
function installNotification(
  permission: string,
  opts: { requestResult?: string; throwOnConstruct?: boolean } = {},
) {
  const created: any[] = []
  class FakeNotification {
    static permission = permission
    static requestPermission = vi.fn(async () => opts.requestResult ?? permission)
    onclick: (() => void) | null = null
    close = vi.fn()
    title: string
    init: any
    constructor(title: string, init?: any) {
      if (opts.throwOnConstruct) throw new TypeError('Illegal constructor')
      this.title = title
      this.init = init
      created.push(this)
    }
  }
  ;(window as any).Notification = FakeNotification
  return { Fake: FakeNotification as unknown as any, created }
}

beforeEach(() => {
  originalNotification = (window as any).Notification
})

afterEach(() => {
  if (originalNotification === undefined) delete (window as any).Notification
  else (window as any).Notification = originalNotification
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('notificationPermission', () => {
  it('环境没有 Notification 时返回 unsupported，而不是抛错', () => {
    delete (window as any).Notification
    expect(notificationPermission()).toBe('unsupported')
  })

  it('如实透传三种已定义权限', () => {
    for (const p of ['granted', 'denied', 'default']) {
      installNotification(p)
      expect(notificationPermission()).toBe(p)
    }
  })

  it('权限值是陌生字符串时收敛成 default', () => {
    installNotification('whatever')
    expect(notificationPermission()).toBe('default')
  })
})

describe('requestNotificationPermission', () => {
  it('已授予 / 已拒绝 / 不支持时直接返回现状，不问浏览器', async () => {
    const a = installNotification('granted')
    expect(await requestNotificationPermission()).toBe('granted')
    expect(a.Fake.requestPermission).not.toHaveBeenCalled()

    const b = installNotification('denied')
    expect(await requestNotificationPermission()).toBe('denied')
    expect(b.Fake.requestPermission).not.toHaveBeenCalled()

    delete (window as any).Notification
    expect(await requestNotificationPermission()).toBe('unsupported')
  })

  it('default 时才真的去问，并接受提问结果', async () => {
    const a = installNotification('default', { requestResult: 'granted' })
    expect(await requestNotificationPermission()).toBe('granted')
    expect(a.Fake.requestPermission).toHaveBeenCalledTimes(1)
  })

  it('浏览器返回陌生值时收敛成 default（而不是当成已授权）', async () => {
    installNotification('default', { requestResult: 'weird' })
    expect(await requestNotificationPermission()).toBe('default')
  })

  it('requestPermission 抛错时返回 default，不冒泡异常', async () => {
    const a = installNotification('default')
    a.Fake.requestPermission = vi.fn(async () => { throw new Error('boom') })
    await expect(requestNotificationPermission()).resolves.toBe('default')
  })
})

describe('shouldUseSystemNotification', () => {
  it('页面被切走（visibilityState !== visible）时必须走系统通知', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    expect(shouldUseSystemNotification()).toBe(true)
  })

  it('页面可见且持有焦点时不需要系统通知', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    expect(shouldUseSystemNotification()).toBe(false)
  })

  it('页面可见但被别的窗口盖住（hasFocus 为 false）时仍要走系统通知', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    expect(shouldUseSystemNotification()).toBe(true)
  })
})

describe('notifySystem', () => {
  it('权限不是 granted 时返回 false，且不构造任何实例（调用方据此退回应用内提示）', () => {
    const a = installNotification('default')
    expect(notifySystem({ title: 't' })).toBe(false)
    expect(a.created).toHaveLength(0)
  })

  it('没有 Notification 时返回 false', () => {
    delete (window as any).Notification
    expect(notifySystem({ title: 't' })).toBe(false)
  })

  it('授权后按传入内容构造通知，并带上 tag 压重复', () => {
    const a = installNotification('granted')
    expect(notifySystem({ title: '任务执行完成', body: '写代码\n已完成', tag: 'zen-gitsync-job-j1' })).toBe(true)
    expect(a.created).toHaveLength(1)
    expect(a.created[0].title).toBe('任务执行完成')
    expect(a.created[0].init).toMatchObject({
      body: '写代码\n已完成',
      tag: 'zen-gitsync-job-j1',
      requireInteraction: false,
    })
  })

  it('不传 body / tag 时补成空串与 undefined（requireInteraction 恒为 false，任务提示不该赖在屏幕上）', () => {
    const a = installNotification('granted')
    expect(notifySystem({ title: 't' })).toBe(true)
    expect(a.created[0].init.body).toBe('')
    expect(a.created[0].init.tag).toBeUndefined()
    expect(a.created[0].init.requireInteraction).toBe(false)
  })

  it('构造抛错时返回 false（权限状态与真实能力不一致的浏览器）', () => {
    installNotification('granted', { throwOnConstruct: true })
    expect(notifySystem({ title: 't' })).toBe(false)
  })

  it('点击通知时聚焦窗口并关闭它', () => {
    const a = installNotification('granted')
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {})
    notifySystem({ title: 't' })
    const n = a.created[0]
    expect(n.onclick).toBeTypeOf('function')
    n.onclick()
    expect(focusSpy).toHaveBeenCalled()
    expect(n.close).toHaveBeenCalled()
  })

  it('window.focus 抛错（部分浏览器禁用）时点击回调仍不冒泡异常', () => {
    const a = installNotification('granted')
    vi.spyOn(window, 'focus').mockImplementation(() => { throw new Error('not allowed') })
    notifySystem({ title: 't' })
    expect(() => a.created[0].onclick()).not.toThrow()
    expect(a.created[0].close).toHaveBeenCalled()
  })
})
