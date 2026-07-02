// 全局 setup:polyfill + element-plus 部分 mock。
// Polyfill 必须在 import element-plus 之前执行,否则 ElTable/ElScrollbar 实例化 ResizeObserver 时崩溃。
import { vi } from 'vitest'

// vi.mock 必须出现在所有其他代码之前(hoist)
vi.mock('@vueuse/core', async () => {
  const actual = await vi.importActual<any>('@vueuse/core')
  return {
    ...actual,
    useMediaQuery: () => ({ value: false }),
    useDark: () => ({ value: false }),
    useStorage: (_key: string, val: any) => ({ value: val }),
    useElementVisibility: () => ({ value: false }),
    useIntersectionObserver: () => ({ stop: vi.fn() }),
    useResizeObserver: () => ({ stop: vi.fn() }),
    useEventListener: vi.fn(),
    useScroll: () => ({ x: { value: 0 }, y: { value: 0 }, isScrolling: { value: false }, arrivedState: { value: { left: false, right: false } } }),
    useDraggable: () => ({ x: { value: 0 }, y: { value: 0 }, style: { value: '' } }),
  }
})

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as any

// 用 stubGlobal + vi.fn 持久 mock,避免 Object.defineProperty + vi.restoreAllMocks 互相干扰
const mockMediaQuery = (q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})
vi.stubGlobal('matchMedia', (q: string) => mockMediaQuery(q))

if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
}

// 部分 mock element-plus:ElMessage/ElMessageBox/ElNotification 在真实环境会创建 DOM + 等待 Promise,
// 测试环境会卡住。保留其他 API 透传,允许组件继续 import 其他 element-plus 模块。
vi.mock('element-plus', async () => {
  const actual = await vi.importActual<typeof import('element-plus')>('element-plus')
  // GitStatus.vue:220 等多处用 ElMessage({ type, message }) 直接调用,
  // 不只是 .success()/.error() —— mock 必须是可调用函数,同时挂常用方法。
  const msg: any = vi.fn()
  msg.success = vi.fn()
  msg.error = vi.fn()
  msg.warning = vi.fn()
  msg.info = vi.fn()
  return {
    ...actual,
    ElMessage: msg,
    ElMessageBox: {
      confirm: vi.fn().mockResolvedValue('confirm'),
      alert: vi.fn().mockResolvedValue('alert'),
      prompt: vi.fn(),
    },
    ElNotification: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  }
})
