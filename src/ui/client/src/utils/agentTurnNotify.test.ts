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
// 提示策略的回归测试。要守的是**分流顺序**与**两个"不该提示"**：
//   页面在前台 → 弹应用内 toast；页面在后台 → 发系统通知；系统通知发不出去 → 退回 toast。
//   总开关关着时一声都不响（提示音是从属于它的子开关）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ notifyEnabled: true, soundEnabled: true }))
const sys = vi.hoisted(() => ({ useSystem: false, canSend: true, sent: [] as any[] }))
const snd = vi.hoisted(() => ({ played: [] as string[] }))

vi.mock('@stores/configStore', () => ({
  useConfigStore: () => ({
    get notifyOnTaskDone() {
      return state.notifyEnabled
    },
    get notifySoundOnTaskDone() {
      return state.soundEnabled
    },
  }),
}))

vi.mock('@/utils/taskNotify', () => ({
  shouldUseSystemNotification: () => sys.useSystem,
  notifySystem: (opts: any) => {
    sys.sent.push(opts)
    return sys.canSend
  },
}))

// 提示音只记"响了哪种"：真实 Audio 的行为在 utils/taskSound.test.ts 里测。
vi.mock('@/utils/taskSound', () => ({
  playFinishSound: (kind: string) => {
    snd.played.push(kind)
    return true
  },
}))

import { ElMessage } from 'element-plus'
import { announceAgentTurn, agentTurnDetail, agentTurnNoticeTitle } from './agentTurnNotify'

const successCalls = () => (ElMessage.success as unknown as { mock: { calls: any[][] } }).mock.calls
const errorCalls = () => (ElMessage.error as unknown as { mock: { calls: any[][] } }).mock.calls

beforeEach(() => {
  state.notifyEnabled = true
  state.soundEnabled = true
  sys.useSystem = false
  sys.canSend = true
  sys.sent = []
  snd.played = []
  vi.clearAllMocks()
})

describe('agentTurnDetail', () => {
  it('取最后一行非空输出，并把换行压成空格', () => {
    expect(agentTurnDetail('先做了 A\n\n又做了 B\n\n')).toBe('又做了 B')
  })

  it('空 / 非字符串 / 全空白都返回空串（不是 undefined）', () => {
    expect(agentTurnDetail('')).toBe('')
    expect(agentTurnDetail('   \n ')).toBe('')
    expect(agentTurnDetail(undefined)).toBe('')
    expect(agentTurnDetail(123)).toBe('')
  })

  it('超长截到 200 字以内并以省略号收尾', () => {
    const detail = agentTurnDetail('x'.repeat(500))
    expect(detail.length).toBeLessThanOrEqual(200)
    expect(detail.endsWith('…')).toBe(true)
  })
})

describe('agentTurnNoticeTitle', () => {
  it('完成与出错各有各的标题（测试环境 $t 是 identity，直接拿到 key）', () => {
    expect(agentTurnNoticeTitle('done')).toBe('@AGENT:对话已完成')
    expect(agentTurnNoticeTitle('error')).toBe('@AGENT:对话出错')
  })
})

describe('announceAgentTurn 分流', () => {
  it('页面在前台：不出系统通知，弹应用内 toast', () => {
    expect(announceAgentTurn({ kind: 'done', title: '会话 A' })).toBe(true)
    expect(sys.sent).toHaveLength(0)
    expect(snd.played).toEqual(['done'])
    expect(String(successCalls()[0][0])).toContain('@AGENT:对话完成')
  })

  it('页面在后台：发系统通知，body 是「会话名 + 最后一行」，不再弹 toast', () => {
    sys.useSystem = true
    announceAgentTurn({ kind: 'done', title: '会话 A', detail: '第一步\n\n改完了', tag: 'zen-gitsync-agent-A' })
    expect(sys.sent).toEqual([
      { title: '@AGENT:对话已完成', body: '会话 A\n改完了', tag: 'zen-gitsync-agent-A' }
    ])
    expect(successCalls()).toHaveLength(0)
  })

  it('系统通知发不出去（权限被拒）时退回应用内 toast，不让人什么都收不到', () => {
    sys.useSystem = true
    sys.canSend = false
    announceAgentTurn({ kind: 'error', title: '会话 A', detail: 'boom' })
    expect(sys.sent).toHaveLength(1)
    expect(snd.played).toEqual(['error'])
    expect(String(errorCalls()[0][0])).toContain('@AGENT:对话出错')
  })

  it('出错时带 alreadyToast：只出声/发通知，不再补一条应用内提示', () => {
    announceAgentTurn({ kind: 'error', title: '会话 A', detail: 'boom', alreadyToast: true })
    expect(snd.played).toEqual(['error'])
    expect(errorCalls()).toHaveLength(0)
  })

  it('总开关关着：一律不提示（提示音开关开着也不行，它从属于总开关）', () => {
    state.notifyEnabled = false
    expect(announceAgentTurn({ kind: 'done', title: '会话 A' })).toBe(false)
    expect(snd.played).toHaveLength(0)
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(0)
  })

  it('提示音开关关着：提示照发，只是不出声', () => {
    state.soundEnabled = false
    sys.useSystem = true
    announceAgentTurn({ kind: 'done', title: '会话 A' })
    expect(snd.played).toHaveLength(0)
    expect(sys.sent).toHaveLength(1)
  })

  it('标题为空时回落到「(无标题)」，不发一条空标题的通知', () => {
    // 用系统通知那条路验：toast 文案走 $t，测试环境是 identity，看不出 name 替换没生效
    sys.useSystem = true
    announceAgentTurn({ kind: 'done', title: '   ' })
    expect(sys.sent[0].body).toBe('@AGENT:无标题')
  })
})
