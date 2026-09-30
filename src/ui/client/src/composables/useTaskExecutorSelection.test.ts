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
// 「上次用过哪个执行器」这条链路上最容易写坏的一点：**没装导致的回落不能落盘**。
// 落了就等于把"卸载了 claude"这种一次性的环境状态记成"上次用过"，
// 等 claude 装回来时用户真正的上次已经被盖掉，而且再也回不来。这条钉死。
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTaskExecutorSelection } from './useTaskExecutorSelection'
import { useConfigStore } from '@/stores/configStore'
import { useToolsStore } from '@/stores/toolsStore'

function stubConfig(configData: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/config/getConfig') {
      return new Response(JSON.stringify({ currentDirectory: 'C:\\repo-a', ...configData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  }))
}

function setInstalled(avail: { claude?: boolean; opencode?: boolean; codex?: boolean }) {
  const tools = useToolsStore()
  tools.claudeAvailable = avail.claude ?? false
  tools.opencodeAvailable = avail.opencode ?? false
  tools.codexAvailable = avail.codex ?? false
}

describe('useTaskExecutorSelection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('上次用过的执行器装了 → 就用它', async () => {
    stubConfig({ ui: { lastTaskExecutor: 'opencode' } })
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({ opencode: true, claude: true })

    const { active, selected } = useTaskExecutorSelection()
    expect(active.value).toBe('opencode')
    expect(selected.value).toBe('opencode')
  })

  test('上次用过的没装 → 显示回落，**但不写回**（别把环境状态记成上次用过）', async () => {
    stubConfig({ ui: { lastTaskExecutor: 'opencode' } })
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({ claude: true, opencode: false })

    const { active, selected } = useTaskExecutorSelection()
    expect(active.value).toBe('claude')       // 显示/派发用可用的
    expect(selected.value).toBe('opencode')   // 但"上次用过"原样留着
    expect(configStore.ui.lastTaskExecutor).toBe('opencode')
  })

  test('opencode 装回来后自动回到它（回落是纯计算，没被固化）', async () => {
    stubConfig({ ui: { lastTaskExecutor: 'opencode' } })
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({ claude: true, opencode: false })
    const { active } = useTaskExecutorSelection()
    expect(active.value).toBe('claude')

    setInstalled({ claude: true, opencode: true })
    expect(active.value).toBe('opencode')
  })

  test('一个都没装时不换 —— 保持原样，交给后端报 spawn 失败', async () => {
    stubConfig({ ui: { lastTaskExecutor: 'codex' } })
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({})

    const { active, hasAnyExecutor } = useTaskExecutorSelection()
    expect(active.value).toBe('codex')
    expect(hasAnyExecutor.value).toBe(false)
  })

  test('choose 落盘；选没装的直接不接（后端会 spawn ENOENT）', async () => {
    stubConfig({})
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({ claude: true, codex: false })

    const { choose, selected } = useTaskExecutorSelection()
    choose('codex')
    expect(selected.value).not.toBe('codex')
    expect(configStore.ui.lastTaskExecutor).toBeNull()

    choose('claude')
    expect(selected.value).toBe('claude')
    expect(configStore.ui.lastTaskExecutor).toBe('claude')
  })

  test('没选过 → 回落设置里配的默认值 taskExecutor', async () => {
    stubConfig({ taskExecutor: 'codex' })
    const configStore = useConfigStore()
    await configStore.loadConfig()
    setInstalled({ codex: true })

    const { selected } = useTaskExecutorSelection()
    expect(selected.value).toBe('codex')
  })
})
