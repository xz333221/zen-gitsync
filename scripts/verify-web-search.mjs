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
// 联网搜索（web_search / web_fetch）的**不依赖真实 key** 探针。分四组：
//   A. 工具注册：定义存在 + 分发命中 + 并发白名单 + 空参数短路（对照"未知工具"）
//   B. normalizeWebSearch 的归一化语义（默认 / 白名单 / 坏值）
//   C. runWebSearch 的返回归一化（mock 全局 fetch，不发真请求）
//   D. 前端设置面板契约（分区文案 / 三个申请入口 / 「去申请 Key」链接）
//
// 用法：
//   node scripts/verify-web-search.mjs            正向：应当全绿
//   node scripts/verify-web-search.mjs --reverse  反向：故意用与实现相反的期望，验证断言真的会红
//
// 真实调用（Firecrawl 免 key 搜索、Tavily/Exa 带 key）不在这里 —— 那要在用户填了
// key/代理之后单独跑，本脚本只保证"接线正确、形状正确、开关正确"。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const reverse = process.argv.includes('--reverse')

const importFromRoot = (rel) => import(pathToFileURL(path.join(root, rel)).href)

const toolsMod = await importFromRoot('src/cli/ai/tools.js')
const configMod = await importFromRoot('src/config.js')
const wsMod = await importFromRoot('src/cli/ai/webSearch.js')

const { TOOL_DEFINITIONS, executeTool, PARALLEL_SAFE_TOOLS } = toolsMod
const { normalizeWebSearch, WEB_SEARCH_PROVIDERS } = configMod
const { runWebSearch, WEB_SEARCH_PROVIDERS: WS_PROVIDERS } = wsMod

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   - ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.log(`  FAIL - ${name}: ${err.message}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   - ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.log(`  FAIL - ${name}: ${err.message}`)
  }
}

console.log('A. 工具注册')
const toolNames = TOOL_DEFINITIONS.map((d) => d?.function?.name)
check('TOOL_DEFINITIONS 含 web_search / web_fetch', () => {
  assert.ok(toolNames.includes('web_search'), 'web_search 未定义')
  assert.ok(toolNames.includes('web_fetch'), 'web_fetch 未定义')
})
check('PARALLEL_SAFE_TOOLS 含这两个只读工具', () => {
  assert.ok(PARALLEL_SAFE_TOOLS.has('web_search'), 'web_search 不在并发白名单')
  assert.ok(PARALLEL_SAFE_TOOLS.has('web_fetch'), 'web_fetch 不在并发白名单')
})
await checkAsync('web_search 空 query 短路（且已注册，不是"未知工具"）', async () => {
  const out = await executeTool('web_search', { query: '' }, {})
  assert.match(out, /query/, `期望提示缺少 query，实际: ${out}`)
  assert.doesNotMatch(out, /未知工具/, '工具疑似未注册')
})
await checkAsync('web_fetch 非法 url 短路', async () => {
  const out = await executeTool('web_fetch', { url: 'not-a-url' }, {})
  assert.match(out, /http/, `期望提示需要 http/https，实际: ${out}`)
  assert.doesNotMatch(out, /未知工具/)
})
await checkAsync('对照：未知工具仍然报"未知工具"', async () => {
  const out = await executeTool('__definitely_not_a_tool__', {}, {})
  assert.match(out, /未知工具/, `实际: ${out}`)
})

console.log('B. normalizeWebSearch 归一化')
check('undefined / null → null（调用方回落默认）', () => {
  assert.equal(normalizeWebSearch(undefined), null)
  assert.equal(normalizeWebSearch(null), null)
})
check('空对象 → 默认（开启 + firecrawl + 三个空 key + 空代理）', () => {
  const out = normalizeWebSearch({})
  assert.deepEqual(out, {
    enabled: true,
    provider: 'firecrawl',
    apiKeys: { firecrawl: '', tavily: '', exa: '' },
    proxy: '',
  })
})
check('非白名单 provider → 回落 firecrawl', () => {
  assert.equal(normalizeWebSearch({ provider: 'gpt-search' }).provider, 'firecrawl')
})
check('apiKeys 只保留白名单 provider 的键', () => {
  const out = normalizeWebSearch({ apiKeys: { tavily: 't-1', evil: 'x', exa: 123 } })
  assert.deepEqual(Object.keys(out.apiKeys).sort(), ['exa', 'firecrawl', 'tavily'])
  assert.equal(out.apiKeys.tavily, 't-1')
  assert.equal(out.apiKeys.exa, '', '非字符串 key 应置空串')
  assert.equal(out.apiKeys.evil, undefined, '白名单外的键应被丢弃')
})
check('非普通对象（数组 / 字符串）→ null', () => {
  assert.equal(normalizeWebSearch([]), null)
  assert.equal(normalizeWebSearch('x'), null)
})
check('enabled 只认布尔；proxy 非字符串 → 空串', () => {
  const out = normalizeWebSearch({ enabled: 'yes', proxy: 42 })
  assert.equal(out.enabled, true, '非布尔应回落 true')
  assert.equal(out.proxy, '')
})

console.log('C. runWebSearch 返回归一化（mock fetch）')
const realFetch = globalThis.fetch
const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ data: { web: [{ title: 'T', url: 'https://example.com/a', description: 'D' }] } })
    },
  }
}
await checkAsync('firecrawl：请求打到 /v2/search，结果裁成 {title,url,snippet}', async () => {
  const out = await runWebSearch({ query: 'hello', config: { provider: 'firecrawl', apiKeys: {}, proxy: '' } })
  assert.equal(out.provider, 'firecrawl')
  assert.equal(calls[0]?.url, 'https://api.firecrawl.dev/v2/search')
  assert.equal(out.results.length, 1)
  assert.deepEqual(out.results[0], { title: 'T', url: 'https://example.com/a', snippet: 'D' })
})
await checkAsync('tavily：缺 key 直接报错（不打网络）', async () => {
  let threw = ''
  const before = calls.length
  try {
    await runWebSearch({ query: 'hello', provider: 'tavily', config: { apiKeys: {} } })
  } catch (err) {
    threw = err.message
  }
  assert.match(threw, /Tavily/, `期望"未配置 Tavily API Key"，实际: ${threw}`)
  assert.equal(calls.length, before, '缺 key 时不应发请求')
})
globalThis.fetch = realFetch

console.log('D. 前端设置面板契约')
const dialog = readFileSync(path.join(root, 'src/ui/client/src/components/GitGlobalSettingsDialog.vue'), 'utf8')
const providersFile = readFileSync(path.join(root, 'src/ui/client/src/utils/webSearchProviders.ts'), 'utf8')
check('设置面板含「联网搜索」分区与开关', () => {
  assert.match(dialog, /@42BB9:联网搜索/, '缺联网搜索分区标题')
  assert.match(dialog, /@42BB9:启用联网搜索/, '缺启用开关标签')
  assert.match(dialog, /configStore\.webSearch\.enabled/, '开关未绑到 configStore.webSearch.enabled')
})
check('设置面板含代理地址输入', () => {
  assert.match(dialog, /@42BB9:代理地址/, '缺代理地址标签')
  assert.match(dialog, /configStore\.webSearch\.proxy/, '代理未绑到 configStore.webSearch.proxy')
})
check('每个 provider 都有 Key 输入 + 「去申请 Key」外链', () => {
  assert.match(dialog, /configStore\.webSearch\.apiKeys\[p\.id\]/, 'Key 输入未按 provider 绑定')
  assert.match(dialog, /@42BB9:去申请 Key/, '缺「去申请 Key」文案')
  assert.match(dialog, /:href="p\.applyUrl"/, '外链未绑到 applyUrl')
})
check('provider 元数据含三家申请入口', () => {
  assert.match(providersFile, /https:\/\/www\.firecrawl\.dev\//, '缺 Firecrawl 申请入口')
  assert.match(providersFile, /https:\/\/app\.tavily\.com\//, '缺 Tavily 申请入口')
  assert.match(providersFile, /https:\/\/exa\.ai\//, '缺 Exa 申请入口')
})

if (reverse) {
  // 反向验证：故意写一条与实现相反的断言。实现返回默认对象，这里断言 null —— 必然失败。
  // 若这条"照样绿"，说明探针的断言机制空转（拿不到真实返回值）。
  console.log('R. 反向验证（预期：这条应当 FAIL）')
  check('reverse: normalizeWebSearch({}) 应为 null（实现返回默认，故应红）', () => {
    assert.equal(normalizeWebSearch({}), null)
  })
}

console.log(`\n==> 通过 ${passed} 条，失败 ${failures.length} 条${reverse ? '（--reverse 下预期失败 1 条即正确）' : ''}`)
if (failures.length) {
  for (const f of failures) console.log(`   ✗ ${f}`)
  process.exitCode = 1
}
void WS_PROVIDERS
void WEB_SEARCH_PROVIDERS