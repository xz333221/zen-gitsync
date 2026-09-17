// clockFromIso 的单测：跨天时间线里"看着像今天"的坑。
//
// 全部用**本地时间构造** ISO（new Date(y, m-1, d, ...)），断言与运行机器时区无关 ——
// 直接写 '2026-09-17T06:43:23Z' 这种 UTC 字面量在 UTC+8 的开发机和 UTC 的 CI 上结果不同。

import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lang/static', () => ({
  // 最简 i18n：剥掉命名空间前缀 + 具名插值。
  // zh 表里绝大多数 key 的值就是"去掉前缀的 key 本身"，所以这样足够真实，
  // 断言里能直接读到渲染后的句子（而不是 `@WORKBENCH:昨天 {time}`）。
  $t: (key: string, params?: Record<string, string | number>) => {
    const text = key.replace(/^@[A-Z0-9]+:/, '')
    return params
      ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text)
      : text
  },
}))

import { clockFromIso } from './relativeTime'

/** 以本地时区构造某个时刻的 ISO 串 */
const localIso = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) =>
  new Date(y, mo - 1, d, h, mi, s).toISOString()

/** 参照时刻：2026-09-17 15:08:37（本地） */
const NOW = new Date(2026, 8, 17, 15, 8, 37).getTime()

describe('clockFromIso', () => {
  test('当天只给时刻', () => {
    expect(clockFromIso(localIso(2026, 9, 17, 14, 43, 23), NOW)).toBe('14:43:23')
  })

  test('当天的两个端点仍算当天（00:00:00 不显示日期）', () => {
    expect(clockFromIso(localIso(2026, 9, 17, 0, 0, 0), NOW)).toBe('00:00:00')
    expect(clockFromIso(localIso(2026, 9, 17, 23, 59, 59), NOW)).toBe('23:59:59')
  })

  test('昨天给「昨天 + 时刻」', () => {
    expect(clockFromIso(localIso(2026, 9, 16, 14, 43, 23), NOW)).toBe('昨天 14:43:23')
  })

  test('昨天的端点：昨天 23:59:59 不能算今天', () => {
    expect(clockFromIso(localIso(2026, 9, 16, 23, 59, 59), NOW)).toBe('昨天 23:59:59')
  })

  test('跨月的昨天（9/1 的前一天是 8/31）', () => {
    const now = new Date(2026, 8, 1, 10, 0, 0).getTime()
    expect(clockFromIso(localIso(2026, 8, 31, 22, 0, 0), now)).toBe('昨天 22:00:00')
  })

  test('跨年的昨天（1/1 的前一天是 12/31）—— 仍说「昨天」，不必报年份', () => {
    const now = new Date(2026, 0, 1, 0, 30, 0).getTime()
    expect(clockFromIso(localIso(2025, 12, 31, 23, 59, 0), now)).toBe('昨天 23:59:00')
  })

  test('同年更早的日期给「月/日 时刻」', () => {
    expect(clockFromIso(localIso(2026, 6, 29, 15, 54, 10), NOW)).toBe('6/29 15:54:10')
  })

  test('跨年给「年/月/日 时刻」', () => {
    expect(clockFromIso(localIso(2025, 12, 31, 23, 59, 59), NOW)).toBe('2025/12/31 23:59:59')
  })

  test('空值与非法时间给空串（调用方自行回退），不抛异常', () => {
    expect(clockFromIso('', NOW)).toBe('')
    expect(clockFromIso(null, NOW)).toBe('')
    expect(clockFromIso(undefined, NOW)).toBe('')
    expect(clockFromIso('not-a-date', NOW)).toBe('')
  })
})
