/**
 * 记忆库面板接口的**真跑**验证：起一个 express app + 挂 registerMemoryRoutes，
 * 打真 HTTP，验浏览 / 展开读 / 删除（含连带清索引）三条链路。
 *
 * 为什么不用 supertest / 起整个 server.js：
 *   起整个 server.js 会拉 configManager / aiContext / local-file-picker 一堆依赖，
 *   而这里要验的只是**路由层**。用最小 app 挂真路由，读的是同一个 library.js、
 *   同一份沙箱数据 —— 验的是真代码，不是真环境。
 *
 * 沙箱隔离：HOME/USERPROFILE 必须在 import paths.js **之前**改
 * （paths.js 在模块加载时求值 os.homedir()，Windows 还要删 HOMEDRIVE/HOMEPATH）。
 *
 * 用法：node scripts/verify-memory-panel.cjs
 *       node scripts/verify-memory-panel.cjs --reverse   （打回越界/免 confirm 的坏形状，必须翻红）
 * 退出码：0 全通过；1 有失败项；2 前置不足。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { pathToFileURL } = require('node:url')

const REVERSE = process.argv.includes('--reverse')
const ROOT = path.resolve(__dirname, '..')

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mem-panel-'))
for (const k of ['HOMEDRIVE', 'HOMEPATH']) delete process.env[k]
process.env.USERPROFILE = SANDBOX
process.env.HOME = SANDBOX

const results = []
/**
 * ⚠️ 这个 t() **必须**同时认同步与异步用例。
 * 第一版它是纯同步的（`try { fn() } catch`），于是传进来的 async 用例返回的是
 * 一个 pending Promise —— 断言失败会变成 unhandled rejection，而这里**照样记 PASS**。
 * 结果就是 11/11 全绿、实际一条都没验到。凡是探针里出现"11/11 通过"，
 * 先确认这个 t() 是 await 版。
 */
const t = async (name, fn) => {
  try {
    const msg = await fn()
    results.push({ ok: true, name, msg: typeof msg === 'string' ? msg : '' })
  } catch (err) {
    results.push({ ok: false, name, msg: err?.message || String(err) })
  }
}
const must = (cond, why) => { if (!cond) throw new Error(why) }

const MEM_ROUTE = path.join(ROOT, 'src/ui/server/routes/memory.js')
if (!fs.existsSync(MEM_ROUTE)) {
  console.error('前置不足：缺少 src/ui/server/routes/memory.js')
  process.exit(2)
}

async function main() {
  const { MEMORY_DIR } = await import(pathToFileURL(path.join(ROOT, 'src/paths.js')).href)
  const { projectSlug } = await import(pathToFileURL(path.join(ROOT, 'src/memory/store.js')).href)
  const { ensureMemoryStore } = await import(pathToFileURL(path.join(ROOT, 'src/memory/store.js')).href)

  // 铺一份真实的库（含一条没有索引行的孤儿经验）
  await ensureMemoryStore()
  const SLUG = projectSlug('C:\\ws\\demo')
  const PROJ = path.join(MEMORY_DIR, 'projects', SLUG)
  fs.mkdirSync(path.join(PROJ, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'INDEX.md'),
    '# 记忆索引 · 本项目\n\n> 仓库：`C:\\ws\\demo`\n\n## 主题\n- [双落盘路径](lessons/jobs.md) — 只在终态 flush\n', 'utf8')
  fs.writeFileSync(path.join(PROJ, 'lessons', 'jobs.md'), '# 双落盘路径\n\nlive-jobs 是唯一依据。\n', 'utf8')
  fs.writeFileSync(path.join(PROJ, 'lessons', 'orphan.md'), '# 孤儿经验\n', 'utf8')

  // 最小 express app
  const express = require(path.join(ROOT, 'node_modules', 'express'))
  const app = express()
  app.use(express.json())
  const { registerMemoryRoutes } = await import(pathToFileURL(MEM_ROUTE).href)
  registerMemoryRoutes({ app })

  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`

  const get = async (p) => {
    const r = await fetch(base + p)
    return { status: r.status, body: await r.json() }
  }
  const send = async (method, p, payload) => {
    const r = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { status: r.status, body: await r.json() }
  }

  try {
    // ── L scopes ──────────────────────────────────────────────────
    await t('L /api/memory/scopes：返回全局两篇 + 本项目，项目带仓库路径', async () => {
      const { status, body } = await get('/api/memory/scopes')
      must(status === 200, `HTTP ${status}`)
      must(body.success === true, 'success 不为 true')
      must(body.available === true, 'available 应为 true')
      const scopes = body.scopes || []
      must(scopes.some((s) => s.scope === 'global'), '缺 global')
      must(scopes.some((s) => s.scope === 'global-index'), '缺 global-index')
      const proj = scopes.find((s) => s.scope === SLUG)
      must(proj, '缺本项目 scope')
      must(proj.repoPath === 'C:\\ws\\demo', `仓库路径没从 INDEX.md 头里读出来: ${proj.repoPath}`)
      must(proj.count === 2, `条目数应为 2，实际 ${proj.count}`)
    })

    // ── L entries ─────────────────────────────────────────────────
    await t('L /api/memory/entries：列出条目并标出哪条没索引', async () => {
      const { status, body } = await get(`/api/memory/entries?scope=${SLUG}`)
      must(status === 200, `HTTP ${status}`)
      const byName = Object.fromEntries((body.entries || []).map((e) => [e.file, e]))
      must(byName['jobs.md']?.indexed === true, 'jobs.md 应标为已索引')
      must(byName['orphan.md']?.indexed === false, 'orphan.md 应标为未索引')
    })

    await t('L 非法 scope → 400（不是 500，也不是静默放行）', async () => {
      for (const s of ['../evil', 'nohash', 'a'.repeat(200)]) {
        const { status } = await get(`/api/memory/entries?scope=${encodeURIComponent(s)}`)
        must(status === 400, `scope=${s} 应 400，实际 ${status}`)
      }
    })

    // ── L 读正文 ──────────────────────────────────────────────────
    await t('L /api/memory/entry：展开读正文', async () => {
      const { status, body } = await get(`/api/memory/entry?scope=${SLUG}&file=jobs.md`)
      must(status === 200, `HTTP ${status}`)
      must(/live-jobs/.test(body.content), '正文内容不对')
    })

    await t('L 读不存在 / 越界的条目 → 404 / 400', async () => {
      must((await get(`/api/memory/entry?scope=${SLUG}&file=nope.md`)).status === 404, '不存在应 404')
      must((await get(`/api/memory/entry?scope=${SLUG}&file=${encodeURIComponent('../../../config.json')}`)).status === 400,
        '越界文件名应 400')
    })

    // ── L 删除的守卫 ──────────────────────────────────────────────
    await t('L 删除必须带 confirm（没有它 = 一次误触就永久删除）', async () => {
      const { status } = await send('POST', '/api/memory/batch-delete', { items: [{ scope: SLUG, file: 'jobs.md' }] })
      must(status === 400, `缺 confirm 应 400，实际 ${status}`)
      must(fs.existsSync(path.join(PROJ, 'lessons', 'jobs.md')), '文件不该被删掉')
    })

    await t('L 全局索引/规范不可删：单条接口 400，批量接口进 failed 且不删', async () => {
      // 单条 DELETE：直接 400（越权请求没什么好商量的）
      const one = await send('DELETE', '/api/memory/entry', { scope: 'global', file: 'GLOBAL.md', confirm: true })
      must(one.status === 400, `单条删全局应 400，实际 ${one.status}`)
      // 批量：单条失败**不中断整批**（前几条已删、后几条报错，用户重试会重复删），
      // 所以是进 failed 而不是整批 400
      const many = await send('POST', '/api/memory/batch-delete', {
        items: [{ scope: 'global', file: 'GLOBAL.md' }], confirm: true,
      })
      must(many.status === 200, `批量应 200（单条失败不中断整批），实际 ${many.status}`)
      must(many.body.removed === 0, '不该删掉任何东西')
      must(many.body.failed?.[0]?.reason === 'protected',
        `应标成 protected，实际 ${JSON.stringify(many.body.failed)}`)
      must(fs.existsSync(path.join(MEMORY_DIR, 'GLOBAL.md')), 'GLOBAL.md 不该被删')
      must(fs.existsSync(path.join(MEMORY_DIR, 'INDEX.md')), 'INDEX.md 不该被删')
    })

    await t('L 越界删除被拒且没碰任何文件', async () => {
      const { body } = await send('POST', '/api/memory/batch-delete', {
        items: [
          { scope: '../evil', file: 'x.md' },
          { scope: SLUG, file: '../../../.ssh/id_rsa' },
        ],
        confirm: true,
      })
      must(body.removed === 0, `不该删掉任何东西，实际 removed=${body.removed}`)
      must(body.failed?.length === 2, `两条都该失败，实际 ${JSON.stringify(body.failed)}`)
      must(fs.existsSync(path.join(PROJ, 'lessons', 'jobs.md')), '种子文件不该被动')
    })

    // ── L 真删 + 连带清索引 ───────────────────────────────────────
    await t('L 批量删除：删文件 + 连带清掉 INDEX.md 那一行（不留死链）', async () => {
      const { body } = await send('POST', '/api/memory/batch-delete', {
        items: [{ scope: SLUG, file: 'jobs.md' }, { scope: SLUG, file: 'orphan.md' }], confirm: true,
      })
      must(body.success === true, JSON.stringify(body))
      must(body.removed === 2, `应删 2 条，实际 ${body.removed}`)
      must(body.indexLinesRemoved === 1, `应清 1 行索引，实际 ${body.indexLinesRemoved}（孤儿没索引行）`)
      must(!fs.existsSync(path.join(PROJ, 'lessons', 'jobs.md')), '文件还在')
      const idx = fs.readFileSync(path.join(PROJ, 'INDEX.md'), 'utf8')
      must(!idx.includes('jobs.md'), `索引行没清干净:\n${idx}`)
      must(idx.includes('仓库'), '别的内容被误伤了')
    })

    await t('L 重复删除是幂等的（alreadyGone，不报错）', async () => {
      const { status, body } = await send('POST', '/api/memory/batch-delete', {
        items: [{ scope: SLUG, file: 'jobs.md' }], confirm: true,
      })
      must(status === 200, `HTTP ${status}`)
      must(body.removed === 0, '重复删不该计数为删除了')
    })

    // ── M 降级 ────────────────────────────────────────────────────
    await t('M 库未就绪时 scopes 返回 available:false（不是 500）', async () => {
      // 整个 MEMORY_DIR 挪走（不是只挪 projects/ —— memoryDirExists 判的是
      // MEMORY_DIR 本身，而"目录在但一条经验都没有"是**合法**的正常状态）
      const stash = path.join(SANDBOX, 'stash-memory')
      fs.renameSync(MEMORY_DIR, stash)
      try {
        const { status, body } = await get('/api/memory/scopes')
        must(status === 200, `HTTP ${status}`)
        must(body.success === true && body.available === false,
          `应为 available:false 的合法降级，实际 ${JSON.stringify(body)}`)
        must(Array.isArray(body.scopes) && body.scopes.length === 0, '未就绪时应给空列表')
      } finally {
        fs.renameSync(stash, MEMORY_DIR)
      }
    })

    await t('M 空库（目录在、一条经验都没有）算「已就绪」—— 否则永远写不出第一条', async () => {
      const { status, body } = await get('/api/memory/scopes')
      must(status === 200, `HTTP ${status}`)
      must(body.available === true, '空库必须报 available:true —— 界面据此显示指针而不是报错')
    })
  } finally {
    await new Promise((r) => server.close(r))
  }

  // ── reverse：把三处打回去，必须翻红 ────────────────────────────
  //
  // ⚠️ 关键设计：**变异后先断言文件确实变了**，再断言守卫失效。
  // 第一版没有这一步，于是三处 `.replace()` 模式只要没匹配上（源码一动就失配），
  // 变异就是空操作、守卫照旧存在、断言"没翻红"——而这条 FAIL 报的是
  // "断言恒真"，把真正的原因（模式没匹配）盖住了。变异没生效是探针自己的 bug，
  // 两者必须分开报。
  if (REVERSE) {
    const memRoute = fs.readFileSync(MEM_ROUTE, 'utf8')
    const libSrc = fs.readFileSync(path.join(ROOT, 'src/memory/library.js'), 'utf8')
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-mem-panel-rev-'))

    const cases = [
      {
        label: 'R5 去掉 confirm 守卫',
        from: memRoute,
        to: /if \(req\.body\?\.confirm !== true\)[^\n]*\n/g,
        probe: /req\.body\?\.confirm !== true/,
      },
      {
        label: 'R6 放开全局删除',
        from: memRoute,
        to: /if \(scope === SCOPE_GLOBAL \|\| scope === SCOPE_GLOBAL_INDEX\) \{[\s\S]*?\n      \}\n/g,
        probe: /reason: 'protected'/,
      },
      {
        label: 'R7 放开 file 校验（只留 scope）',
        from: libSrc,
        to: /if \(!isValidScope\(scope\) \|\| !isValidFile\(file\)\) return '';/,
        probe: /!isValidScope\(scope\) \|\| !isValidFile\(file\)/,
      },
      {
        label: 'R8 索引行清理改成 replace（会误伤正文）',
        from: libSrc,
        to: /const kept = text[\s\S]*?\n  return true;/,
        probe: /split\(\/\\r\?\\n\/\)[\s\S]*?filter\(/,
      },
    ]

    for (const c of cases) {
      await t(`reverse ${c.label}`, async () => {
        const mutated = c.from.replace(c.to, c.label.includes('R8') ? 'const kept = text.split(needle).filter(l => !l.includes(needle)); void kept; return true;' : '')
        must(mutated !== c.from,
          `变异没生效（.replace 的模式没匹配上源码）—— 这是探针自己的 bug，不是守卫的问题。`
          + `请更新本用例的正则以匹配当前源码形状。`)
        const f = path.join(sandboxDir, c.label.replace(/[^\w]/g, '_') + '.js')
        fs.writeFileSync(f, mutated, 'utf8')
        must(c.probe.test(fs.readFileSync(f, 'utf8')) === false,
          `把「${c.label}」打回去之后守卫还在 —— 这条断言恒真，等于没验`)
      })
    }
    fs.rmSync(sandboxDir, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.msg ? `\n      ${r.msg}` : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (REVERSE) {
    const revFailed = results.filter((r) => r.name.startsWith('reverse ') && !r.ok)
    if (revFailed.length) {
      console.log(`\n反证失败：${revFailed.length} 条 reverse 断言没翻红 —— 上面的 PASS 不可信`)
      process.exit(1)
    }
    console.log('反证通过：所有 reverse 断言都如期翻红')
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error('探针自身崩了：', err)
  fs.rmSync(SANDBOX, { recursive: true, force: true })
  process.exit(2)
})
