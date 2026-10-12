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
// 「和 g ai 对话时固定注入的两块提示词」的拼装与取数口径。
//
// 这个能力是**纯 prompt 注入**的：没有按钮、没有状态、界面上看不出对错。
// 改 agentChat.js / runExternalTurn.js 的人（哪怕只是把一段挪个位置）会无声地把它弄掉，
// 而用户只会觉得"模型今天不太听话"。所以口径在这一层逐条钉住，注入点那条链路由
// agentChatShared.test.js 跑真实 runAgentTurn 验（见那里的"用户固定提示词"用例）。
//
// 注意：必须在 import 之前把 USERPROFILE/HOME 指到沙箱 —— chatPrompts.js 会连带
// 加载 configManager 与 orchestratorStore，它们按 home 定位 ~/.zen-gitsync。
// 本文件里的用例全部走注入口（不读真实配置），沙箱只是防"哪天有人加了真实读取"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'zen-chat-prompts-'))
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX
delete process.env.HOMEDRIVE
delete process.env.HOMEPATH

const { buildChatPromptSection, resolveChatPromptSection } = await import('./chatPrompts.js')

// ── 拼装（纯函数）─────────────────────────────────────────

test('两块都没配 → 空串（调用方据此完全跳过注入，连一节标题都不出现）', () => {
  assert.equal(buildChatPromptSection({}), '')
  assert.equal(buildChatPromptSection({ gaiPrompt: '', dispatchPrompt: '' }), '')
  // 只有空白也算没配 —— 用户清空后留下一堆换行，不该在提示词里留一节空标题
  assert.equal(buildChatPromptSection({ gaiPrompt: '   \n\n ', dispatchPrompt: '\t' }), '')
})

test('两块都在 → 各带自己的小标题，g ai 那段在前', () => {
  const out = buildChatPromptSection({ gaiPrompt: '回答用中文', dispatchPrompt: '改完就提交' })
  assert.match(out, /### g ai 默认提示词\n回答用中文/)
  assert.match(out, /### 派发任务的提示词（与工作台派发任务时附加的是同一份）\n改完就提交/)
  assert.ok(out.indexOf('回答用中文') < out.indexOf('改完就提交'), 'g ai 那段必须在前')
})

test('只配一块 → 只出那一块（另一块不留空标题）', () => {
  const onlyGai = buildChatPromptSection({ gaiPrompt: '回答用中文' })
  assert.match(onlyGai, /### g ai 默认提示词/)
  assert.doesNotMatch(onlyGai, /### 派发任务的提示词/)

  const onlyDispatch = buildChatPromptSection({ dispatchPrompt: '改完就提交' })
  assert.match(onlyDispatch, /### 派发任务的提示词/)
  assert.doesNotMatch(onlyDispatch, /### g ai 默认提示词/)
})

test('正文前后空白被裁掉，中间原样保留（用户排版不被破坏）', () => {
  const out = buildChatPromptSection({ gaiPrompt: '\n\n第一段\n\n第二段\n\n' })
  assert.match(out, /### g ai 默认提示词\n第一段\n\n第二段$/)
})

test('英文界面走英文标题（与系统提示词同一套 locale 判定）', () => {
  const out = buildChatPromptSection({ gaiPrompt: 'answer in Chinese', locale: 'en-US' })
  assert.match(out, /### g ai default prompt/)
  assert.match(out, /Standing instructions|Settings/)
})

test('非字符串入参不炸（手改配置塞了数字 / 对象）', () => {
  assert.equal(buildChatPromptSection({ gaiPrompt: 42, dispatchPrompt: {} }), '')
})

// ── 取数 ────────────────────────────────────────────────

test('两块分别来自两处：g ai 默认提示词取 config，派发提示词取 orchestrator', async () => {
  const seenCwd = []
  const out = await resolveChatPromptSection({
    cwd: 'D:\\ws\\alpha',
    loadAgentPrompt: async () => '回答用中文',
    loadDispatchPrompt: async (cwd) => { seenCwd.push(cwd); return '改完就提交' },
  })
  assert.match(out, /回答用中文/)
  assert.match(out, /改完就提交/)
  assert.deepEqual(seenCwd, ['D:\\ws\\alpha'], '派发提示词必须按本轮 cwd 解析（项目级那条靠它生效）')
})

test('取数抛错一律当"没配"，绝不把整轮对话打挂', async () => {
  const both = await resolveChatPromptSection({
    loadAgentPrompt: async () => { throw new Error('config.json 坏了') },
    loadDispatchPrompt: async () => { throw new Error('orchestrator.json 坏了') },
  })
  assert.equal(both, '', '两边都挂 = 不注入')

  // 一边挂另一边照常：坏的那份不该连累好的那份
  const half = await resolveChatPromptSection({
    loadAgentPrompt: async () => '回答用中文',
    loadDispatchPrompt: async () => { throw new Error('orchestrator.json 坏了') },
  })
  assert.match(half, /回答用中文/)
  assert.doesNotMatch(half, /### 派发任务的提示词/)
})

test('返回值是字符串而不是 undefined（调用方直接拼进 system，undefined 会印出字面量）', async () => {
  const out = await resolveChatPromptSection({ loadAgentPrompt: async () => '', loadDispatchPrompt: async () => '' })
  assert.equal(typeof out, 'string')
  assert.equal(out, '')
})
