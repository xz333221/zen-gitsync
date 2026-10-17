// ChatSilenceBadge：g ai 头部那枚「静默 x 秒」。
//
// 守三条展示口径（阈值本身是产品决定，改它就得同时改这三条断言）：
//   · 10 秒以下不渲染 —— 否则每次长工具调用都闪一下；
//   · 10 秒起才出现，数字走 formatDurationMs（与看板同一个格式化函数）；
//   · 60 秒起转告警色；不在生成中 / 等回答（调用方传 streaming=false）时一律不渲染。
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatSilenceBadge from './ChatSilenceBadge.vue'

// 全局桩是恒等函数（vitest.setup.ts），参数会被丢掉 —— 这里要断言插值后的文案。
// 时长格式化的真值在 relativeTime.test.ts 里守，这里换成确定性的桩：否则得连
// @WORKBENCH 的翻译表一起 mock 一遍（formatDurationMs 内部也是 $t(键, {n})）。
const { $tInterp } = vi.hoisted(() => ({
  $tInterp: (key: string, params?: Record<string, unknown>) =>
    params
      ? key.replace(/\{(\w+)\}/g, (_m, k) => String((params as Record<string, unknown>)[k] ?? `{${k}}`))
      : key,
}))
vi.mock('@/lang/static', () => ({ $t: $tInterp }))
vi.mock('@/utils/relativeTime', () => ({
  formatDurationMs: (ms: number) => `${Math.floor(ms / 1000)} 秒`,
}))

function mountBadge(silentMs: number | null, streaming = true) {
  return mount(ChatSilenceBadge, { props: { silentMs, streaming } })
}

describe('ChatSilenceBadge', () => {
  it('静默不足 10 秒不渲染', () => {
    expect(mountBadge(9_999).find('.chat-silence').exists()).toBe(false)
  })

  it('10 秒起显示，文案带格式化后的时长', () => {
    const w = mountBadge(12_000)
    expect(w.find('.chat-silence').exists()).toBe(true)
    expect(w.text()).toContain('静默 12 秒')
    expect(w.find('.chat-silence').classes()).not.toContain('is-warn')
  })

  it('60 秒起转告警色', () => {
    expect(mountBadge(60_000).find('.chat-silence').classes()).toContain('is-warn')
  })

  it('不在生成中 / 静默为 null 时不渲染', () => {
    expect(mountBadge(120_000, false).find('.chat-silence').exists()).toBe(false)
    expect(mountBadge(null).find('.chat-silence').exists()).toBe(false)
  })
})
