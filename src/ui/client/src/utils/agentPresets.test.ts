// 「预设提示词」共享定义的测试。
//
// 关键契约：
//   1. 内置默认是稳定的 5 条（id = p1..p5）—— 设置面板的「恢复默认」和欢迎页
//      的回落展示都指向它，id 变了会把两边对不上；
//   2. resolveAgentPresets 的回落规则：本板块自定义 → 通用自定义 → **当前板块**的内置预设
//      → 内置 5 条。优先级顺序只有这一处实现，别在组件里再写一遍。
import { describe, it, expect } from 'vitest'
import {
  AGENT_PRESET_SCOPES,
  AGENT_PRESET_VIEW_IDS,
  builtinAgentPresets,
  builtinPresetsForScope,
  resolveAgentPresets,
  viewAgentPresets,
  newAgentPresetId,
} from './agentPresets'

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

  // ── 按板块的自定义（2026-10-25）──────────────────────────────
  it('resolveAgentPresets: 板块自定义 > 通用自定义 > 板块内置 > 通用内置', () => {
    const common = [{ id: 'c1', label: '通用', prompt: '通用那套' }]
    const monitorOnly = [{ id: 'm1', label: '监控专用', prompt: '看内存' }]
    const byView = { monitor: monitorOnly }
    // 板块配过 → 用板块的，通用不覆盖它
    expect(resolveAgentPresets(common, 'monitor', byView)).toBe(monitorOnly)
    // 别的板块没配 → 用通用的
    expect(resolveAgentPresets(common, 'git', byView)).toBe(common)
    // 板块和通用都没配 → 板块内置
    expect(resolveAgentPresets([], 'monitor', {})[0].id).toBe('monitor-1')
    // 未知板块且没自定义 → 通用内置 5 条
    expect(resolveAgentPresets([], 'unknown', {}).length).toBe(5)
  })

  it('resolveAgentPresets: byView 里的空数组不算自定义（回落通用那套）', () => {
    const common = [{ id: 'c1', label: '通用', prompt: '通用那套' }]
    expect(resolveAgentPresets(common, 'monitor', { monitor: [] })).toBe(common)
  })

  it('设置面板的作用域 = 通用 + 每个有内置预设的板块', () => {
    expect(AGENT_PRESET_SCOPES[0].id).toBe('')
    expect(AGENT_PRESET_SCOPES.slice(1).map(s => s.id)).toEqual([...AGENT_PRESET_VIEW_IDS])
    for (const scope of AGENT_PRESET_SCOPES) {
      expect(builtinPresetsForScope(scope.id).length).toBeGreaterThan(0)
    }
  })

  it('newAgentPresetId: 快速连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAgentPresetId()))
    expect(ids.size).toBe(200)
  })
})
