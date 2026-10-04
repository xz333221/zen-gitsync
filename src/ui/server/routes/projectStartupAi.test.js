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
// 「AI 推荐启动方式」的回归测试。
//
// 覆盖四件事:
//   1. collectProjectFacts —— 扫出来的是**事实**(脚本、标志文件、README 摘要),
//      忽略目录不进结果,坏掉的 package.json 不致命。
//   2. buildStartupPrompt —— 事实真的进了 prompt,脚本被截断时必须写明"只能推荐列出来的"。
//   3. validateSuggestions —— 这一层是**幻觉过滤器**:脚本名/目录不在扫描结果里的一律丢掉。
//      少了它,一句 `npm run dev:all` 就能变成界面上点了报错的按钮。
//   4. 路由出口 —— NO_MODEL 不联网;模型返回的一堆幻觉建议,过完路由后必须只剩合法的那条
//      (证明过滤真的在请求链路上跑,而不只是单测里调了一次函数)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildStartupPrompt,
  collectProjectFacts,
  detectPackageManager,
  isRunnableShellCommand,
  pickScripts,
  registerProjectStartupAiRoutes,
  validateSuggestions,
} from './projectStartupAi.js'

/**
 * 铺一份 monorepo 夹具:根 + client + server,外加一个必须被忽略的 node_modules。
 * 每个用例自己建一份 —— 共享目录会在并行跑测试时互相踩。
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-startup-ai-'))
  const write = (rel, content) => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content, 'utf8')
  }

  write('README.md', '# Demo Project\n\n## 启动方式\n\n先 `npm run dev:server`,再 `npm run dev:vue`。\n')
  write('Dockerfile', 'FROM node:20\n')
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write('package.json', JSON.stringify({
    name: 'demo-root',
    packageManager: 'pnpm@9.1.0',
    workspaces: ['client', 'server'],
    scripts: {
      'dev': 'concurrently "npm:dev:server" "npm:dev:vue"',
      'dev:server': 'node server/index.js',
      'dev:vue': 'vite',
      'verify:wb-card-hover-mask': 'node scripts/verify-hover.cjs',
      'lint': 'eslint .',
    },
    devDependencies: { concurrently: '^9.0.0', vite: '^5.0.0' },
  }, null, 2))
  write('client/package.json', JSON.stringify({
    name: 'demo-client',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { vue: '^3.5.0' },
  }, null, 2))
  write('server/package.json', JSON.stringify({
    name: 'demo-server',
    scripts: { start: 'node index.js' },
  }, null, 2))
  write('node_modules/left-pad/package.json', JSON.stringify({ name: 'left-pad', scripts: { dev: 'echo nope' } }))
  write('client/node_modules/vite/package.json', JSON.stringify({ name: 'vite', scripts: { dev: 'echo nope' } }))
  return root
}

const factsOf = (root) => collectProjectFacts(root)

// ── collectProjectFacts ───────────────────────────────────────────────────

test('collectProjectFacts: 扫到脚本与标志文件,node_modules 不进结果', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)

  assert.equal(facts.projectName, 'demo-root')
  assert.equal(facts.packageManager, 'pnpm')            // packageManager 字段 + pnpm-lock 都指向 pnpm
  assert.deepEqual(facts.dirs.map(d => d.relativePath), ['.', 'client', 'server'])
  assert.ok(facts.dirs.every(d => !d.relativePath.includes('node_modules')))

  const rootDir = facts.dirs[0]
  assert.deepEqual(rootDir.pkg.scripts.dev, 'concurrently "npm:dev:server" "npm:dev:vue"')
  assert.equal(rootDir.pkg.workspaces, true)
  assert.ok(rootDir.markers.includes('Dockerfile'))
  assert.ok(rootDir.markers.includes('pnpm-lock.yaml'))
  assert.ok(facts.readmeHead.includes('启动方式'))       // README 开头进了事实
})

test('collectProjectFacts: package.json 坏掉只丢这个包,不炸整个扫描', async () => {
  const root = makeFixture()
  fs.writeFileSync(path.join(root, 'client/package.json'), '{ this is not json', 'utf8')
  const facts = await factsOf(root)

  assert.equal(facts.dirs[0].pkg.name, 'demo-root')      // 根还在
  // 坏掉的包不进结果 —— 没有脚本可推荐,留着只会让模型对着一个空壳编脚本名
  const clientDir = facts.dirs.find(d => d.relativePath === 'client')
  assert.equal(clientDir, undefined)
  assert.ok(facts.dirs.some(d => d.relativePath === 'server'), '后面还有目录,扫描没被中断')
})

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('pickScripts: 名字像"启动"的排前面,超量截断', () => {
  const picked = pickScripts({
    'verify:wb-card-hover-mask': 'node x.cjs',
    'zzz-unrelated': 'echo 1',
    'dev:server': 'node server/index.js',
    'dev': 'vite',
  }, 2)

  assert.deepEqual(picked.map(([name]) => name), ['dev', 'dev:server'])
})

test('detectPackageManager: 声明字段优先于锁文件,都没有就是 npm', () => {
  assert.equal(detectPackageManager(['yarn.lock'], null), 'yarn')
  assert.equal(detectPackageManager(['pnpm-lock.yaml'], { packageManager: 'yarn@4' }), 'yarn')
  assert.equal(detectPackageManager([], null), 'npm')
})

test('isRunnableShellCommand: 空 / 换行 / 超长一律不算能跑的命令', () => {
  assert.equal(isRunnableShellCommand('docker compose up -d'), true)
  assert.equal(isRunnableShellCommand('   '), false)
  assert.equal(isRunnableShellCommand('npm run dev\nrm -rf /'), false)
  assert.equal(isRunnableShellCommand('x'.repeat(401)), false)
})

// ── buildStartupPrompt ────────────────────────────────────────────────────

test('buildStartupPrompt: 脚本、标志文件、README 都进 prompt,中英各一套', async () => {
  const facts = await factsOf(makeFixture())
  const zh = buildStartupPrompt(facts, 'zh')
  const en = buildStartupPrompt(facts, 'en')

  assert.ok(zh.includes('dev = concurrently'))
  assert.ok(zh.includes('标志文件:'))
  assert.ok(zh.includes('Dockerfile'))
  assert.ok(zh.includes('启动方式'))
  assert.ok(zh.includes('只输出 JSON'))
  assert.ok(!zh.includes('node_modules'))

  assert.ok(en.includes('Output JSON only'))
  assert.ok(en.includes('demo-client'))
  assert.ok(!en.includes('只输出 JSON'))
})

test('buildStartupPrompt: 脚本被截断时必须告诉模型"只能推荐列出来的"', async () => {
  const root = makeFixture()
  const many = {}
  for (let i = 0; i < 200; i++) many[`task-${String(i).padStart(3, '0')}`] = `node scripts/t${i}.cjs`
  fs.writeFileSync(path.join(root, 'client/package.json'), JSON.stringify({ name: 'demo-client', scripts: many }), 'utf8')

  const facts = await factsOf(root)
  const zh = buildStartupPrompt(facts, 'zh')

  assert.ok(zh.includes('未列出'), '截断必须写在 prompt 里,否则模型会推荐没列出来的脚本名')
  assert.ok(zh.length < 60000, `prompt 不该被脚本撑爆,实际 ${zh.length} 字`)
})

// ── validateSuggestions:幻觉过滤器 ─────────────────────────────────────────

const RAW_VALID = {
  title: '同时起前后端',
  kind: 'npm',
  package: '.',
  script: 'dev',
  order: 1,
  reason: '一条命令同时起后端和前端',
}

test('validateSuggestions: 合法的 npm 建议换成可直接执行的绝对路径', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  const [item] = validateSuggestions([RAW_VALID], facts, root, 'zh')

  assert.equal(item.kind, 'npm')
  assert.equal(item.scriptName, 'dev')
  assert.equal(item.command, 'pnpm run dev')            // 用项目自己的包管理器
  assert.equal(item.packagePath, path.join(root, '.'))
  assert.equal(item.order, 1)
  assert.equal(item.reason, '一条命令同时起后端和前端')
})

test('validateSuggestions: 编造的脚本名 / 包路径一律丢掉', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  const kept = validateSuggestions([
    { ...RAW_VALID, script: 'dev:all' },                 // 根目录没有这条脚本
    { ...RAW_VALID, package: 'packages/client', script: 'dev' },  // 这个目录根本没扫到
    { ...RAW_VALID, package: 'client', script: 'build' },         // 这条是真的
  ], facts, root, 'zh')

  assert.equal(kept.length, 1)
  assert.equal(kept[0].packageLabel, 'client')
  assert.equal(kept[0].scriptName, 'build')
})

test('validateSuggestions: script 写成整条命令时能救回来,救不回就丢', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  const kept = validateSuggestions([
    { title: 'a', kind: 'npm', package: 'client', command: 'pnpm run build' },   // 从 command 里抠出 build
    { title: 'b', kind: 'npm', package: 'client', command: 'pnpm run build:all' }, // client 没有 build:all
    { title: 'c', kind: 'npm', package: 'client', command: 'vite --host' },       // 不是 run 形态,丢
  ], facts, root, 'zh')

  assert.equal(kept.length, 1)
  assert.equal(kept[0].scriptName, 'build')
})

test('validateSuggestions: shell 命令只允许落在扫到过的目录里', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  const kept = validateSuggestions([
    { title: 'docker', kind: 'shell', command: 'docker compose up -d', cwd: '.', order: 1 },
    { title: '越界', kind: 'shell', command: 'ls', cwd: '../..' },        // 没扫到过的目录
    { title: '绝对路径', kind: 'shell', command: 'ls', cwd: 'C:\\Windows' },
    { title: '多行', kind: 'shell', command: 'npm i\nnpm run dev', cwd: '.' },
    { title: '子目录', kind: 'shell', command: 'node index.js', cwd: 'server', order: 2 },
  ], facts, root, 'zh')

  assert.deepEqual(kept.map(k => k.command), ['docker compose up -d', 'node index.js'])
  assert.equal(kept[1].cwd, path.join(root, 'server'))
  assert.equal(kept[1].cwdLabel, 'server')
})

test('validateSuggestions: 去重、按 order 排序、重编号并限量', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  const kept = validateSuggestions([
    { ...RAW_VALID, script: 'dev:vue', order: 3 },
    { ...RAW_VALID, script: 'dev', order: 2 },
    { ...RAW_VALID, script: 'dev:vue', order: 5 },        // 重复
    { ...RAW_VALID, script: 'not-exist', order: 0 },
    { ...RAW_VALID, package: 'client', script: 'dev', order: 10 },
  ], facts, root, 'zh')

  assert.deepEqual(kept.map(k => k.scriptName), ['dev', 'dev:vue', 'dev'])
  assert.deepEqual(kept.map(k => k.order), [1, 2, 3])   // 编号连续,不受模型给的 order 影响
})

test('validateSuggestions: 不是数组 / 空对象都不该抛', async () => {
  const root = makeFixture()
  const facts = await factsOf(root)
  assert.deepEqual(validateSuggestions(null, facts, root, 'zh'), [])
  assert.deepEqual(validateSuggestions([null, 'x', 42, {}], facts, root, 'zh'), [])
})

// ── 路由 ──────────────────────────────────────────────────────────────────

/** 只收 post 路由的假 app —— 与 recentDirectoriesAiSummary.test.js 同一套路,不起 express */
function createFakeApp() {
  const routes = new Map()
  return {
    routes,
    post(routePath, ...handlers) { routes.set(routePath, handlers.at(-1)) },
  }
}

function createFakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res },
    json(payload) { res.body = payload; return res },
  }
  return res
}

/** 把 globalThis.fetch 换成吐固定 LLM 响应的桩;返回 [恢复函数, 收到的请求数组] */
function stubLlm(content) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || '{}'), headers: init?.headers || {} })
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    }
  }
  return [() => { globalThis.fetch = original }, calls]
}

const MODEL = { model: 'fixture-model', baseURL: 'https://api.example.com/v1', apiKey: 'k', isDefault: true }

async function runRoute({ models, root, locale = 'zh' }) {
  const app = createFakeApp()
  registerProjectStartupAiRoutes({
    app,
    configManager: { readRawConfigFile: async () => ({ models }) },
    getCurrentProjectPath: () => root,
  })
  const res = createFakeRes()
  await app.routes.get('/api/project-startup/suggestions')({ body: { locale } }, res)
  return res
}

test('路由: 没配模型直接 NO_MODEL,一次网络请求都不发', async () => {
  const root = makeFixture()
  const [restore, calls] = stubLlm('{"suggestions":[]}')
  try {
    const res = await runRoute({ models: [], root })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.success, false)
    assert.equal(res.body.code, 'NO_MODEL')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('路由: 模型返回一堆幻觉,过完路由只剩那条真的', async () => {
  const root = makeFixture()
  const hallucinated = JSON.stringify({
    suggestions: [
      RAW_VALID,
      { title: '假脚本', kind: 'npm', package: '.', script: 'dev:all' },
      { title: '假目录', kind: 'npm', package: 'apps/web', script: 'dev' },
      { title: '越界 shell', kind: 'shell', command: 'rm -rf /', cwd: '../../..' },
      { title: '单起前端', kind: 'npm', package: 'client', script: 'dev', order: 2 },
    ],
  })
  const [restore, calls] = stubLlm(hallucinated)
  try {
    const res = await runRoute({ models: [MODEL], root })

    assert.equal(res.body.success, true)
    assert.deepEqual(
      res.body.suggestions.map(s => `${s.packageLabel || s.cwdLabel}:${s.scriptName || s.command}`),
      ['.:dev', 'client:dev']
    )
    assert.equal(res.body.model, 'fixture-model')
    // 事实真的进了 prompt —— 否则上面那两条"合法的"建议就只是碰巧
    assert.ok(calls[0].body.messages.at(-1).content.includes('dev:server = node server/index.js'))
    assert.equal(calls[0].body.response_format.type, 'json_object')
  } finally {
    restore()
  }
})

test('路由: 目录里没有任何可扫的东西 → NO_FACTS,不白花一次模型钱', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-startup-ai-empty-'))
  const [restore, calls] = stubLlm('{"suggestions":[]}')
  try {
    const res = await runRoute({ models: [MODEL], root: empty })
    assert.equal(res.statusCode, 400)
    assert.equal(res.body.code, 'NO_FACTS')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('路由: 模型返回非 JSON → LLM_ERR(前端据此提示,而不是显示空列表)', async () => {
  const root = makeFixture()
  const [restore] = stubLlm('我觉得你这个项目应该用 npm run dev 启动')
  try {
    const res = await runRoute({ models: [MODEL], root })
    assert.equal(res.statusCode, 500)
    assert.equal(res.body.code, 'LLM_ERR')
  } finally {
    restore()
  }
})
