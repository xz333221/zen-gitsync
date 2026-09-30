import { describe, test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DirListRefreshButton from './DirListRefreshButton.vue'

describe('tmp DirListRefreshButton', () => {
  test('空闲态:文案 + 可点 + 抛 click', async () => {
    const w = mount(DirListRefreshButton, { props: { label: '刷新全部', title: '要联网', ariaLabel: '刷新全部' } })
    const btn = w.get('button.dir-list__refresh')
    expect(btn.text()).toContain('刷新全部')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    expect(btn.attributes('title')).toBe('要联网')
    expect(btn.attributes('aria-label')).toBe('刷新全部')
    await btn.trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })

  test('刷新中:禁用 + 图标转圈 + 不抛 click', async () => {
    const w = mount(DirListRefreshButton, { props: { label: '刷新中 3/18', refreshing: true } })
    const btn = w.get('button.dir-list__refresh')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.text()).toContain('刷新中 3/18')
    expect(btn.find('.is-spinning').exists()).toBe(true)
    // 原生 disabled 之外再兜一道:程序化触发也不能重复发起
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  test('无目录时(disabled)同样不抛 click', async () => {
    const w = mount(DirListRefreshButton, { props: { label: '刷新全部', disabled: true } })
    const btn = w.get('button.dir-list__refresh')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })

  test('ariaLabel 缺省时退回 title', () => {
    const w = mount(DirListRefreshButton, { props: { label: '刷新全部', title: '要联网' } })
    expect(w.get('button').attributes('aria-label')).toBe('要联网')
  })
})
