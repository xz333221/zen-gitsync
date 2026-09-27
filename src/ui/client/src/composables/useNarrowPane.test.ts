// useNarrowPane 的回归测试。
//
// 业务规则只有一条（容器够窄就折成两页），但有两个特别容易写反的边界：
//   · **量不到宽度时必须按宽屏兜底**。jsdom 里 ResizeObserver 是空实现、clientWidth 恒为 0，
//     若把 0 当窄屏，全部单测看到的默认布局都会和现实相反（宽屏代码路径反而没人跑）。
//   · 判据必须是**容器**宽度，不是视口宽度。用例把组件挂在 300px 的盒子里、同时把
//     window.innerWidth 设成 1600 —— 用视口实现的话这条会红。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mountWithSetup } from '@/test-utils/mount'
import { useNarrowPane, PANE_SPLIT_MIN_WIDTH } from './useNarrowPane'

/** 可控的 ResizeObserver：留出 push()，让用例自己决定"浏览器量到了多少" */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  cb: ResizeObserverCallback
  observed: Element[] = []
  disconnected = false
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
  /** 手动推一次宽度，等价于浏览器的一次回调 */
  push(width: number) {
    this.cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

/** 把宽度和判定结果渲染成文本，省得每个用例都去戳组件内部状态 */
const Harness = defineComponent({
  props: { breakpoint: { type: Number, default: undefined } },
  setup(props) {
    const el = ref<HTMLElement | null>(null)
    const { width, narrow } = useNarrowPane(el, props.breakpoint)
    return () => h('div', { ref: el }, `${width.value}|${narrow.value}`)
  },
})

function readResult(w: { text: () => string }) {
  const [width, narrow] = w.text().split('|')
  return { width: Number(width), narrow: narrow === 'true' }
}

const originalRO = (globalThis as any).ResizeObserver
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

/** 临时把元素的 clientWidth 定成某个值，返回还原函数 */
function stubClientWidth(value: number) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => value,
  })
  return () => {
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    else delete (HTMLElement.prototype as any).clientWidth
  }
}

let restoreCW: (() => void) | null = null

beforeEach(() => {
  FakeResizeObserver.instances = []
  ;(globalThis as any).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  ;(globalThis as any).ResizeObserver = originalRO
  restoreCW?.()
  restoreCW = null
})

describe('useNarrowPane', () => {
  // 注意：mount 之后必须 await 一次 $nextTick —— onMounted 里的赋值会把这次渲染
  // 排进微任务队列，同步读 w.text() 拿到的还是首帧的 "0|false"。
  it('挂载时同步量一次容器宽度，够窄就折行', async () => {
    restoreCW = stubClientWidth(400)
    const w = mountWithSetup(Harness)
    await w.vm.$nextTick()
    const r = readResult(w)
    expect(r.width).toBe(400)
    expect(r.narrow).toBe(true)
  })

  it('量不到宽度（clientWidth = 0）时按宽屏兜底', async () => {
    // jsdom 的默认行为就是这一条：没有布局，clientWidth 恒为 0。
    // 这里绝不能判成窄屏，否则单测跑的是和生产相反的分支。
    const w = mountWithSetup(Harness)
    await w.vm.$nextTick()
    const r = readResult(w)
    expect(r.width).toBe(0)
    expect(r.narrow).toBe(false)
  })

  it('ResizeObserver 推来的宽度跨过断点，narrow 跟着来回翻转', async () => {
    restoreCW = stubClientWidth(0)
    const w = mountWithSetup(Harness)
    const ro = FakeResizeObserver.instances[0]
    expect(ro).toBeTruthy()

    ro.push(PANE_SPLIT_MIN_WIDTH - 1)
    await w.vm.$nextTick()
    expect(readResult(w).narrow).toBe(true)

    // 边界：恰好等于断点时**不算**窄（并排刚好还站得住）
    ro.push(PANE_SPLIT_MIN_WIDTH)
    await w.vm.$nextTick()
    expect(readResult(w).narrow).toBe(false)

    ro.push(PANE_SPLIT_MIN_WIDTH + 1)
    await w.vm.$nextTick()
    expect(readResult(w).narrow).toBe(false)
  })

  it('断点可覆盖', async () => {
    restoreCW = stubClientWidth(700)
    const w = mountWithSetup(Harness, { props: { breakpoint: 800 } })
    await w.vm.$nextTick()
    expect(readResult(w).narrow).toBe(true)
  })

  it('只看容器宽度，不看视口宽度', async () => {
    // 窗口很窄但面板自己很宽 —— 应该保持并排（文件空间里的面板就是这样：
    // 1440px 的窗口里它只有四百多像素，而反过来的情况同样成立）
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 })
    restoreCW = stubClientWidth(900)
    try {
      const w = mountWithSetup(Harness)
      await w.vm.$nextTick()
      expect(readResult(w).narrow).toBe(false)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })

  it('卸载时断开 ResizeObserver', () => {
    restoreCW = stubClientWidth(600)
    const w = mountWithSetup(Harness)
    const ro = FakeResizeObserver.instances[0]
    w.unmount()
    expect(ro.disconnected).toBe(true)
  })

  it('环境没有 ResizeObserver 时仍然能用（只用挂载时量到的那一次）', async () => {
    restoreCW = stubClientWidth(300)
    delete (globalThis as any).ResizeObserver
    const w = mountWithSetup(Harness)
    await w.vm.$nextTick()
    const r = readResult(w)
    expect(r.width).toBe(300)
    expect(r.narrow).toBe(true)
  })
})
