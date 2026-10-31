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
const { runWebSearch, runWebFetch, WEB_SEARCH_PROVIDERS: WS_PROVIDERS } = wsMod

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
check('空对象 → 默认（开启 + firecrawl + 四个空 key / 空地址 + 空代理）', () => {
  const out = normalizeWebSearch({})
  assert.deepEqual(out, {
    enabled: true,
    provider: 'firecrawl',
    apiKeys: { firecrawl: '', tavily: '', exa: '', searxng: '' },
    baseUrls: { firecrawl: '', tavily: '', exa: '', searxng: '' },
    proxy: '',
  })
})
check('非白名单 provider → 回落 firecrawl；但 "all"（聚合）是合法值', () => {
  assert.equal(normalizeWebSearch({ provider: 'gpt-search' }).provider, 'firecrawl')
  assert.equal(normalizeWebSearch({ provider: 'all' }).provider, 'all')
})
check('apiKeys 只保留白名单 provider 的键', () => {
  const out = normalizeWebSearch({ apiKeys: { tavily: 't-1', evil: 'x', exa: 123 } })
  assert.deepEqual(Object.keys(out.apiKeys).sort(), ['exa', 'firecrawl', 'searxng', 'tavily'])
  assert.equal(out.apiKeys.tavily, 't-1')
  assert.equal(out.apiKeys.exa, '', '非字符串 key 应置空串')
  assert.equal(out.apiKeys.evil, undefined, '白名单外的键应被丢弃')
})
check('baseUrls 只保留白名单 provider 的键', () => {
  const out = normalizeWebSearch({ baseUrls: { searxng: 'http://127.0.0.1:8899/', evil: 'x', exa: 123 } })
  assert.deepEqual(Object.keys(out.baseUrls).sort(), ['exa', 'firecrawl', 'searxng', 'tavily'])
  assert.equal(out.baseUrls.searxng, 'http://127.0.0.1:8899/')
  assert.equal(out.baseUrls.exa, '', '非字符串地址应置空串')
  assert.equal(out.baseUrls.evil, undefined, '白名单外的键应被丢弃')
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
  assert.deepEqual(out.results[0], { title: 'T', url: 'https://example.com/a', snippet: 'D', source: 'firecrawl' })
})
await checkAsync('tavily：缺 key 时回退到 firecrawl，并标记 fallbackFrom', async () => {
  const before = calls.length
  const out = await runWebSearch({ query: 'hello', provider: 'tavily', config: { apiKeys: {} } })
  assert.equal(out.provider, 'firecrawl', `期望回退 firecrawl，实际: ${out.provider}`)
  assert.equal(out.fallbackFrom, 'tavily', `期望 fallbackFrom=tavily，实际: ${out.fallbackFrom}`)
  assert.equal(out.results.length, 1)
  assert.equal(calls.length, before + 1, '应只调用 firecrawl 一次')
})
globalThis.fetch = async (url) => {
  const u = String(url)
  const resp = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body) } })
  if (u.includes('127.0.0.1:8899/search')) {
    return resp({ results: [{ title: 'S', url: 'https://example.com/s', content: 'C', score: 0.7 }] })
  }
  if (u.includes('/v2/scrape')) {
    return resp({ data: { markdown: 'BODY', metadata: { title: 'T' } } })
  }
  return resp({})
}
await checkAsync('searxng：走 /search?format=json 并归一化', async () => {
  const out = await runWebSearch({
    query: 'hello',
    provider: 'searxng',
    config: { provider: 'searxng', apiKeys: {}, baseUrls: { searxng: 'http://127.0.0.1:8899/' } },
  })
  assert.equal(out.provider, 'searxng')
  assert.equal(out.results.length, 1)
  assert.equal(out.results[0].url, 'https://example.com/s')
})
await checkAsync('web_fetch：searxng 回退 firecrawl', async () => {
  const out = await runWebFetch({
    url: 'https://example.com/a',
    provider: 'searxng',
    config: { baseUrls: { searxng: 'http://127.0.0.1:8899/' } },
  })
  assert.equal(out.provider, 'firecrawl')
  assert.equal(out.fallbackFrom, 'searxng')
  assert.equal(out.text, 'BODY')
})

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({ data: { web: [
      { title: 'upper', url: 'https://example.com/A', description: 'a', score: 0.9 },
      { title: 'lower', url: 'https://example.com/a', description: 'b', score: 0.2 },
      { title: 'dup', url: 'https://example.com/a/', description: 'c', score: 0.5 },
    ] } })
  },
})
await checkAsync('结果去重保留 path 大小写，并按 score 排序', async () => {
  const out = await runWebSearch({ query: 'q', config: { provider: 'firecrawl', apiKeys: {} } })
  assert.equal(out.results.length, 2, `期望 /A 与 /a 保留两条，实际 ${out.results.length}`)
  assert.equal(out.results[0].title, 'upper')
  assert.equal(out.results[1].title, 'lower')
})

// ── C2. 聚合模式（provider = all）：并发多引擎 + URL 去重 + 交错取样 + source ──
console.log('C2. 聚合模式（provider=all）')
let failTavily = false
const aggCalls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  aggCalls.push(u)
  const resp = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body) } })
  if (u.includes('firecrawl.dev')) {
    return resp({ data: { web: [
      { title: 'F1', url: 'https://a.com/1', description: 'f1' },
      { title: 'F2', url: 'https://shared.com/x', description: 'f2' },
    ] } })
  }
  if (u.includes('tavily.com')) {
    if (failTavily) return { ok: false, status: 401, async text() { return '{"error":"nope"}' } }
    return resp({ results: [
      { title: 'T1', url: 'https://shared.com/x/', content: 't1' },
      { title: 'T2', url: 'https://b.com/2', content: 't2' },
    ] })
  }
  if (u.includes('exa.ai')) {
    return resp({ results: [{ title: 'E1', url: 'https://c.com/3', text: 'e1' }] })
  }
  return resp({})
}
const threeKeys = { firecrawl: 'f', tavily: 't', exa: 'e' }

await checkAsync('all：并发三家、合并去重、每条标注 source', async () => {
  aggCalls.length = 0
  failTavily = false
  const out = await runWebSearch({ query: 'q', maxResults: 5, provider: 'all', config: { provider: 'all', apiKeys: threeKeys } })
  assert.equal(out.provider, 'all')
  assert.equal(aggCalls.filter((u) => u.includes('firecrawl.dev')).length, 1, 'firecrawl 应被调用一次')
  assert.equal(aggCalls.filter((u) => u.includes('tavily.com')).length, 1, 'tavily 应被调用一次')
  assert.equal(aggCalls.filter((u) => u.includes('exa.ai')).length, 1, 'exa 应被调用一次')
  // F2 与 T1 归一化后同页（尾斜杠差异），去重应只留一条
  assert.equal(out.results.length, 4, `期望去重后 4 条，实际 ${out.results.length}`)
  assert.equal(new Set(out.results.map((r) => r.url.replace(/\/$/, ''))).size, out.results.length, '存在重复 URL')
  assert.deepEqual([...new Set(out.results.map((r) => r.source))].sort(), ['exa', 'firecrawl', 'tavily'])
  assert.equal(out.results[0].source, 'firecrawl', '交错取样首条应来自 firecrawl')
})

await checkAsync('all：没配 key 的引擎被跳过（不白跑）', async () => {
  aggCalls.length = 0
  const out = await runWebSearch({ query: 'q', provider: 'all', config: { provider: 'all', apiKeys: { firecrawl: 'f' } } })
  assert.equal(aggCalls.filter((u) => u.includes('tavily.com')).length, 0, 'tavily 无 key 不应被调用')
  assert.equal(aggCalls.filter((u) => u.includes('exa.ai')).length, 0, 'exa 无 key 不应被调用')
  assert.ok(out.results.every((r) => r.source === 'firecrawl'))
})

await checkAsync('all：个别引擎失败不拖垮整次，errors 记录失败项', async () => {
  aggCalls.length = 0
  failTavily = true
  const out = await runWebSearch({ query: 'q', provider: 'all', config: { provider: 'all', apiKeys: threeKeys } })
  assert.ok(out.results.length > 0, '仍应返回其它引擎的结果')
  assert.ok(out.errors.some((e) => e.includes('tavily')), `errors 应含 tavily：${JSON.stringify(out.errors)}`)
})

globalThis.fetch = async (url) => {
  const u = String(url)
  const resp = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body) } })
  if (u.includes('/v2/scrape')) {
    return resp({ data: { markdown: 'BODY', metadata: { title: 'Title' } } })
  }
  return resp({})
}
await checkAsync('web_fetch：tavily 缺 key 回退到 firecrawl', async () => {
  const out = await runWebFetch({ url: 'https://example.com/a', provider: 'tavily', config: { apiKeys: {} } })
  assert.equal(out.provider, 'firecrawl', `期望回退 firecrawl，实际: ${out.provider}`)
  assert.equal(out.fallbackFrom, 'tavily', `期望 fallbackFrom=tavily，实际: ${out.fallbackFrom}`)
  assert.equal(out.text, 'BODY')
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
check('provider 元数据含四家入口', () => {
  assert.match(providersFile, /https:\/\/www\.firecrawl\.dev\//, '缺 Firecrawl 申请入口')
  assert.match(providersFile, /https:\/\/app\.tavily\.com\//, '缺 Tavily 申请入口')
  assert.match(providersFile, /https:\/\/exa\.ai\//, '缺 Exa 申请入口')
  assert.match(providersFile, /https:\/\/docs\.searxng\.org\//, '缺 SearXNG 文档入口')
})
check('SearXNG 在设置面板有实例地址输入', () => {
  assert.match(dialog, /webSearch\.baseUrls\[p\.id\]/, '缺 baseUrls 输入')
  assert.match(dialog, /needsBaseUrl/, '缺 needsBaseUrl 分支')
})
check('web_search 工具允许 provider=all / searxng', () => {
  const def = TOOL_DEFINITIONS.find((d) => d?.function?.name === 'web_search')
  const enumVals = def?.function?.parameters?.properties?.provider?.enum || []
  assert.ok(enumVals.includes('all'), `provider enum 应含 all：${JSON.stringify(enumVals)}`)
  assert.ok(enumVals.includes('searxng'), `provider enum 应含 searxng：${JSON.stringify(enumVals)}`)
  assert.match(def.function.description, /聚合/, 'description 应提到聚合模式')
})
check('搜索引擎下拉含「全部（聚合）」选项', () => {
  assert.match(dialog, /value="all"/, '缺 all 选项')
  assert.match(dialog, /@42BB9:全部（聚合）/, '缺聚合选项文案')
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