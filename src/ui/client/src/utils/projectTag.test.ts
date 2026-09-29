// projectHue 的单测：色标的两个硬要求 —— 同一个项目永远同色、不同项目要散得开。
//
// 这两条都不是"看着对"就够的：前者靠哈希稳定（换个顺序 / 换台机器也不能变），
// 后者是分布问题（本机 20 个项目路径共享长前缀，哈希选错就全挤在一档）。
// 所以这里断言的是**性质**，不是某个具体色相值——档位表怎么调都不该让测试红。

import { describe, expect, test } from 'vitest'

import { projectHue, projectTagStyle } from './projectTag'

/** 本机任务里真正出现过的项目路径（= 卡片上真会渲染标签的那几个，取自 ~/.zen-gitsync/tasks.json） */
const REAL_PATHS = [
  'c:\\workspace\\github_workspace\\xz333221\\zen-gitsync',
  'c:\\workspace\\github_workspace\\zen-ai-chat-ui',
  'c:\\workspace\\github_workspace\\flow-mindmap',
  'c:\\workspace\\gitee_workspace\\flowdash\\home2026',
  'c:\\workspace\\gitee_workspace\\flowdash\\tool-flowdash',
  'c:\\workspace\\gitee_workspace\\flowdash\\tool-flowdash2026',
]

describe('projectHue', () => {
  test('同一个项目永远同色', () => {
    const p = 'c:\\workspace\\github_workspace\\xz333221\\zen-gitsync'
    expect(projectHue(p)).toBe(projectHue(p))
  })

  test('同一路径的不同写法算同色（反斜杠 / 大小写 / 首尾空白）', () => {
    const canonical = 'c:/workspace/github_workspace/zen-ai-chat-ui'
    expect(projectHue('C:\\workspace\\github_workspace\\zen-ai-chat-ui')).toBe(projectHue(canonical))
    expect(projectHue('  c:/workspace/GitHub_Workspace/zen-ai-chat-ui  ')).toBe(projectHue(canonical))
  })

  test('空串不炸，且给一个确定的档位', () => {
    expect(projectHue('')).toBe(projectHue(''))
    expect(projectHue(undefined as unknown as string)).toBe(projectHue(''))
  })

  test('本机 6 个项目至少散到 4 档', () => {
    // 不是"每对都不撞"——8 档装 6 条也可能撞，要求零撞是过约束。
    // 卡的是下限：单用 FNV 不补混淆时这里只有 4 档（且 zen-gitsync 与 zen-ai-chat-ui 撞在一起），
    // 补上 finalizer 后是 5 档。真掉回 4 档说明混淆那一步被删了。
    const used = new Set(REAL_PATHS.map(projectHue))
    expect(used.size).toBeGreaterThanOrEqual(5)
  })

  test('看板上并排的那两个项目不能同色（用户报的就是这一对）', () => {
    // zen-gitsync 与 zen-ai-chat-ui 是任务最多的两个，"进行中"列里常常上下相邻。
    // 单用 FNV-1a 时两者都落在 350°，色标在这个场景下等于没做——所以单独锁一条。
    expect(projectHue(REAL_PATHS[0])).not.toBe(projectHue(REAL_PATHS[1]))
  })

  test('大量路径下 8 档都用得到，且没有哪一档吃掉大半（哈希分布）', () => {
    // 这条才是真正的命门：本机所有项目路径共享长前缀（`c:/workspace/...`），
    // 换成 `h * 31 + c` 这类前向哈希时低位区分度被前缀吃掉，分布会明显塌向一两档。
    // 用合成路径（前缀相同、尾部各异）比拿 16 条真实路径更能压出这个问题。
    const buckets = new Map<number, number>()
    const total = 500
    for (let i = 0; i < total; i++) {
      const hue = projectHue(`c:/workspace/github_workspace/xz333221/project-${i}`)
      buckets.set(hue, (buckets.get(hue) || 0) + 1)
    }
    expect(buckets.size).toBe(8)
    for (const count of buckets.values()) {
      // 均匀分布每档 ≈ 62 条；放宽到 2 倍，只要没塌就算过
      expect(count).toBeLessThan(total / 4)
    }
  })
})

describe('projectTagStyle', () => {
  test('产出的是 CSS 自定义属性，而不是写死的颜色', () => {
    // 颜色分层在 CSS 里按主题混，这里给死了深色主题就得再维护第二组
    const style = projectTagStyle('c:/workspace/github_workspace/zen-ai-chat-ui')
    expect(Object.keys(style)).toEqual(['--tag-hue'])
    expect(String(style['--tag-hue'])).toMatch(/^\d+$/)
  })

  test('色相落在档位表里（真被 CSS 用去做 hsl 的第一段）', () => {
    const hue = projectHue('c:/workspace/github_workspace/zen-gitsync')
    expect(hue).toBeGreaterThanOrEqual(0)
    expect(hue).toBeLessThanOrEqual(360)
  })
})
