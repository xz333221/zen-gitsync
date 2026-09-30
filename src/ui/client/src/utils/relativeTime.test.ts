// clockFromIso 的单测：跨天时间线里"看着像今天"的坑。
//
// 全部用**本地时间构造** ISO（new Date(y, m-1, d, ...)），断言与运行机器时区无关 ——
// 直接写 '2026-09-17T06:43:23Z' 这种 UTC 字面量在 UTC+8 的开发机和 UTC 的 CI 上结果不同。

import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lang/static', async () => {
  // 直接用**真实的 zh 词表**，而不是"剥掉命名空间前缀当文案"那套近似：
  // 本仓的 key 并不总是等于 value（`@WORKBENCH:N 秒` 的 value 是 `{n} 秒`），
  // 近似 mock 会把插值整段丢掉，于是 formatDurationMs 全部渲染成 "N 秒"，
  // 断言再按正确文案写就变成 7 条全红（2026-09-30 实测）。
  const zh = (await import('@/lang/zh')).default as Record<string, string>
  return {
    $t: (key: string, params?: Record<string, string | number>) => {
      const text = zh[key] ?? key.replace(/^@[A-Z0-9]+:/, '')
      if (!params) return text
      return Object.entries(params).reduce(
        (s, [k, v]) => s.split(`{${k}}`).join(String(v)),
        text,
      )
    },
  }
})

import { clockFromIso, formatDurationMs, formatElapsed } from './relativeTime'

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

// 看板卡片上的「用时 3 分 20 秒」走的就是 formatDurationMs（2026-09-30 加的）。
// 断言按"键去掉命名空间前缀"的渲染结果写，与页面上的中文一致 ——
// 这是"用户看到的那个字符串"的形状，别改成拿毫秒数自己折算（那等于重写一遍实现）。

describe('formatDurationMs', () => {
  test('不足一分钟只报秒', () => {
    expect(formatDurationMs(0)).toBe('0 秒')
    expect(formatDurationMs(8_000)).toBe('8 秒')
    expect(formatDurationMs(59_999)).toBe('59 秒')
  })

  test('满一分钟起报分 + 秒', () => {
    expect(formatDurationMs(60_000)).toBe('1 分 0 秒')
    expect(formatDurationMs(200_000)).toBe('3 分 20 秒')
  })

  test('满一小时起报小时 + 分（秒那一档不再出现）', () => {
    expect(formatDurationMs(3_600_000)).toBe('1 小时 0 分')
    expect(formatDurationMs(20 * 60_000 + 30_000)).toBe('20 分 30 秒')
    expect(formatDurationMs(4_332_000)).toBe('1 小时 12 分')
  })

  test('非数 / 负数 / 空值给空串（调用方整段不渲染，不显示假的 0 秒）', () => {
    expect(formatDurationMs(undefined)).toBe('')
    expect(formatDurationMs(null)).toBe('')
    expect(formatDurationMs(Number.NaN)).toBe('')
    // 数字字符串（脏数据经 JSON 进来就是这个形状）：Number('200000') 会给出
    // 一个看着合法的时长，所以必须被拒。签名声明的是 number，故要显式捅一刀。
    expect(formatDurationMs('200000' as unknown as number)).toBe('')
    expect(formatDurationMs(-1)).toBe('')
  })
})

describe('formatElapsed', () => {
  test('有结束时刻时取两端之差', () => {
    expect(formatElapsed(localIso(2026, 9, 17, 14, 40, 0), localIso(2026, 9, 17, 14, 43, 20), NOW))
      .toBe('3 分 20 秒')
  })

  test('没有结束时刻（还在跑）以 now 为结束 —— 那个数字是会长的', () => {
    expect(formatElapsed(localIso(2026, 9, 17, 14, 55, 0), null, NOW)).toBe('13 分 37 秒')
  })

  test('结束早于开始（时钟漂移）给出 0 而不是负数', () => {
    expect(formatElapsed(localIso(2026, 9, 17, 14, 43, 20), localIso(2026, 9, 17, 14, 40, 0), NOW))
      .toBe('0 秒')
  })

  test('缺起点 / 非法时刻给空串', () => {
    expect(formatElapsed('', null, NOW)).toBe('')
    expect(formatElapsed('not-a-date', null, NOW)).toBe('')
    expect(formatElapsed(localIso(2026, 9, 17, 14, 0, 0), 'not-a-date', NOW)).toBe('')
  })
})
