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
// 「最近项目 / 常用目录」AI 状态解读的回归测试。
//
// 覆盖三件事:
//   1. normalizeItems —— 前端传来的状态是**不可信输入**,数字要钳成非负整数、
//      路径要截断、多出来的字段要丢掉;isGitRepo 的三态(true/false/null)不能塌成两态
//      (塌了会把"没探到"写成"不是 Git 仓库")。
//   2. buildPrompt —— 每个目录都进 prompt、优先级措辞在、中英各一套。
//   3. 路由的两个**不发网络请求就能测**的出口:白名单外一律忽略(NO_ITEMS)、
//      没配模型直接 NO_MODEL。这两条是安全/成本边界,不能被改坏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, normalizeItems, buildDirStatusBlock, filterToRecentDirs, registerRecentDirectoriesSummaryRoutes } from './recentDirectoriesAiSummary.js'

const dirty = (overrides = {}) => ({
  isGitRepo: true,
  branch: 'main',
  upstream: 'origin/main',
  changed: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  ...overrides,
})

// ── normalizeItems ────────────────────────────────────────────────────────

test('normalizeItems: 只保留认识的字段,计数钳成非负整数', () => {
  const [item] = normalizeItems([{
    path: '  C:\\ws\\demo  ',
    exists: true,
    evil: 'drop me',
    git: { ...dirty(), changed: -3, staged: 'NaN', unstaged: 2.9, untracked: Infinity },
  }])

  assert.equal(item.path, 'C:\\ws\\demo')          // 去空白
  assert.equal('evil' in item, false)               // 不认识的字段不进 prompt
  assert.deepEqual(
    { c: item.git.changed, s: item.git.staged, u: item.git.unstaged, t: item.git.untracked },
    { c: 0, s: 0, u: 2, t: 0 }                      // 负数 / NaN / Infinity 一律归零
  )
  assert.equal(Object.keys(item.git).sort().join(','), 'ahead,behind,branch,changed,isGitRepo,staged,unstaged,untracked,upstream')
})

test('normalizeItems: isGitRepo 三态保持,不知道就是不知道', () => {
  const [repo, notRepo, unknown] = normalizeItems([
    { path: 'a', git: dirty() },
    { path: 'b', git: { isGitRepo: false } },
    { path: 'c', git: { isGitRepo: null } },
  ])
  assert.equal(repo.git.isGitRepo, true)
  assert.equal(notRepo.git.isGitRepo, false)
  assert.equal(unknown.git.isGitRepo, null)         // 不能塌成 false
})

test('normalizeItems: 丢掉空条目、非对象、空路径,并截断超长字段', () => {
  const items = normalizeItems([
    null,
    'nope',
    { path: '   ' },
    { path: 'ok', git: null },
    { path: 'x'.repeat(900), git: { isGitRepo: true, branch: 'b'.repeat(500) } },
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].path, 'ok')
  assert.equal(items[0].git, null)                  // 没探到状态 = 没有 git 字段
  assert.equal(items[1].path.length, 512)
  assert.equal(items[1].git.branch.length, 200)
  assert.equal(items[1].git.upstream, null)         // 非字符串的引用名退成 null
})

test('normalizeItems: 非数组入参退化成空数组', () => {
  assert.deepEqual(normalizeItems(undefined), [])
  assert.deepEqual(normalizeItems({ path: 'a' }), [])
})

// ── buildPrompt ───────────────────────────────────────────────────────────

test('buildPrompt: 每个目录都进 prompt,并带上优先级要求(中文)', () => {
  const prompt = buildPrompt([
    { path: 'C:\\ws\\zen-gitsync', exists: true, git: dirty({ behind: 3, changed: 2, staged: 1, unstaged: 1 }) },
    { path: 'C:\\ws\\plain', exists: true, git: { isGitRepo: false } },
    { path: 'C:\\ws\\gone', exists: false, git: null },
  ], 'zh')

  assert.match(prompt, /zen-gitsync \(C:\\ws\\zen-gitsync\)/)
  assert.match(prompt, /落后 origin\/main 3 个提交\(需要 pull\)/)
  assert.match(prompt, /未提交改动 2 项\(已暂存 1 \/ 未暂存 1 \/ 未跟踪 0\)/)
  assert.match(prompt, /plain \(C:\\ws\\plain\) —— 不是 Git 仓库/)
  assert.match(prompt, /gone \(C:\\ws\\gone\) —— 目录不存在/)
  assert.match(prompt, /共 3 个目录/)
  assert.match(prompt, /不超过 150 字/)
})

test('buildPrompt: 领先 / 没有上游 / 工作区干净各自的措辞', () => {
  const prompt = buildPrompt([
    { path: '/ws/ahead', exists: true, git: dirty({ ahead: 2, behind: 0 }) },
    { path: '/ws/no-upstream', exists: true, git: dirty({ upstream: null }) },
    { path: '/ws/clean', exists: true, git: dirty() },
  ], 'zh')

  assert.match(prompt, /领先 origin\/main 2 个提交\(有未推送的提交\)/)
  assert.match(prompt, /没有配置上游分支/)
  assert.match(prompt, /工作区干净/)
})

test('buildPrompt: locale=en 走英文模板', () => {
  const prompt = buildPrompt([
    { path: '/ws/a', exists: true, git: dirty({ behind: 1 }) },
  ], 'en')

  assert.match(prompt, /- a \(\/ws\/a\) —— branch main, behind origin\/main by 1 commit\(s\) \(needs pull\)/)
  assert.match(prompt, /1 directories in total/)
  assert.doesNotMatch(prompt, /请写/)                // 不该混进中文模板
})

// ── buildDirStatusBlock / filterToRecentDirs ──────────────────────────────
// 这两个是「切换工作目录」弹窗里 g ai 追问的上下文来源(注入请求副本,不落库)。

test('buildDirStatusBlock: 是事实陈述,不带「写一段解读」那类输出要求', () => {
  const block = buildDirStatusBlock([
    { path: 'C:\\ws\\zen-gitsync', exists: true, git: dirty({ behind: 3 }) },
    { path: 'C:\\ws\\plain', exists: true, git: { isGitRepo: false } },
  ], 'zh')

  assert.match(block, /zen-gitsync \(C:\\ws\\zen-gitsync\)/)
  assert.match(block, /落后 origin\/main 3 个提交\(需要 pull\)/)
  assert.match(block, /plain \(C:\\ws\\plain\) —— 不是 Git 仓库/)
  assert.match(block, /共 2 个目录/)
  assert.match(block, /不可信数据/)                  // 目录名/分支名会进 prompt,必须声明不可信
  assert.doesNotMatch(block, /不超过 150 字/)         // 没有输出要求:这是给人问话用的事实
})

test('buildDirStatusBlock: 带上界面上那段解读原文,追问才知道"第二个"指谁', () => {
  const block = buildDirStatusBlock(
    [{ path: '/ws/a', exists: true, git: dirty({ behind: 1 }) }],
    'zh',
    '  这 1 个目录里有 1 个需要处理。\n'
  )
  assert.match(block, /用户此刻在界面上看到的自动解读如下/)
  assert.match(block, /这 1 个目录里有 1 个需要处理。/)
})

test('buildDirStatusBlock: 没有解读原文 / locale=en 时不拼那一段', () => {
  const plain = buildDirStatusBlock([{ path: '/ws/a', exists: true, git: dirty() }], 'zh')
  assert.doesNotMatch(plain, /自动解读如下/)

  const en = buildDirStatusBlock(
    [{ path: '/ws/a', exists: true, git: dirty() }],
    'en',
    'one directory needs attention'
  )
  assert.match(en, /1 directories in total/)
  assert.match(en, /Here is the automatic summary the user is looking at/)
  assert.doesNotMatch(en, /共 /)                     // 不该混进中文模板
})

test('filterToRecentDirs: 只放行白名单内的目录,大小写 / 分隔符等价', () => {
  const items = [
    { path: 'C:\\WS\\a', exists: true, git: null },
    { path: 'C:/ws/b', exists: true, git: null },
    { path: 'C:\\evil', exists: true, git: null },
  ]
  // Windows 下两者都归一化成同一条;POSIX 下大小写敏感 —— 用平台中立的例子断言
  const kept = filterToRecentDirs(items, ['C:/ws/b'])
  assert.deepEqual(kept.map(i => i.path), ['C:/ws/b'])
})

test('filterToRecentDirs: 白名单为空(读配置失败)时一个都不放行', () => {
  const items = [{ path: '/ws/a', exists: true, git: null }]
  assert.deepEqual(filterToRecentDirs(items, []), [])
  assert.deepEqual(filterToRecentDirs(items, null), [])
})

// ── 路由:两条不需要网络的出口 ─────────────────────────────────────────────

function createFakeApp() {
  const routes = new Map()
  return {
    routes,
    post(pathname, _middleware, handler) {
      routes.set(pathname, handler)
    },
  }
}

function createFakeRes() {
  const chunks = []
  return {
    headers: {},
    ended: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    flushHeaders() {},
    write(chunk) { chunks.push(chunk); return true },
    end() { this.ended = true },
    events() {
      return chunks.join('')
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => JSON.parse(line.slice(5).trim()))
    },
  }
}

async function runRoute({ recentDirs, models, items }) {
  const app = createFakeApp()
  registerRecentDirectoriesSummaryRoutes({
    app,
    configManager: {
      getRecentDirectories: async () => recentDirs,
      readRawConfigFile: async () => ({ models }),
    },
  })
  const res = createFakeRes()
  await app.routes.get('/api/recent_directories/summary')({ body: { items, locale: 'zh' }, socket: null }, res)
  return res.events()
}

test('路由: 白名单外的路径一律不解读(NO_ITEMS)', async () => {
  const events = await runRoute({
    recentDirs: ['C:\\ws\\zen-gitsync'],
    models: [{ model: 'fixture', baseURL: 'http://127.0.0.1:9', isDefault: true }],
    items: [{ path: 'C:\\Windows\\System32', exists: true, git: dirty() }],
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'error')
  assert.equal(events[0].code, 'NO_ITEMS')          // 任意路径解读 = 不能开的口子
})

test('路由: 没有配置模型时直接 NO_MODEL,不读最近目录也不联网', async () => {
  let listed = false
  const app = createFakeApp()
  registerRecentDirectoriesSummaryRoutes({
    app,
    configManager: {
      getRecentDirectories: async () => { listed = true; return ['C:\\ws\\a'] },
      readRawConfigFile: async () => ({ models: [] }),
    },
  })
  const res = createFakeRes()
  await app.routes.get('/api/recent_directories/summary')(
    { body: { items: [{ path: 'C:\\ws\\a', exists: true, git: dirty() }] }, socket: null },
    res
  )

  const events = res.events()
  assert.equal(listed, true)
  assert.equal(events.at(-1).code, 'NO_MODEL')
  assert.equal(res.ended, true)
})
