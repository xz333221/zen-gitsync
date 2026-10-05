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
// 提示策略的回归测试。要守的是**分流顺序**与**三个开关各自的作用**：
//   页面在前台 → 弹应用内 toast；页面在后台 → 发系统通知；系统通知发不出去 → 退回 toast。
//   三个通道（页面提示 / 浏览器通知 / 提示音）平级且互相独立，全关时一律不提示。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ page: true, browser: true, sound: true }))
const sys = vi.hoisted(() => ({ useSystem: false, canSend: true, sent: [] as any[] }))
const snd = vi.hoisted(() => ({ played: [] as string[] }))

vi.mock('@stores/configStore', () => ({
  useConfigStore: () => ({
    get notifyPageOnTaskDone() {
      return state.page
    },
    get notifyBrowserOnTaskDone() {
      return state.browser
    },
    get notifySoundOnTaskDone() {
      return state.sound
    },
  }),
}))

vi.mock('@/utils/taskNotify', () => ({
  // 真实的"前台/后台"判定在 taskNotify.test.ts 里测；这里只保住它与开关的耦合关系：
  // 浏览器通知关着就不该走系统通知那条路（忽略开关的桩会让"关着开关"的用例假通过）。
  shouldUseSystemNotification: (sw: { browser: boolean }) => sys.useSystem && sw.browser,
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
  state.page = true
  state.browser = true
  state.sound = true
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

  it('三个通道全关：一律不提示（返回 false，调用点据此知道没提示出去）', () => {
    state.page = false
    state.browser = false
    state.sound = false
    expect(announceAgentTurn({ kind: 'done', title: '会话 A' })).toBe(false)
    expect(snd.played).toHaveLength(0)
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(0)
  })

  it('只关页面提示：系统通知照发（它是唯一剩下的视觉通道，前台也发）', () => {
    state.page = false
    sys.useSystem = true
    announceAgentTurn({ kind: 'done', title: '会话 A' })
    expect(sys.sent).toHaveLength(1)
    expect(successCalls()).toHaveLength(0)
  })

  it('页面提示关着 + 系统通知也发不出去 → 不拿一条用户没要的 toast 顶上', () => {
    state.page = false
    sys.useSystem = true
    sys.canSend = false
    announceAgentTurn({ kind: 'done', title: '会话 A' })
    expect(sys.sent).toHaveLength(1)
    expect(successCalls()).toHaveLength(0)
  })

  it('浏览器通知关着：页面提示照弹，一个系统通知都不发', () => {
    state.browser = false
    sys.useSystem = true
    announceAgentTurn({ kind: 'done', title: '会话 A' })
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(1)
  })

  it('只开提示音：只有声音，两个视觉通道都不碰', () => {
    state.page = false
    state.browser = false
    state.sound = true
    announceAgentTurn({ kind: 'done', title: '会话 A' })
    expect(snd.played).toEqual(['done'])
    expect(sys.sent).toHaveLength(0)
    expect(successCalls()).toHaveLength(0)
  })

  it('提示音关着：提示照发，只是不出声', () => {
    state.sound = false
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
