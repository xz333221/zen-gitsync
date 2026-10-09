// 「预设提示词」共享定义的测试。
//
// 关键契约只有两条：
//   1. 内置默认是稳定的 5 条（id = p1..p5）—— 设置面板的「恢复默认」和欢迎页
//      的回落展示都指向它，id 变了会把两边对不上；
//   2. resolveAgentPresets 的回落规则：空数组/未定义 → 内置，非空 → 原样用自定义。
//      （"哪些算自定义"的判定只有一处，就是这里。）
import { describe, it, expect } from 'vitest'
import { builtinAgentPresets, resolveAgentPresets, newAgentPresetId } from './agentPresets'

describe('agentPresets', () => {
  it('内置默认 5 条，id 稳定为 p1-p5，每条都有非空 label/prompt', () => {
    const list = builtinAgentPresets()
    expect(list.length).toBe(5)
    expect(list.map(x => x.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    for (const item of list) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.prompt.length).toBeGreaterThan(0)
    }
  })

  it('resolveAgentPresets: 有自定义时原样用自定义（含引用透传）', () => {
    const custom = [{ id: 'u1', label: '我的', prompt: '跑测试' }]
    expect(resolveAgentPresets(custom)).toBe(custom)
  })

  it('resolveAgentPresets: 空数组 / undefined / null 都回落内置默认', () => {
    expect(resolveAgentPresets([]).length).toBe(5)
    expect(resolveAgentPresets(undefined).length).toBe(5)
    expect(resolveAgentPresets(null).length).toBe(5)
  })

  it('newAgentPresetId: 快速连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAgentPresetId()))
    expect(ids.size).toBe(200)
  })
})
