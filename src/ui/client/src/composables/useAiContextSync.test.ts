// useAiContextSync 的回归测试。
//
// 这块逻辑的全部价值在两张映射表上，而表里最容易写错的三件事：
//   · **不该刷的面板要真的不刷**（console / editor / source-map 与快照无关）——
//     给它们"为了整齐"硬塞一个板块，切一次面板就白跑一次取数。
//   · **Git 视图必须按子 Tab 分**（当前项目 / GitHub / Gitee 对应三个完全不同的板块），
//     这是整件事里唯一"同一个 view 对应多个板块"的地方。
//   · **切到智能体页 = 全刷**（空数组语义），用户在那儿可能问任何一块。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ALL_AI_CONTEXT_SECTIONS,
  AI_CONTEXT_SECTIONS_BY_GIT_TAB,
  AI_CONTEXT_SECTIONS_BY_VIEW,
  refreshAiContext,
  refreshAiContextForView,
} from './useAiContextSync'

let calls: Array<{ url: string; body: unknown }>

function stubFetch(ok = true) {
  calls = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    return ok ? Promise.resolve({ ok: true }) : Promise.reject(new Error('offline'))
  })
}

beforeEach(() => { stubFetch() })
afterEach(() => { vi.unstubAllGlobals() })

describe('refreshAiContextForView', () => {
  it('Git 视图按子 Tab 分板块，三块互不串台', () => {
    refreshAiContextForView('git', 'current')
    expect(calls[0].body).toEqual({ sections: ['git'], force: true })

    refreshAiContextForView('git', 'github')
    expect(calls[1].body).toEqual({ sections: ['github'], force: true })

    refreshAiContextForView('git', 'gitee')
    expect(calls[2].body).toEqual({ sections: ['gitee'], force: true })
  })

  it('工作台 / 监控 / 思维导图各刷自己那一块', () => {
    refreshAiContextForView('workbench', 'current')
    expect(calls[0].body).toEqual({ sections: ['tasks'], force: true })

    refreshAiContextForView('monitor', 'current')
    expect(calls[1].body).toEqual({ sections: ['system'], force: true })

    refreshAiContextForView('mindmap', 'current')
    expect(calls[2].body).toEqual({ sections: ['mindmap'], force: true })
  })

  it('切到智能体页 = 全刷（空数组语义），因为用户在那儿可能问任何一块', () => {
    refreshAiContextForView('agent', 'current')
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ sections: ALL_AI_CONTEXT_SECTIONS, force: true })
    expect(ALL_AI_CONTEXT_SECTIONS).toEqual([])
  })

  it('与快照无关的面板一个请求都不发', () => {
    for (const view of ['console', 'editor', 'source-map']) {
      refreshAiContextForView(view, 'current')
    }
    expect(calls).toHaveLength(0)
  })

  it('view 不是 git 时，gitTab 的残留值不参与决策', () => {
    refreshAiContextForView('monitor', 'github')
    expect(calls[0].body).toEqual({ sections: ['system'], force: true })
  })

  it('未知 view / 未知 gitTab 不发请求，也不抛', () => {
    expect(() => refreshAiContextForView('nope', 'nope')).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('一律带 force（频率控制交给服务端各板块的 forceTtlMs 地板）', () => {
    refreshAiContextForView('monitor', 'current')
    expect((calls[0].body as { force: boolean }).force).toBe(true)
  })

  it('打的是 /api/ai-context/refresh', () => {
    refreshAiContextForView('monitor', 'current')
    expect(calls[0].url).toBe('/api/ai-context/refresh')
  })
})

describe('refreshAiContext 自身', () => {
  it('null 表示这次不刷，一个请求都不发', () => {
    refreshAiContext(null)
    expect(calls).toHaveLength(0)
  })

  it('请求失败静默：不抛、也不返回可 await 的东西', () => {
    stubFetch(false)
    expect(() => refreshAiContext(['git'])).not.toThrow()
    expect(refreshAiContext(['git'])).toBeUndefined()
  })
})

describe('两张映射表的完整性', () => {
  it('每个已知视图都有条目（null 也算条目，"明确不刷"不能靠漏写来表达）', () => {
    for (const view of ['git', 'console', 'editor', 'source-map', 'workbench', 'monitor', 'mindmap', 'agent']) {
      expect(Object.keys(AI_CONTEXT_SECTIONS_BY_VIEW)).toContain(view)
    }
  })

  it('Git 三个子 Tab 全覆盖', () => {
    for (const tab of ['current', 'github', 'gitee']) {
      expect(Object.keys(AI_CONTEXT_SECTIONS_BY_GIT_TAB)).toContain(tab)
    }
  })

  it('映射里的板块 id 都是真板块名', () => {
    const known = new Set(['git', 'github', 'gitee', 'commands', 'tasks', 'system', 'mindmap'])
    const mapped = [
      ...Object.values(AI_CONTEXT_SECTIONS_BY_VIEW).flatMap(v => v ?? []),
      ...Object.values(AI_CONTEXT_SECTIONS_BY_GIT_TAB).flatMap(v => v ?? []),
    ]
    for (const id of mapped) expect(known.has(id), `未知板块 id: ${id}`).toBe(true)
  })
})
