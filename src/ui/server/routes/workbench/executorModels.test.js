// 执行器模型探测的单测。
//
// 为什么这些用例值得写：这个模块的全部价值是"读三种格式的配置文件"，
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

test('detectExecutorModels: 三家配置齐全时各自读出模型', async () => {
  const home = await makeHome({
    '.claude/settings.json': CLAUDE_JSON,
    '.codex/config.toml': CODEX_TOML,
    '.config/opencode/opencode.jsonc': OPENCODE_JSONC,
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
  assert.deepEqual(out.opencode, { model: 'anthropic/claude-x', display: null, provider: null })
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

test('detectExecutorModels: 一个配置文件都没有时三项全 null 且不抛', async () => {
  const home = await makeHome()
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out, { claude: null, codex: null, opencode: null })
})

test('detectExecutorModels: 配置残缺/是目录/内容不是 JSON 时只让自己变 null', async () => {
  const home = await makeHome({
    '.claude/settings.json': '{ 这不是 JSON', // 解析失败 → null
    '.codex/config.toml': '# 只有注释，没有 model\n', // 无 model → null
    '.config/opencode/opencode.json': '{"model":""}', // 空串 → null
  })
  const out = await detectExecutorModels({ homeDir: home })
  assert.deepEqual(out, { claude: null, codex: null, opencode: null })
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
    { name: 'deepseek-v4.1-flash', detail: 'claude-sonnet-5[1M]', provider: 'http://127.0.0.1:15721' },
  )
})

test('formatExecutorModel: 两个名字相同则不重复进 detail', () => {
  assert.deepEqual(
    formatExecutorModel({ model: 'same', display: 'same', provider: null }),
    { name: 'same', detail: null, provider: null },
  )
})

test('formatExecutorModel: 只有别名时就用别名，detail 为空', () => {
  assert.deepEqual(
    formatExecutorModel({ model: 'only-alias', display: null, provider: null }),
    { name: 'only-alias', detail: null, provider: null },
  )
})

test('formatExecutorModel: null / 空对象一律 null（前端据此走"未在配置中指定"）', () => {
  assert.equal(formatExecutorModel(null), null)
  assert.equal(formatExecutorModel(undefined), null)
  assert.equal(formatExecutorModel({ model: null, display: null, provider: null }), null)
  assert.equal(formatExecutorModel({ model: '', display: '', provider: null }), null)
})
