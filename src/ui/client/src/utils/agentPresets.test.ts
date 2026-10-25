// 「预设提示词」共享定义的测试。
//
// 关键契约：
//   1. 内置默认是稳定的 5 条（id = p1..p5）—— 设置面板的「恢复默认」和欢迎页
//      的回落展示都指向它，id 变了会把两边对不上；
//   2. resolveAgentPresets 的回落规则：自定义非空 → 原样用；否则**当前板块**的预设；
//      板块也没有 → 内置。优先级顺序只有这一处实现，别在组件里再写一遍。
import { describe, it, expect } from 'vitest'
import { builtinAgentPresets, resolveAgentPresets, viewAgentPresets, newAgentPresetId } from './agentPresets'

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

  it('板块预设：每个板块都有内容，且与通用内置不是同一套', () => {
    const views = ['git', 'console', 'editor', 'source-map', 'mindmap', 'monitor', 'projects', 'workbench']
    const builtinIds = builtinAgentPresets().map(x => x.id)
    for (const view of views) {
      const list = viewAgentPresets(view)
      expect(list.length).toBeGreaterThan(0)
      for (const item of list) {
        expect(item.label.trim().length).toBeGreaterThan(0)
        expect(item.prompt.trim().length).toBeGreaterThan(0)
        expect(builtinIds).not.toContain(item.id)
      }
    }
  })

  it('板块预设：文案各不相同（复制粘贴漏改会立刻红）', () => {
    const all = ['git', 'console', 'editor', 'source-map', 'mindmap', 'monitor', 'projects', 'workbench']
      .flatMap(v => viewAgentPresets(v).map(x => x.prompt))
    expect(new Set(all).size).toBe(all.length)
  })

  it('resolveAgentPresets: 没有自定义时用板块预设，未知板块回落内置', () => {
    const monitor = resolveAgentPresets([], 'monitor')
    expect(monitor.length).toBe(4)
    expect(monitor.map(x => x.id)).toEqual(['monitor-1', 'monitor-2', 'monitor-3', 'monitor-4'])
    expect(resolveAgentPresets([], 'unknown-view').length).toBe(5)
    expect(resolveAgentPresets(undefined, '').length).toBe(5)
  })

  it('resolveAgentPresets: 自定义优先级高于板块预设', () => {
    const custom = [{ id: 'u1', label: '我的', prompt: '跑测试' }]
    expect(resolveAgentPresets(custom, 'monitor')).toBe(custom)
  })

  it('newAgentPresetId: 快速连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAgentPresetId()))
    expect(ids.size).toBe(200)
  })
})
