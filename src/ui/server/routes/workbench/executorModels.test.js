// 执行器模型探测的单测。
//
// 为什么这些用例值得写：这个模块的全部价值是"读五种格式的配置文件"，
// 而三种格式的解析都是**手写的**（不引 TOML / JSONC 依赖，理由见模块注释）——
// 手写解析最容易在两个地方悄悄错：注释/空行的截断、以及多文件兜底被丢掉。
// 这两处都已经真出过 bug（见下面标 [回归] 的用例），所以它们必须钉住。
//
// 所有用例都在**临时沙箱 home** 里跑，绝不读真实 ~/ —— 否则用例会随开发机
// 装没装 claude、配没配模型而时红时绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import {
  readTomlTopLevel,
  stripJsonComments,
  detectExecutorModels,
  formatExecutorModel,
} from './executorModels.js'

const sandboxes = []

/** 造一个只属于本用例的 home 目录，按 {相对路径: 内容} 落文件 */
async function makeHome(files = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-executor-models-'))
  sandboxes.push(home)
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(home, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content, 'utf8')
  }
  return home
}

test.after(async () => {
  for (const home of sandboxes) await fs.rm(home, { recursive: true, force: true })
})

// ── readTomlTopLevel ─────────────────────────────────────────────────────────

test('readTomlTopLevel: 注释行与空行不截断顶层读取 [回归]', () => {
  // 老实现把「空行 / 注释行 / 段头」三类一起 break，于是文件第一行是注释时
  // 顶层 model 整个读空 —— 表现为界面上 codex 永远显示"未配置"。
  const toml = [
    '# codex 配置说明',
    '# 第二行注释',
    'model = "gpt-6-astra"',
    '',
    'model_provider = "custom"',
    '',
    '[model_providers.custom]',
    'name = "kakouai"',
  ].join('\n')
  assert.deepEqual(readTomlTopLevel(toml, ['model', 'model_provider']), {
    model: 'gpt-6-astra',
    model_provider: 'custom',
  })
})

test('readTomlTopLevel: 段内的同名键不会被当成顶层值', () => {
  const toml = 'model = "top"\n\n[projects."c:/x"]\nmodel = "inner"\n'
  assert.equal(readTomlTopLevel(toml, ['model']).model, 'top')
})

test('readTomlTopLevel: 只取白名单里的键（其余含密钥的键一律不取）', () => {
  const toml = 'model = "m"\nexperimental_bearer_token = "tok"\napi_key = "k"\n'
  assert.deepEqual(readTomlTopLevel(toml, ['model']), { model: 'm' })
})

test('readTomlTopLevel: 行尾注释不污染值；单引号值也认', () => {
  const toml = "model = 'm-1' # 备注\nmodel_provider = \"custom\"#紧贴的注释\n"
  assert.deepEqual(readTomlTopLevel(toml, ['model', 'model_provider']), {
    model: 'm-1',
    model_provider: 'custom',
  })
})

test('readTomlTopLevel: 段头里带方括号的路径不被误判成值', () => {
  const toml = 'model = "m"\n\n[projects.\'c:\\weird[path]\']\nmodel = "inner"\n'
  assert.equal(readTomlTopLevel(toml, ['model']).model, 'm')
})

// ── stripJsonComments ────────────────────────────────────────────────────────

test('stripJsonComments: 字符串里的 // 不被当注释（base_url 场景）', () => {
  const jsonc = '{ "url": "https://api.example.com/v1", // 注释\n "n": 1 }'
  assert.equal(JSON.parse(stripJsonComments(jsonc)).url, 'https://api.example.com/v1')
})

test('stripJsonComments: 剥块注释与尾逗号后仍能 JSON.parse', () => {
  const jsonc = '{\n  /* 块\n     注释 */\n  "model": "a/b",\n}'
  assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), { model: 'a/b' })
})

test('stripJsonComments: 转义引号不影响"在不在字符串里"的判断', () => {
  const jsonc = '{ "s": "a\\"//b", "n": 1 } // 尾注释'
  assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), { s: 'a"//b', n: 1 })
})

// ── detectExecutorModels（沙箱 home）─────────────────────────────────────────

const CLAUDE_JSON = JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5[1M]',
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4.1-flash',
    ANTHROPIC_API_KEY: 'sk-should-never-leak',
  },
})
const CODEX_TOML = [
  '# 顶层注释',
  'model = "gpt-6-astra"',
  'model_provider = "custom"',
  '',
  '[model_providers.custom]',
  'name = "kakouai"',
  'experimental_bearer_token = "tok-should-never-leak"',
  '',
  '[projects."c:/x"]',
  'model = "inner-model"',
].join('\n')
const OPENCODE_JSONC = '{\n  // 注释\n  "model": "anthropic/claude-x",\n}'
const CODEBUDDY_JSON = JSON.stringify({ model: 'deepseek-v4-1-flash-260910' })
const PI_JSON = JSON.stringify({ defaultModel: 'deepseek/deepseek-v4-flash' })

test('detectExecutorModels: 五家配置齐全时各自读出模型', async () => {
  const home = await makeHome({
    '.claude/settings.json': CLAUDE_JSON,
    '.codex/config.toml': CODEX_TOML,
    '.config/opencode/opencode.jsonc': OPENCODE_JSONC,
    '.codebuddy/settings.json': CODEBUDDY_JSON,
    '.pi/agent/settings.json': PI_JSON,
  })
  const out = await detectExecutorModels({ homeDir: home })

  assert.deepEqual(out.claude, {
    model: 'claude-sonnet-5[1M]',
    display: 'deepseek-v4.1-flash',
    provider: 'http://127.0.0.1:15721',
  })
  // 顶层注释不再截断 → model_provider 读得到 → 服务商名也能查出来
  assert.deepEqual(out.codex, { model: 'gpt-6-astra', display: null, provider: 'kakouai' })
  // 只有 .jsonc（没有 .json）时也要读到：早先那个 promise 被解构丢掉，这里是死代码
  assert.deepEqual(out.opencode, {
    model: 'anthropic/claude-x', display: null, provider: null, source: 'config',
  })
  // codebuddy：一个文件一处键，没有"第二来源"（TUI 选择会写回 settings.json）
  assert.deepEqual(out.codebuddy, {
    model: 'deepseek-v4-1-flash-260910', display: null, provider: null, source: 'config',
  })
  // pi：键名是 defaultModel（官方 settings 文档的 "Startup model ID"），不是 model
  assert.deepEqual(out.pi, {
    model: 'deepseek/deepseek-v4-flash', display: null, provider: null, source: 'config',
  })
})

test('detectExecutorModels: codebuddy 没配 model 时为 null（CLI 内置默认不冒名）', async () => {
  const home = await makeHome({ '.codebuddy/settings.json': '{"theme":"dark"}' })
  assert.equal((await detectExecutorModels({ homeDir: home })).codebuddy, null)
})

test('detectExecutorModels: pi 没配 defaultModel 且没有会话记录时为 null（不猜）', async () => {
  const home = await makeHome({ '.pi/agent/settings.json': '{"theme":"dark"}' })
  assert.equal((await detectExecutorModels({ homeDir: home })).pi, null)
})

test('detectExecutorModels: pi 的 defaultModel 不是字符串时为 null', async () => {
  const home = await makeHome({ '.pi/agent/settings.json': '{"defaultModel":42}' })
  assert.equal((await detectExecutorModels({ homeDir: home })).pi, null)
})

test('detectExecutorModels: 只有 .jsonc 时 opencode 仍读得到 [回归]', async () => {
  const home = await makeHome({ '.config/opencode/opencode.jsonc': OPENCODE_JSONC })
  const out = await detectExecutorModels({ homeDir: home })
  assert.equal(out.opencode?.model, 'anthropic/claude-x')
})

test('detectExecutorModels: .json 与 .jsonc 同时存在时 .json 优先', async () => {
  const home = await makeHome({
    '.config/opencode/opencode.json': '{"model":"from-json"}',
    '.config/opencode/opencode.jsonc': '{"model":"from-jsonc"}',
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.equal(out.opencode?.model, 'from-json')
})

test('detectExecutorModels: opencode 的 model 是对象时带上 variant', async () => {
  const home = await makeHome({
    '.config/opencode/opencode.json': '{"model":{"model":"openai/gpt-y","variant":"high"}}',
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.equal(out.opencode?.model, 'openai/gpt-y (high)')
})

// ── opencode 的第二处来源：TUI 状态 ──────────────────────────────────────────
//
// opencode 的 TUI 允许直接选模型，而它把选择**存在自己的 state 里、不回写配置文件**。
// 只读配置文件的话，对一个明明在跑的模型显示"未在配置中指定" —— 用户会去翻配置，
// 配置里确实没有，白折腾一场。这组用例钉住"配置文件优先、没有则退回 state"。

const OPENCODE_STATE = JSON.stringify({
  recent: [
    { providerID: 'opencode-go', modelID: 'space-bunny-free' },
    { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' },
  ],
  favorite: [],
  variant: { 'opencode-go/space-bunny-free': 'max', 'opencode-go/deepseek-v4.1-flash': 'max' },
})

test('detectExecutorModels: 配置里没写 model 时，退回 TUI 状态里的「最近使用」', async () => {
  const home = await makeHome({
    // 本机真实情形：配置文件里只有一个 $schema
    '.config/opencode/opencode.jsonc': '{\n  "$schema": "https://opencode.ai/config.json"\n}',
    '.local/state/opencode/model.json': OPENCODE_STATE,
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out.opencode, {
    model: 'opencode-go/space-bunny-free (max)', // recent[0] + variant 表里的 max
    display: null,
    provider: null, // 模型名本身已是 provider/model，不再重复报一次
    source: 'state',
  })
})

test('detectExecutorModels: 配置文件里写了 model 就以它为准（state 只是兜底）', async () => {
  const home = await makeHome({
    '.config/opencode/opencode.json': '{"model":"anthropic/claude-x"}',
    '.local/state/opencode/model.json': OPENCODE_STATE,
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out.opencode, {
    model: 'anthropic/claude-x', display: null, provider: null, source: 'config',
  })
})

test('detectExecutorModels: recent 项自带 variant 时优先于顶层 variant 表', async () => {
  const home = await makeHome({
    '.config/opencode/opencode.jsonc': '',
    '.local/state/opencode/model.json': JSON.stringify({
      recent: [{ providerID: 'p', modelID: 'm', variant: 'own' }],
      variant: { 'p/m': 'mapped' },
    }),
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.equal(out.opencode?.model, 'p/m (own)')
})

test('detectExecutorModels: state 里没有 recent / 缺字段时仍是 null（不猜）', async () => {
  const empty = await makeHome({ '.local/state/opencode/model.json': '{"recent":[],"favorite":[]}' })
  assert.equal((await detectExecutorModels({ homeDir: empty })).opencode, null)

  const partial = await makeHome({
    '.local/state/opencode/model.json': '{"recent":[{"providerID":"p"}]}',
  })
  assert.equal((await detectExecutorModels({ homeDir: partial })).opencode, null)
})

test('detectExecutorModels: 两处都没有 model 才是真的"未在配置中指定"', async () => {
  const home = await makeHome({ '.config/opencode/opencode.json': '{"model":""}' })
  assert.equal((await detectExecutorModels({ homeDir: home })).opencode, null)
})

// ── pi 的第二处来源：会话记录 ────────────────────────────────────────────────
//
// pi 的 ~/.pi/agent/settings.json 只在用户显式「设为默认」时才写 defaultModel
// （setModel 的 persist 分支），日常直接开 pi 的人那份文件是空的（本机就是：
// 里面只有 lastChangelogVersion）。此时 pi 走自己的回落链（CLI 参数 →
// --models 范围 → 会话恢复 → 配置默认 → **第一个有凭据的模型**），而"到底落了
// 哪个"只写在会话 jsonl 的 model_change 记录里。
// 只读配置文件的话，界面会对一个**正在跑的模型**说「未在配置中指定」——
// 用户会去翻配置，配置里确实没有，白折腾一场（2026-10-13 用户报的就是这个）。
// 这组用例钉住"配置文件优先、没有则退回会话记录"，以及**取最新会话的最后一条**。

/** 一条 model_change 记录（形状来自真实 CLI 输出，见 taskRunner.pi.test.js） */
const piModelChange = (provider, modelId) => ({
  type: 'model_change', id: 'x', parentId: null,
  timestamp: '2026-10-13T09:36:32.779Z', provider, modelId,
})
/** 把若干行拼成 jsonl；字符串行原样放进去（用来造坏行） */
const jsonl = (lines) => lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
/** 会话文件路径：目录按 cwd 编码分，文件名是 <UTC ISO 时间戳>_<uuid>.jsonl */
const piSession = (stamp, id, lines) => ({
  [`.pi/agent/sessions/--D--ws-demo--/${stamp}_${id}.jsonl`]: jsonl(lines),
})

test('detectExecutorModels: pi 配置里没写 defaultModel 时，退回会话记录里的模型', async () => {
  const home = await makeHome({
    // 本机真实情形：settings.json 里只有 lastChangelogVersion
    '.pi/agent/settings.json': '{"lastChangelogVersion":"1.2.0"}',
    ...piSession('2026-10-13T09-36-32-719Z', 'aaa', [
      { type: 'session', id: 'aaa', cwd: 'd:\\ws\\demo' },
      piModelChange('cc-switch-open-code-go', 'deepseek-v4.1-flash'),
      { type: 'message', message: { role: 'user', content: '你好' } },
    ]),
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out.pi, {
    model: 'deepseek-v4.1-flash',
    display: null,
    provider: 'cc-switch-open-code-go',
    source: 'state', // 与 opencode 同源：CLI 自己记的"最近使用"，不是用户配的默认值
  })
})

test('detectExecutorModels: pi 配置里写了 defaultModel 就以它为准（会话只是兜底）', async () => {
  const home = await makeHome({
    '.pi/agent/settings.json': JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-x',
    }),
    ...piSession('2026-10-13T09-36-32-719Z', 'aaa', [
      piModelChange('cc-switch-open-code-go', 'deepseek-v4.1-flash'),
    ]),
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out.pi, {
    model: 'claude-x',
    display: null,
    provider: 'anthropic', // defaultProvider 是"这个模型打给谁"，与 claude 的 base_url 同一个位置
    source: 'config',
  })
})

test('detectExecutorModels: pi 取**最新**那个会话文件，旧会话不算', async () => {
  const home = await makeHome({
    // 文件名前缀是 UTC ISO 时间戳 → 字典序即时间序（探测器就是按字符串比的）
    ...piSession('2026-10-13T09-33-31-743Z', 'old', [piModelChange('p-old', 'm-old')]),
    ...piSession('2026-10-13T09-36-32-719Z', 'new', [piModelChange('p-new', 'm-new')]),
  })
  assert.equal((await detectExecutorModels({ homeDir: home })).pi?.model, 'm-new')
})

test('detectExecutorModels: pi 的会话目录按 cwd 分，跨目录也挑最新的那个', async () => {
  const home = await makeHome({
    '.pi/agent/sessions/--D--ws-other--/2026-10-12T01-00-00-000Z_x.jsonl':
      jsonl([piModelChange('p-other', 'm-other')]),
    '.pi/agent/sessions/--D--ws-demo--/2026-10-13T09-36-32-719Z_y.jsonl':
      jsonl([piModelChange('p-demo', 'm-demo')]),
  })
  assert.equal((await detectExecutorModels({ homeDir: home })).pi?.model, 'm-demo')
})

test('detectExecutorModels: pi 同一会话里 TUI 换过模型时，取**最后**一条 model_change', async () => {
  const home = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'aaa', [
    piModelChange('p', 'started-with'),
    { type: 'message', message: { role: 'user', content: '换个模型' } },
    piModelChange('p', 'switched-to'),
    { type: 'message', message: { role: 'assistant', content: '好' } },
  ]))
  assert.equal((await detectExecutorModels({ homeDir: home })).pi?.model, 'switched-to')
})

test('detectExecutorModels: pi 会话文件很长时，头部与尾部两端都要扫（拼接顺序不能反）', async () => {
  // 文件远大于扫描窗口（512KB）：起步用的模型在头部、切过去的在尾部。
  // 只扫尾部会漏掉"从没换过模型"的会话；只扫头部会把**开头**那个当成最近用的。
  const filler = Array.from({ length: 9000 }, (_, i) => ({
    type: 'message', id: `f${i}`, message: { role: 'assistant', content: 'x'.repeat(200) },
  }))
  const home = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'big', [
    piModelChange('p', 'at-the-top'),
    ...filler,
    piModelChange('p', 'at-the-bottom'),
  ]))
  assert.equal((await detectExecutorModels({ homeDir: home })).pi?.model, 'at-the-bottom')

  // 对照：同一形状但尾部没有 model_change（从没换过）→ 回落到头部那条，而不是 null
  const home2 = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'big', [
    piModelChange('p', 'only-at-the-top'),
    ...filler,
  ]))
  assert.equal((await detectExecutorModels({ homeDir: home2 })).pi?.model, 'only-at-the-top')
})

test('detectExecutorModels: 会话大小在 1~2 个扫描窗口之间时，尾部那段也要读到', async () => {
  // 回归：判"要不要读两段"曾写成 `tailStart < headLen`，于是 1~2 个窗口大的会话
  // （头尾两段重叠）被误判成"一个窗口装得下"，只返回头部 —— 模型恰好换在文件末尾
  // 的会话就永远报开头那个。这里造一个 ~700KB 的会话（512KB < size < 1024KB）钉住它。
  const filler = Array.from({ length: 660 }, (_, i) => ({
    type: 'message', id: `f${i}`, message: { role: 'assistant', content: 'x'.repeat(1000) },
  }))
  const home = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'mid', [
    piModelChange('p', 'at-the-top'),
    ...filler,
    piModelChange('p', 'at-the-bottom'),
  ]))
  const size = (await fs.stat(path.join(home, '.pi/agent/sessions/--D--ws-demo--',
    '2026-10-13T09-36-32-719Z_mid.jsonl'))).size
  assert.ok(size > 512 * 1024 && size < 1024 * 1024, `夹具大小应在 1~2 个窗口之间，实际 ${size}`)
  assert.equal((await detectExecutorModels({ homeDir: home })).pi?.model, 'at-the-bottom')
})

test('detectExecutorModels: pi 会话里没有可用的 model_change 时仍是 null（不猜）', async () => {
  // 空目录 / 没有 .jsonl / 全是坏行 / modelId 非字符串 —— 一律当"没读到"
  const empty = await makeHome({ '.pi/agent/sessions/--D--ws-demo--/.keep': '' })
  assert.equal((await detectExecutorModels({ homeDir: empty })).pi, null)

  const junk = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'aaa', [
    '{ 这不是 JSON',
    JSON.stringify({ type: 'model_change', provider: 'p' }), // 缺 modelId
    JSON.stringify({ type: 'model_change', provider: 'p', modelId: '   ' }), // 全空白
    JSON.stringify({ type: 'message', modelId: 'looks-like-one' }), // 不是 model_change
  ]))
  assert.equal((await detectExecutorModels({ homeDir: junk })).pi, null)
})

test('detectExecutorModels: pi 会话记录里的对话内容绝不进返回值', async () => {
  const home = await makeHome(piSession('2026-10-13T09-36-32-719Z', 'aaa', [
    piModelChange('p', 'm'),
    { type: 'message', message: { role: 'user', content: 'sk-should-never-leak' } },
    { type: 'session', apiKey: 'tok-should-never-leak' },
  ]))
  const serialized = JSON.stringify(await detectExecutorModels({ homeDir: home }))
  assert.equal(serialized.includes('sk-should-never-leak'), false)
  assert.equal(serialized.includes('tok-should-never-leak'), false)
  assert.equal(serialized.includes('should-never-leak'), false)
})

test('detectExecutorModels: PI_CODING_AGENT_DIR 换掉配置目录时，settings 与会话都跟着走', async () => {
  // 官方环境变量（pi 的 config.js getAgentDir）。设了却还读 ~/.pi/agent 的话，
  // 会把"配了模型"报成"没配" —— 界面撒谎。
  const home = await makeHome({
    '.pi/agent/settings.json': '{"theme":"dark"}', // 旧目录：不该被读到
    'custom-pi/settings.json': '{"defaultModel":"from-custom-dir"}',
    'custom-pi/sessions/--D--ws-demo--/2026-10-13T09-36-32-719Z_a.jsonl':
      jsonl([piModelChange('p', 'm-from-custom-dir')]),
  })
  const prev = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = path.join(home, 'custom-pi')
  try {
    const out = await detectExecutorModels({ homeDir: home })
    assert.equal(out.pi?.model, 'from-custom-dir')
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
  }
})

test('detectExecutorModels: claude 显式 ANTHROPIC_MODEL 优先于档位别名', async () => {
  const home = await makeHome({
    '.claude/settings.json': JSON.stringify({
      env: {
        ANTHROPIC_MODEL: 'my-explicit-model',
        ANTHROPIC_BASE_URL: 'http://proxy.local',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-alias',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-real',
      },
    }),
  })
  const out = await detectExecutorModels({ homeDir: home })
  // 显式指定时没有"别名背后"的第二层，但 base_url 仍要带出来
  assert.deepEqual(out.claude, {
    model: 'my-explicit-model',
    display: null,
    provider: 'http://proxy.local',
  })
})

test('detectExecutorModels: 一个配置文件都没有时五项全 null 且不抛', async () => {
  const home = await makeHome()
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out, { claude: null, codex: null, opencode: null, codebuddy: null, pi: null })
})

test('detectExecutorModels: 配置残缺/是目录/内容不是 JSON 时只让自己变 null', async () => {
  const home = await makeHome({
    '.claude/settings.json': '{ 这不是 JSON', // 解析失败 → null
    '.codex/config.toml': '# 只有注释，没有 model\n', // 无 model → null
    '.config/opencode/opencode.json': '{"model":""}', // 空串 → null
    '.codebuddy/settings.json': '{"model":123}', // 非字符串 → null
    '.pi/agent/settings.json': '{ 也不是 JSON', // 解析失败 → null
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out, { claude: null, codex: null, opencode: null, codebuddy: null, pi: null })
})

test('detectExecutorModels: 返回值里绝不出现任何密钥', async () => {
  const home = await makeHome({
    '.claude/settings.json': CLAUDE_JSON,
    '.codex/config.toml': CODEX_TOML,
  })
  const serialized = JSON.stringify(await detectExecutorModels({ homeDir: home }))
  assert.equal(serialized.includes('sk-should-never-leak'), false)
  assert.equal(serialized.includes('tok-should-never-leak'), false)
})

// ── formatExecutorModel ──────────────────────────────────────────────────────

test('formatExecutorModel: display 优先，别名落到 detail', () => {
  assert.deepEqual(
    formatExecutorModel({
      model: 'claude-sonnet-5[1M]',
      display: 'deepseek-v4.1-flash',
      provider: 'http://127.0.0.1:15721',
    }),
    { name: 'deepseek-v4.1-flash', detail: 'claude-sonnet-5[1M]', provider: 'http://127.0.0.1:15721', source: null },
  )
})

test('formatExecutorModel: 两个名字相同则不重复进 detail', () => {
  assert.deepEqual(
    formatExecutorModel({ model: 'same', display: 'same', provider: null }),
    { name: 'same', detail: null, provider: null, source: null },
  )
})

test('formatExecutorModel: 只有别名时就用别名，detail 为空', () => {
  assert.deepEqual(
    formatExecutorModel({ model: 'only-alias', display: null, provider: null }),
    { name: 'only-alias', detail: null, provider: null, source: null },
  )
})

test('formatExecutorModel: 来源（config / state）照实透传出去', () => {
  assert.equal(
    formatExecutorModel({ model: 'm', display: null, provider: null, source: 'state' }).source,
    'state',
  )
  assert.equal(
    formatExecutorModel({ model: 'm', display: null, provider: null, source: 'config' }).source,
    'config',
  )
})

test('formatExecutorModel: null / 空对象一律 null（前端据此走"未在配置中指定"）', () => {
  assert.equal(formatExecutorModel(null), null)
  assert.equal(formatExecutorModel(undefined), null)
  assert.equal(formatExecutorModel({ model: null, display: null, provider: null }), null)
  assert.equal(formatExecutorModel({ model: '', display: '', provider: null }), null)
})
