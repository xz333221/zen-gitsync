// Copyright 2026 xz333221
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// 剪贴板收敛后的行为契约：两条路径各自的成功/失败，以及 DOM 不留残渣。
// 这三条此前分散在四个组件里各写一遍，谁改了一处都没人发现。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { copyTextToClipboard } from './clipboard'

function stubClipboard(writeText: () => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
}

function stubExecCommand(impl: () => boolean) {
  document.execCommand = vi.fn(impl) as unknown as typeof document.execCommand
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('copyTextToClipboard', () => {
  test('Clipboard API 可用时走它，不落 DOM', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)
    const exec = vi.fn(() => true)
    stubExecCommand(exec)

    await expect(copyTextToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(exec).not.toHaveBeenCalled()
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  test('Clipboard 被拒时降级到 textarea + execCommand', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')))
    let seenInDom = 0
    stubExecCommand(() => {
      seenInDom = document.querySelectorAll('textarea').length
      return true
    })

    await expect(copyTextToClipboard('fallback')).resolves.toBe(true)
    // 兜底路径必须真的把 textarea 挂上去（否则 select() 选不到东西）
    expect(seenInDom).toBe(1)
    // 用完要摘掉，不能每复制一次留一个节点
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  test('两条路径都失败时返回 false，且仍清理 DOM', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')))
    stubExecCommand(() => false)

    await expect(copyTextToClipboard('nope')).resolves.toBe(false)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  test('execCommand 抛错也不把异常漏给调用方', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')))
    stubExecCommand(() => { throw new Error('boom') })

    await expect(copyTextToClipboard('nope')).resolves.toBe(false)
  })
})
