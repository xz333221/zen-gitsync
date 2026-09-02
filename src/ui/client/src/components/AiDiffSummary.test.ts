import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const configStore = vi.hoisted(() => ({
  models: [{ id: 'model-1' }],
  locale: 'zh-CN'
}))

vi.mock('@stores/configStore', () => ({ useConfigStore: () => configStore }))
vi.mock('@/lang/static', () => ({ $t: (key: string) => key }))

import AiDiffSummary from './AiDiffSummary.vue'

function sseResponse(scope: string) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: {"type":"delta","content":"${scope} summary"}\n\n`))
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('AiDiffSummary', () => {
  const calls: Array<{ scope: string; signal: AbortSignal; body: Record<string, unknown> }> = []

  beforeEach(() => {
    vi.useFakeTimers()
    calls.length = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      const scope = body.scope
      calls.push({ scope, signal: init?.signal as AbortSignal, body })
      return sseResponse(scope)
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function mountSummary(props: Record<string, unknown>) {
    return mount(AiDiffSummary, {
      props: props as any,
      global: {
        stubs: {
          MarkdownPreview: { props: ['content'], template: '<div>{{ content }}</div>' },
          ElIcon: { template: '<i><slot /></i>' },
          // 透传 title,让测试能按语义选中按钮(头部按钮顺序会变,按索引选会悄悄点错)
          ElButton: {
            props: ['title', 'disabled'],
            template: '<button :title="title" :disabled="disabled"><slot /></button>'
          }
        }
      }
    })
  }

  test('one instance requests and renders only its assigned scope', async () => {
    const fileWrapper = mountSummary({
      source: 'worktree', scope: 'file', file: 'a.ts', fileRevision: 'diff-a'
    })
    const overallWrapper = mountSummary({ source: 'worktree', scope: 'overall' })

    await vi.advanceTimersByTimeAsync(400)
    await Promise.resolve()

    expect(calls.map(call => call.scope)).toEqual(['file', 'overall'])
    expect(calls.every(call => !call.signal.aborted)).toBe(true)
    expect(fileWrapper.find('.scope-tabs').exists()).toBe(false)
    expect(fileWrapper.find('.is-file').exists()).toBe(true)
    expect(overallWrapper.find('.is-overall').exists()).toBe(true)
    fileWrapper.unmount()
    overallWrapper.unmount()
  })

  test('changing the selected file refreshes only the file summary instance', async () => {
    const wrapper = mountSummary({
      source: 'worktree', scope: 'file', file: 'a.ts', fileRevision: 'diff-a'
    })

    await vi.advanceTimersByTimeAsync(400)
    await wrapper.setProps({ file: 'b.ts', fileRevision: 'diff-b' })
    await vi.advanceTimersByTimeAsync(400)
    await Promise.resolve()

    expect(calls.filter(call => call.scope === 'file')).toHaveLength(2)
    expect(calls.filter(call => call.scope === 'overall')).toHaveLength(0)
    wrapper.unmount()
  })

  test('a changed worktree file set invalidates the overall summary cache', async () => {
    const wrapper = mountSummary({ source: 'worktree', scope: 'overall', revision: 'a.ts' })
    await vi.advanceTimersByTimeAsync(400)

    await wrapper.setProps({ revision: 'a.ts\0b.ts' })
    await vi.advanceTimersByTimeAsync(400)

    expect(calls.filter(call => call.scope === 'overall')).toHaveLength(2)
    wrapper.unmount()
  })

  test('manual refresh bypasses the server cache', async () => {
    const wrapper = mountSummary({ source: 'commit', scope: 'overall', commitHash: 'abcdef1' })
    await vi.advanceTimersByTimeAsync(400)

    // $t 被 mock 成返回 key 本身,title 即 '@DIFFAI:重新生成'
    const refreshBtn = wrapper.find('button[title="@DIFFAI:重新生成"]')
    expect(refreshBtn.exists()).toBe(true)
    await refreshBtn.trigger('click')
    await Promise.resolve()

    expect(calls).toHaveLength(2)
    expect(calls[0].body.bypassCache).toBeUndefined()
    expect(calls[1].body.bypassCache).toBe(true)
    wrapper.unmount()
  })
})
