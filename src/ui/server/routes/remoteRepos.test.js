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
// src/ui/server/routes/remoteRepos.js 单元测试。
//
// 重点覆盖三处**实测踩过的坑**,它们都不会报错、只会静默给出错误结果:
//   1. `gitee auth status` 未登录时退出码是 0 —— 用退出码判会永远认为已登录
//   2. `parseRepoJson` 对纯对象(如 auth status 的 JSON)返回 null ——
//      拿它去解登录态会让解析悄悄退化成文本匹配,登录后拿不到用户名
//   3. 环境里带了"强制上色"变量(如 CLICOLOR_FORCE=1)时,CLI 的 --json 输出
//      会带 ANSI 色码 —— JSON 解不出来、账号名抠不出来,界面上只剩 `\x1b[1;37m[`
// 另外覆盖四条路由分支(未安装 / 未登录 / 已登录 / 拉取失败)与 provider 校验。
//
// 不真起 Express:沿用 branchStatus.test.js 的 mock app + mock req/res 做法。
// CLI 调用通过 registerRemoteReposRoutes 的 *Impl 注入口换成假实现,不联网、不装 gh。
// 唯独"色码"那几条必须真起子进程 —— 用 node 自己当被测 CLI(process.execPath),
// 不依赖机器上有没有装 gh。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCliEnv,
  firstMeaningfulLine,
  interpretGiteeAuthStatus,
  interpretGithubAuthStatus,
  normalizeGiteeRepos,
  normalizeGithubRepos,
  parseJsonLoose,
  parseRepoJson,
  pickUserName,
  registerRemoteReposRoutes,
  runCli,
  stripAnsi,
} from './remoteRepos.js'

const ESC = '\u001b'

/** 用 node 自己当"被测 CLI":跑一段内联脚本,把 stdout 收回来。 */
function runNode(code, options) {
  return runCli(process.execPath, ['-e', code], options)
}

/** 最小 express app mock:只实现 get + post 与 handler 调用 */
function makeApp() {
  const handlers = new Map()
  return {
    get(path, handler) { handlers.set(`GET ${path}`, handler) },
    post(path, handler) { handlers.set(`POST ${path}`, handler) },
    invoke(method, path, req = { query: {} }, res = makeRes()) {
      const key = `${method} ${path}`
      const handler = handlers.get(key)
      assert.ok(handler, `no handler for ${key}`)
      return handler(req, res, () => {})
    },
  }
}

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

/** 注册路由并把三个 CLI 依赖换成假实现 */
function setup({ resolved, detected, listed } = {}) {
  const app = makeApp()
  registerRemoteReposRoutes({
    app,
    resolveCliImpl: async () => (resolved === undefined ? { executable: 'gh', version: '2.101.0' } : resolved),
    detectCliImpl: async (provider, executable, version) => (
      detected === undefined ? { installed: true, version, authenticated: true, user: 'xz333221' } : detected
    ),
    listReposImpl: async () => (listed === undefined ? { repos: [], error: null } : listed),
    // 安全网:登录接口的默认实现会真去开一个终端窗口。走 setup() 的用例不该碰它,
    // 所以这里一律换成空实现 —— 万一哪天被调到,也只是静默通过,不会弹窗口。
    launchLoginImpl: async () => {},
  })
  return app
}

const get = (query) => ({ query })

// ── 纯解析函数 ──────────────────────────────────────────────────────────────

test('parseJsonLoose: 容忍 JSON 前面的警告/更新提示行', () => {
  assert.deepEqual(parseJsonLoose('[{"a":1}]'), [{ a: 1 }])
  assert.deepEqual(parseJsonLoose('A new version is available\n[{"a":2}]'), [{ a: 2 }])
  assert.deepEqual(parseJsonLoose('{"host":"gitee.com","status":"not logged in"}'), {
    host: 'gitee.com',
    status: 'not logged in',
  })
})

test('parseJsonLoose: 没有 JSON / 坏 JSON 一律返回 null(由调用方降级)', () => {
  assert.equal(parseJsonLoose('not logged in'), null)
  assert.equal(parseJsonLoose(''), null)
  assert.equal(parseJsonLoose(null), null)
  assert.equal(parseJsonLoose('[{broken'), null)
})

test('parseRepoJson: 裸数组 / 对象壳都能解出仓库数组', () => {
  assert.deepEqual(parseRepoJson('[{"name":"a"}]'), [{ name: 'a' }])
  assert.deepEqual(parseRepoJson('{"repos":[{"name":"b"}]}'), [{ name: 'b' }])
  assert.deepEqual(parseRepoJson('{"data":[{"name":"c"}]}'), [{ name: 'c' }])
})

test('parseRepoJson: 纯对象返回 null —— 别拿它解 auth status(否则登录态解析会静默退化)', () => {
  assert.equal(parseRepoJson('{"host":"gitee.com","status":"logged in"}'), null)
})

test('pickUserName: 字符串与对象两种形态都要认', () => {
  assert.equal(pickUserName('xz333221'), 'xz333221')
  assert.equal(pickUserName({ login: 'xuze333221' }), 'xuze333221')
  assert.equal(pickUserName({ name: '徐泽' }), '徐泽')
  assert.equal(pickUserName({}), null)
  assert.equal(pickUserName(''), null)
  assert.equal(pickUserName(null), null)
})

test('interpretGithubAuthStatus: gh 未登录时退出码 1,已登录时能从输出里抠出账号名', () => {
  assert.deepEqual(interpretGithubAuthStatus(1, 'You are not logged into any GitHub hosts.'), {
    authenticated: false,
    user: null,
  })
  assert.deepEqual(
    interpretGithubAuthStatus(0, 'github.com\n  ✓ Logged in to github.com account xz333221 (keyring)'),
    { authenticated: true, user: 'xz333221' },
  )
  // 退出码 0 但输出里没有 account 行:仍然算已登录,只是没有用户名
  assert.deepEqual(interpretGithubAuthStatus(0, 'logged in'), { authenticated: true, user: null })
})

test('interpretGiteeAuthStatus: 退出码不可信,只看 status 字段', () => {
  // 实测 v0.3.1:`gitee auth status` 未登录时退出码也是 0,所以这里只有文本输入
  assert.deepEqual(interpretGiteeAuthStatus('{"host":"gitee.com","status":"not logged in"}'), {
    authenticated: false,
    user: null,
  })
  assert.deepEqual(
    interpretGiteeAuthStatus('{"host":"gitee.com","status":"logged in","user":"xuze333221"}'),
    { authenticated: true, user: 'xuze333221' },
  )
  // user 是个对象时也要能取出名字
  assert.deepEqual(
    interpretGiteeAuthStatus('{"status":"logged in","user":{"login":"xuze333221"}}'),
    { authenticated: true, user: 'xuze333221' },
  )
})

test('interpretGiteeAuthStatus: 出现未知状态词时宁可判未登录,也不谎报已登录', () => {
  assert.deepEqual(interpretGiteeAuthStatus('{"status":"token expired"}'), {
    authenticated: false,
    user: null,
  })
})

test('interpretGiteeAuthStatus: JSON 解不出来返回 null,交给调用方走文本兜底', () => {
  assert.equal(interpretGiteeAuthStatus('not logged in'), null)
  assert.equal(interpretGiteeAuthStatus(''), null)
})

test('normalizeGithubRepos: primaryLanguage 是对象,取 .name;缺字段有默认值', () => {
  const [repo] = normalizeGithubRepos([{
    name: 'zen-gitsync',
    nameWithOwner: 'xz333221/zen-gitsync',
    description: 'Git GUI',
    isPrivate: false,
    isFork: false,
    primaryLanguage: { name: 'JavaScript' },
    stargazerCount: 1,
    updatedAt: '2026-09-22T00:00:00Z',
    url: 'https://github.com/xz333221/zen-gitsync',
  }])
  assert.equal(repo.language, 'JavaScript')
  assert.equal(repo.fullName, 'xz333221/zen-gitsync')
  assert.equal(repo.stars, 1)

  const [bare] = normalizeGithubRepos([{}])
  assert.equal(bare.language, null)
  assert.equal(bare.stars, 0)
  assert.equal(bare.isPrivate, false)
  assert.equal(bare.url, '')
})

test('normalizeGiteeRepos: private 缺失时用 public 反推;url 缺失时用 full_name 拼', () => {
  const [priv] = normalizeGiteeRepos([{ name: 'a', full_name: 'xz_web/a', public: false }])
  assert.equal(priv.isPrivate, true)

  const [pub] = normalizeGiteeRepos([{ name: 'b', full_name: 'xuze333221/b', public: true }])
  assert.equal(pub.isPrivate, false)
  assert.equal(pub.url, 'https://gitee.com/xuze333221/b')

  // 显式 private 优先于 public
  const [explicit] = normalizeGiteeRepos([{ name: 'c', private: true, public: true }])
  assert.equal(explicit.isPrivate, true)
})

// ── 排序 / 卡片元信息用到的字段 ──────────────────────────────────────────────
//
// 前端默认按 pushedAt 倒序排,卡片第三行显示"最近推送 / Fork / 默认分支 / 许可证"。
// 这些字段名两个平台各不相同,映射写错**不会报错** —— 只会静默变成 null,
// 表现成"卡片上少半行字"或"排序乱掉",所以逐个钉住。
test('normalizeGithubRepos: forkCount/defaultBranchRef/licenseInfo 映射到统一字段', () => {
  const [repo] = normalizeGithubRepos([{
    nameWithOwner: 'xz333221/zen-gitsync',
    forkCount: 4,
    defaultBranchRef: { name: 'develop' },
    licenseInfo: { key: 'mit', name: 'MIT License' },
    pushedAt: '2026-09-22T12:00:00Z',
    createdAt: '2024-11-25T08:11:38Z',
  }])
  assert.equal(repo.forks, 4)
  assert.equal(repo.defaultBranch, 'develop')
  assert.equal(repo.license, 'MIT License')
  assert.equal(repo.pushedAt, '2026-09-22T12:00:00Z')
  assert.equal(repo.createdAt, '2024-11-25T08:11:38Z')

  // 字段缺失时是 null / 0,不是 undefined —— 前端直接拿它做判断和比较
  const [bare] = normalizeGithubRepos([{}])
  assert.equal(bare.forks, 0)
  assert.equal(bare.defaultBranch, null)
  assert.equal(bare.license, null)
  assert.equal(bare.pushedAt, null)
})

test('normalizeGithubRepos: licenseInfo.key=other(有 LICENSE 但认不出)不算许可证', () => {
  // 实测:本仓库自己的 licenseInfo 就是 {key:'other', name:'Other'} ——
  // 卡片上显示一个 "Other" 徽标是纯噪音,当成没有处理。
  const [repo] = normalizeGithubRepos([{ nameWithOwner: 'a/b', licenseInfo: { key: 'other', name: 'Other' } }])
  assert.equal(repo.license, null)
})

test('normalizeGiteeRepos: 未设置许可证时 gitee 给空串,要归一成 null', () => {
  const [none] = normalizeGiteeRepos([{ full_name: 'flowdash/blog', license: '' }])
  assert.equal(none.license, null)
  assert.equal(none.forks, 0)
  assert.equal(none.defaultBranch, null)

  const [full] = normalizeGiteeRepos([{
    full_name: 'flowdash/article-generator',
    license: 'MIT',
    forks_count: 2,
    default_branch: 'develop',
    pushed_at: '2026-09-02T01:08:48+08:00',
    created_at: '2026-04-30T01:29:35+08:00',
  }])
  assert.equal(full.license, 'MIT')
  assert.equal(full.forks, 2)
  assert.equal(full.defaultBranch, 'develop')
  assert.equal(full.pushedAt, '2026-09-02T01:08:48+08:00')
  assert.equal(full.createdAt, '2026-04-30T01:29:35+08:00')
})

// ── 色码(ANSI)—— 强制上色的环境会把解析和提示一起搞坏 ───────────────────────
//
// 实测(2026-09-22):只要启动服务的那个终端里带着 CLICOLOR_FORCE=1,gh 就**不理**
// 我们传下去的 NO_COLOR=1,`gh repo list --json` 会吐**高亮 + 折行**的 JSON:
//     \x1b[1;37m[\x1b[m
//       \x1b[1;37m{\x1b[m
//         \x1b[1;34m"name"\x1b[m\x1b[1;37m:\x1b[m \x1b[32m"zen-gitsync"\x1b[m
// 于是:① repos 空(JSON.parse 失败)② user 为 null(账号名被色码包住)
// ③ 界面上的"错误原因"变成 `\x1b[1;37m[\x1b[m` 这种乱码。

test('stripAnsi: 剥掉 SGR 与光标类转义序列', () => {
  assert.equal(stripAnsi(`${ESC}[1;37m[${ESC}[m`), '[')
  assert.equal(stripAnsi('plain text'), 'plain text')
  assert.equal(stripAnsi(`${ESC}[2K${ESC}[1Aabc`), 'abc')
  assert.equal(stripAnsi(null), '')
})

test('buildCliEnv: 继承来的"强制上色"变量一律清掉,并显式关色(Windows 上大小写不敏感)', () => {
  process.env.CLICOLOR_FORCE = '1'
  process.env.gh_force_tty = '100%'
  process.env.FORCE_COLOR = '3'
  try {
    const env = buildCliEnv()
    assert.equal(env.CLICOLOR_FORCE, undefined)
    // 小写写法必须一起清 —— Windows 上环境变量名不区分大小写,
    // 只 delete 大写那种写法会漏掉它,而漏掉就等于没修。
    assert.equal(env.gh_force_tty, undefined)
    assert.equal(env.GH_FORCE_TTY, undefined)
    assert.equal(env.FORCE_COLOR, undefined)
    assert.equal(env.NO_COLOR, '1')
    assert.equal(env.CLICOLOR, '0')
    // 其它环境变量照旧带下去(子进程要能拿到 PATH 等)
    assert.equal(env.PATH, process.env.PATH)
  } finally {
    delete process.env.CLICOLOR_FORCE
    delete process.env.gh_force_tty
    delete process.env.FORCE_COLOR
  }
})

test('runCli: 父进程带着强制上色变量时,子进程既看不到它、输出里的色码也被剥掉', async () => {
  const code = 'process.stdout.write(String(process.env.CLICOLOR_FORCE) + "|" + String(process.env.NO_COLOR) + "|" + String(process.env.GH_FORCE_TTY))'
  process.env.CLICOLOR_FORCE = '1'
  process.env.GH_FORCE_TTY = '80'
  try {
    const res = await runNode(code)
    assert.equal(res.code, 0)
    assert.equal(res.stdout, 'undefined|1|undefined')
  } finally {
    delete process.env.CLICOLOR_FORCE
    delete process.env.GH_FORCE_TTY
  }

  // 色码在出口处统一剥掉(按 chunk 剥会把跨 chunk 的转义序列切坏,所以必须在收全后剥)
  const colored = await runNode(`process.stdout.write(${JSON.stringify(`${ESC}[1;37m[${ESC}[m\nabc\n`)})`)
  assert.equal(colored.stdout, '[\nabc\n')

  // 同样适用于 stderr —— 报错信息是要直接摆到界面上的
  const coloredErr = await runNode(`process.stderr.write(${JSON.stringify(`${ESC}[31mHTTP 401: Bad credentials${ESC}[m\n`)})`)
  assert.equal(coloredErr.stderr, 'HTTP 401: Bad credentials\n')
})

test('runCli + interpretGithubAuthStatus: 彩色 auth status 也能抠出账号名', async () => {
  // 没有这一层修复时,账号名被 \x1b[1;37m 包住 → 正则匹配不到 → user 为 null,
  // 界面显示"已登录 "后面空一格(users 看不到自己是谁)。
  const output = `github.com\n  ${ESC}[32m✓${ESC}[m Logged in to github.com account ${ESC}[1;37mxz333221${ESC}[m (keyring)\n`
  const res = await runNode(`process.stdout.write(${JSON.stringify(`${output}\n`)})`)
  assert.deepEqual(interpretGithubAuthStatus(res.code, res.stdout), {
    authenticated: true,
    user: 'xz333221',
  })
})

test('parseJsonLoose: 高亮过的多行 JSON 剥掉色码后照常解析(兜底,不依赖 runCli)', () => {
  const colored = [
    `${ESC}[1;37m[${ESC}[m`,
    `  ${ESC}[1;37m{${ESC}[m`,
    `    ${ESC}[1;34m"name"${ESC}[m${ESC}[1;37m:${ESC}[m ${ESC}[32m"zen-gitsync"${ESC}[m`,
    `  ${ESC}[1;37m}${ESC}[m`,
    `${ESC}[1;37m]${ESC}[m`,
  ].join('\n')
  assert.deepEqual(parseJsonLoose(colored), [{ name: 'zen-gitsync' }])
  assert.deepEqual(parseRepoJson(colored), [{ name: 'zen-gitsync' }])
})

test('firstMeaningfulLine: 剥掉色码后只剩标点的行不算"能给用户看的话"', () => {
  // 用户看到的那行乱码正是这一条:整段输出剥完色码只剩 [,拿它当错误提示等于没说
  assert.equal(firstMeaningfulLine('', `${ESC}[1;37m[${ESC}[m`), '')
  assert.equal(
    firstMeaningfulLine(`${ESC}[1;37m[${ESC}[m`, 'HTTP 401: Bad credentials (https://api.github.com/graphql)'),
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
  )
  assert.equal(firstMeaningfulLine(''), '')
})

// ── 路由分支 ────────────────────────────────────────────────────────────────

test('GET /api/remote-repos: provider 非法 → 400', async () => {
  const app = setup()
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'gitlab' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.success, false)
  assert.match(res.body.error, /github 或 gitee/)
})

test('GET /api/remote-repos: 未安装 CLI → installed:false,仍然带上安装命令', async () => {
  const app = setup({ resolved: null })
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'github' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.installed, false)
  assert.deepEqual(res.body.repos, [])
  // 安装引导要能拿到命令,否则前端没法"提供一键安装的命令"
  assert.ok(res.body.installer, '应该带上安装方式')
  assert.ok(res.body.installer.command, '应该带上安装命令')
  assert.equal(res.body.loginCommand, 'gh auth login')
})

test('GET /api/remote-repos: 已安装未登录 → authenticated:false 且不拉仓库', async () => {
  let listCalled = false
  const app = makeApp()
  registerRemoteReposRoutes({
    app,
    resolveCliImpl: async () => ({ executable: 'gitee', version: '0.3.1' }),
    detectCliImpl: async (provider, executable, version) => ({
      installed: true, version, authenticated: false, user: null,
    }),
    listReposImpl: async () => {
      listCalled = true
      return { repos: [], error: null }
    },
  })
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'gitee' }), res)

  assert.equal(res.body.installed, true)
  assert.equal(res.body.authenticated, false)
  assert.equal(res.body.version, '0.3.1')
  assert.deepEqual(res.body.repos, [])
  assert.equal(listCalled, false, '没登录就不该去拉仓库列表')
  assert.equal(res.body.loginCommand, 'gitee auth login')
})

test('GET /api/remote-repos: 已登录 → 返回仓库列表与账号名', async () => {
  const app = setup({
    detected: { installed: true, version: '2.101.0', authenticated: true, user: 'xz333221' },
    listed: {
      repos: [{
        name: 'zen-gitsync',
        fullName: 'xz333221/zen-gitsync',
        description: '',
        isPrivate: false,
        isFork: false,
        language: 'JavaScript',
        stars: 1,
        updatedAt: '2026-09-22T00:00:00Z',
        url: 'https://github.com/xz333221/zen-gitsync',
      }],
      error: null,
    },
  })
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'github' }), res)

  assert.equal(res.body.authenticated, true)
  assert.equal(res.body.user, 'xz333221')
  assert.equal(res.body.repos.length, 1)
  assert.equal(res.body.repos[0].fullName, 'xz333221/zen-gitsync')
  assert.equal(res.body.error, null)
})

test('GET /api/remote-repos: 拉取失败 → 200 + error 说明(不是 500 弹窗,前端就地展示)', async () => {
  const app = setup({
    detected: { installed: true, version: '2.101.0', authenticated: true, user: 'xz333221' },
    listed: { repos: [], error: 'gh repo list 超时(25 秒),请检查网络或代理设置' },
  })
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'github' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.match(res.body.error, /超时/)
  assert.deepEqual(res.body.repos, [])
})

test('GET /api/remote-repos: provider 大小写不敏感', async () => {
  const app = setup()
  const res = makeRes()
  await app.invoke('GET', '/api/remote-repos', get({ provider: 'GitHub' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.provider, 'github')
})

// ── POST /api/remote-repos/login(一键登录:只负责开终端窗口)──────────────────

/** 平台无关的"绝对路径"假数据:测试要能跨平台跑,不能写死 Windows 路径 */
const EXE_DIR = process.platform === 'win32' ? 'C:\\Program Files\\GitHub CLI' : '/usr/local/bin'
const EXE_PATH = process.platform === 'win32' ? `${EXE_DIR}\\gh.exe` : `${EXE_DIR}/gh`

/**
 * 登录接口的测试架子。
 * resolveCli 也要注入:路由会真的去解析 CLI(为了拿它所在目录),
 * 不注入的话用例就依赖"本机装没装 gh"了,换台机器就红。
 * launchLoginImpl 的默认实现会**真开一个终端窗口**,必须换成假的。
 */
function setupLogin({ resolved } = {}) {
  const launched = []
  const app = makeApp()
  registerRemoteReposRoutes({
    app,
    resolveCliImpl: async () => (
      resolved === undefined ? { executable: EXE_PATH, version: '2.101.0' } : resolved
    ),
    launchLoginImpl: async (command, options) => { launched.push({ command, options }) },
  })
  return { app, launched }
}

test('POST /api/remote-repos/login: 在新终端里跑该平台的登录命令', async () => {
  const { app, launched } = setupLogin()
  const res = makeRes()
  await app.invoke('POST', '/api/remote-repos/login', { body: { provider: 'github' } }, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(launched.length, 1)
  // gh auth login 是交互式的,服务端只把窗口开起来,后面的问答交给 CLI 自己
  assert.equal(launched[0].command, 'gh auth login')
})

test('POST /api/remote-repos/login: 把 CLI 所在目录前置给子进程(否则刚装好的 CLI 会"不是内部或外部命令")', async () => {
  // 回归 2026-09-22:服务端进程的 PATH 是启动那一刻的快照,用户刚装好的 CLI
  // 不在里面。探测能找到它(走注册表),子进程 cmd 按自己的 PATH 却找不到 ——
  // 所以必须把 CLI 目录一起带下去。这条断言就是这次修复的锚点。
  const { app, launched } = setupLogin()
  await app.invoke('POST', '/api/remote-repos/login', { body: { provider: 'github' } }, makeRes())

  assert.deepEqual(launched[0].options.pathDirs, [EXE_DIR])
})

test('POST /api/remote-repos/login: 没检测到 CLI → 400 且不开窗口(报错比一个空窗口好懂)', async () => {
  const { app, launched } = setupLogin({ resolved: null })
  const res = makeRes()
  await app.invoke('POST', '/api/remote-repos/login', { body: { provider: 'github' } }, res)

  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /未检测到 gh/)
  assert.deepEqual(launched, [])
})

test('POST /api/remote-repos/login: gitee 用自己的登录命令(provider 大小写不敏感)', async () => {
  const { app, launched } = setupLogin()
  await app.invoke('POST', '/api/remote-repos/login', { body: { provider: 'Gitee' } }, makeRes())
  assert.deepEqual(launched.map((l) => l.command), ['gitee auth login'])
})

test('POST /api/remote-repos/login: provider 非法或缺失 → 400 且绝不启动命令', async () => {
  const { app, launched } = setupLogin()

  const res = makeRes()
  await app.invoke('POST', '/api/remote-repos/login', { body: { provider: 'gitlab' } }, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.body.error, /github 或 gitee/)

  // 整个 body 缺失(前端忘传 / 直接 POST 空请求)也要挡住
  const res2 = makeRes()
  await app.invoke('POST', '/api/remote-repos/login', {}, res2)
  assert.equal(res2.statusCode, 400)

  assert.deepEqual(launched, [], '参数不合法时绝不能开窗口')
})

test('POST /api/remote-repos/login: 命令只来自服务端白名单,请求体里塞的 command 一律忽略', async () => {
  // 这条断言就是接口的安全边界本身:命令若能随请求体进来,
  // 等于给这个接口开了一个任意命令执行的口子。
  const { app, launched } = setupLogin()

  await app.invoke('POST', '/api/remote-repos/login', {
    body: { provider: 'github', command: 'whoami', loginCommand: 'whoami' },
  }, makeRes())

  assert.deepEqual(launched.map((l) => l.command), ['gh auth login'])
})
