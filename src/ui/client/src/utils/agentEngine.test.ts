// agentEngine.ts 单测。
//
// 最要紧的一条同上：外部三家必须从 taskExecutor.ts 派生，不许在这里再抄一份 id/名字。
import { describe, it, expect, beforeEach } from 'vitest'
import {
  AGENT_ENGINE_OPTIONS,
  BUILTIN_ENGINE_ICON,
  BUILTIN_ENGINE_NAME,
  agentEngineName,
  getSelectedAgentEngine,
  isAgentEngineId,
  isExternalAgentEngine,
  setSelectedAgentEngine,
} from './agentEngine'
import { TASK_EXECUTOR_OPTIONS } from './taskExecutor'

describe('agentEngine 注册表', () => {
  it('g ai 排第一', () => {
    expect(AGENT_ENGINE_OPTIONS[0].id).toBe('gai')
    expect(AGENT_ENGINE_OPTIONS[0].name).toBe(BUILTIN_ENGINE_NAME)
  })

  it('外部三家从 TASK_EXECUTOR_OPTIONS 派生，不另写清单', () => {
    const externals = AGENT_ENGINE_OPTIONS.filter(o => o.id !== 'gai')
    expect(externals.map(o => o.id)).toEqual(TASK_EXECUTOR_OPTIONS.map(o => o.id))
    expect(externals.map(o => o.name)).toEqual(TASK_EXECUTOR_OPTIONS.map(o => o.name))
  })

  it('id 不重复', () => {
    const ids = AGENT_ENGINE_OPTIONS.map(o => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('内置引擎的图标是仓库既有的 g-ai（sprite 里那张，与顶栏同一个）', () => {
    // 曾经这里刻意留空（"不给 AI 功能贴装饰性图标"），用户看过下拉后指出
    // 三家有图标、只有 g ai 那行空一格，像"图标没加载出来" → 改为复用既有产品标识。
    // 名字写死成 'g-ai' 是有意的：它必须与 assets/icons/svg/g-ai.svg 的文件名一致，
    // 改名时这条会红 —— 否则表现是"图标静默变成空白"，没有任何报错。
    expect(BUILTIN_ENGINE_ICON).toBe('g-ai')
  })

  it('每个引擎都能定位到一张图标：内置查 sprite，外部三家在任务执行器清单里', () => {
    for (const opt of AGENT_ENGINE_OPTIONS) {
      if (isExternalAgentEngine(opt.id)) {
        expect(TASK_EXECUTOR_OPTIONS.some(o => o.id === opt.id)).toBe(true)
      } else {
        expect(opt.id).toBe('gai')
        expect(BUILTIN_ENGINE_ICON).toBeTruthy()
      }
    }
  })
})

describe('agentEngine 判定与兜底', () => {
  it('isAgentEngineId', () => {
    expect(isAgentEngineId('gai')).toBe(true)
    expect(isAgentEngineId('claude')).toBe(true)
    expect(isAgentEngineId('gemini')).toBe(false)
    expect(isAgentEngineId(undefined)).toBe(false)
  })

  it('gai 是内置的，不算外部引擎（两条链路的分派全靠这个判据）', () => {
    expect(isExternalAgentEngine('gai')).toBe(false)
    expect(isExternalAgentEngine('claude')).toBe(true)
    expect(isExternalAgentEngine('codex')).toBe(true)
    expect(isExternalAgentEngine('opencode')).toBe(true)
  })

  it('未知值回落 g ai，不显示 undefined', () => {
    expect(agentEngineName('nope')).toBe(BUILTIN_ENGINE_NAME)
    expect(agentEngineName(undefined)).toBe(BUILTIN_ENGINE_NAME)
    expect(agentEngineName('claude')).toBe('Claude Code')
  })
})

describe('agentEngine localStorage（只影响新建会话的默认值）', () => {
  beforeEach(() => localStorage.clear())

  it('没有记录时默认 g ai', () => {
    expect(getSelectedAgentEngine()).toBe('gai')
  })

  it('存了就能读回来', () => {
    setSelectedAgentEngine('codex')
    expect(getSelectedAgentEngine()).toBe('codex')
  })

  it('存了脏数据回落 g ai', () => {
    localStorage.setItem('zen-gitsync-agent-engine', 'gemini')
    expect(getSelectedAgentEngine()).toBe('gai')
  })
})
