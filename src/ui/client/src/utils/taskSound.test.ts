// utils/taskSound 的回归测试。
//
// 这层的职责同样是"绝不抛、只返回布尔"，而它的坑几乎全在**环境异常路径**上：
// 浏览器没有 Audio 构造器、自动播放策略把 play() 拦下（Promise reject）、
// 元数据没就绪时设 currentTime 抛错。这些分支都必须安静降级 —— 调用点在 SSE
// 回调里，一个冒泡出去的异常就会打断后续帧的处理。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { playFinishSound, soundUrlFor, __resetSoundPool } from './taskSound'

type AnyAudio = typeof Audio

let originalAudio: AnyAudio | undefined

/**
 * 装一个假的 Audio 构造器。
 * 返回它本身、创建过的实例数组，以及两个可选故障开关：
 *   throwOnConstruct      构造函数直接抛（模拟老环境/被策略禁用）
 *   throwOnSetCurrentTime currentTime 是只读的（模拟元数据未就绪）
 *   rejectPlay            play() 返回 rejected Promise（模拟自动播放被拦）
 */
function installAudio(opts: { throwOnConstruct?: boolean; throwOnSetCurrentTime?: boolean; rejectPlay?: boolean } = {}) {
  const created: any[] = []
  class FakeAudio {
    src: string
    preload = ''
    currentTime = 0
    play = vi.fn(() => (opts.rejectPlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()))
    constructor(src: string) {
      if (opts.throwOnConstruct) throw new TypeError('Illegal constructor')
      this.src = src
      if (opts.throwOnSetCurrentTime) {
        Object.defineProperty(this, 'currentTime', {
          get: () => 0,
          set: () => { throw new TypeError('currentTime is read-only') },
          configurable: true,
        })
      }
      created.push(this)
    }
  }
  ;(window as any).Audio = FakeAudio
  ;(globalThis as any).Audio = FakeAudio
  return { created }
}

beforeEach(() => {
  originalAudio = (globalThis as any).Audio
  __resetSoundPool()
})

afterEach(() => {
  if (originalAudio === undefined) delete (globalThis as any).Audio
  else (globalThis as any).Audio = originalAudio
  __resetSoundPool()
})

describe('soundUrlFor：终态 → 音源', () => {
  it('正常跑完 / 出错各有自己的音源', () => {
    expect(soundUrlFor('done')).toBe('/sounds/task-done.wav')
    expect(soundUrlFor('error')).toBe('/sounds/task-error.wav')
  })

  it('用户自己按的停止不响 —— 人就在页面上，再响一声是打扰', () => {
    expect(soundUrlFor('cancelled')).toBe('')
  })
})

describe('playFinishSound：正常路径', () => {
  it('按音源创建 Audio、设 preload=auto 并播放', () => {
    const { created } = installAudio()
    expect(playFinishSound('done')).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0].src).toBe('/sounds/task-done.wav')
    expect(created[0].preload).toBe('auto')
    expect(created[0].play).toHaveBeenCalledTimes(1)
  })

  it('每次都把 currentTime 归零 —— 连响时打断上一声，而不是叠成噪音', () => {
    const { created } = installAudio()
    playFinishSound('done')
    created[0].currentTime = 0.25
    playFinishSound('done')
    expect(created[0].currentTime).toBe(0)
    expect(created[0].play).toHaveBeenCalledTimes(2)
  })

  it('同一个音源复用实例（命中缓存，不在任务刚跑完时重走 fetch + decode）', () => {
    const { created } = installAudio()
    playFinishSound('done')
    playFinishSound('done')
    expect(created).toHaveLength(1)
  })

  it('不同音源各建各的实例', () => {
    const { created } = installAudio()
    playFinishSound('done')
    playFinishSound('error')
    expect(created.map(c => c.src)).toEqual(['/sounds/task-done.wav', '/sounds/task-error.wav'])
  })

  it('cancelled 不创建任何 Audio、也不播放', () => {
    const { created } = installAudio()
    expect(playFinishSound('cancelled')).toBe(false)
    expect(created).toHaveLength(0)
  })
})

describe('playFinishSound：异常路径必须安静降级', () => {
  it('环境没有 Audio 构造器 → false，不抛', () => {
    delete (globalThis as any).Audio
    expect(() => playFinishSound('done')).not.toThrow()
    expect(playFinishSound('done')).toBe(false)
  })

  it('new Audio() 抛错 → false，不抛', () => {
    installAudio({ throwOnConstruct: true })
    expect(playFinishSound('done')).toBe(false)
  })

  it('play() 被自动播放策略拦下（Promise reject）→ 不再冒泡成 unhandled rejection', async () => {
    installAudio({ rejectPlay: true })
    expect(playFinishSound('done')).toBe(true)
    // 等一轮微任务：如果 catch 没挂上，这里会炸成 unhandled rejection
    await Promise.resolve()
  })

  it('currentTime 只读（元数据未就绪）→ 跳过归零，照样播', () => {
    const { created } = installAudio({ throwOnSetCurrentTime: true })
    expect(playFinishSound('done')).toBe(true)
    expect(created[0].play).toHaveBeenCalledTimes(1)
  })
})
