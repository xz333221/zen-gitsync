// 「派发优先级」两个纯口径的单测。
//
// 这条链路没有按钮可点、界面上也看不出对错：顺序排得好不好、跳过哪一个，
// 只有在真派出去之后才知道。所以口径在这一层钉死 —— 尤其是"未安装的跳过"和
// "一个都没装时回落"，那两条出错的后果是"派不出去"，而不是"派得贵一点"。
import { describe, expect, test } from 'vitest'
import { normalizeExecutorPriority, pickByPriority } from './taskExecutor'

describe('normalizeExecutorPriority', () => {
  test('白名单外的值、重复项都丢掉，顺序原样保留', () => {
    expect(normalizeExecutorPriority(['pi', 'nope', 'claude', 'pi', 42, 'codearts']))
      .toEqual(['pi', 'claude', 'codearts'])
  })

  test('非数组一律空（手改配置写成字符串 / null）', () => {
    expect(normalizeExecutorPriority(undefined)).toEqual([])
    expect(normalizeExecutorPriority('pi')).toEqual([])
    expect(normalizeExecutorPriority(null)).toEqual([])
    expect(normalizeExecutorPriority({ 0: 'pi' })).toEqual([])
  })

  test('不排序 —— 顺序就是用户的成本意图', () => {
    // 按 TASK_EXECUTOR_OPTIONS 的顺序排会变成 claude,pi，那就把"先便宜的后贵的"弄丢了
    expect(normalizeExecutorPriority(['pi', 'claude'])).toEqual(['pi', 'claude'])
  })
})

describe('pickByPriority', () => {
  test('挑链上第一个已安装的', () => {
    expect(pickByPriority(['pi', 'codearts', 'claude'], { claude: true }, 'claude')).toBe('claude')
    expect(pickByPriority(['pi', 'codearts', 'claude'], { pi: true, claude: true }, 'claude')).toBe('pi')
    expect(pickByPriority(['pi', 'codearts', 'claude'], { codearts: true, claude: true }, 'claude')).toBe('codearts')
  })

  test('链上一个都没装 → 回落 fallback（不是报错，也不是链尾）', () => {
    expect(pickByPriority(['pi', 'codearts'], {}, 'opencode')).toBe('opencode')
    expect(pickByPriority([], { pi: true }, 'codex')).toBe('codex')
  })

  test('已安装但不在链上 → 不会被挑中（优先级是白名单语义）', () => {
    expect(pickByPriority(['pi'], { claude: true, pi: false }, 'claude')).toBe('claude')
  })
})
