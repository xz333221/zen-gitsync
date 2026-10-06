#!/usr/bin/env node
/**
 * 顶栏「Git 操作」+「命令历史」两个入口的**可见性**契约（2026-10-06）。
 *
 * 起因：用户在非 Git 仓库目录（c:\users\xuze）截图，红框圈出顶栏最右边这两颗
 * 按钮 —— 「不是 git 仓库的就不用设置这两个按钮了」。命令历史里只有 git 命令
 * 有意义，Git 操作抽屉在非仓库里打开也无事可做，留着只是噪音。
 *
 * 三条契约：
 *   H1 非 Git 目录：这两颗按钮**都不在**顶栏（量真实 DOM，不是看源码串）
 *   H2 非 Git 目录：顶栏本身还在（品牌 / 监控 / 用户区都在）
 *        —— 防"整页没渲染出来"造成的假绿（H1 那种 `count == 0` 断言最容易被白屏骗）
 *   H3 Git 目录：两颗都在 —— 防"一律隐藏"式的假修
 *
 * 非 Git 目录怎么造：`page.route` 把 `/api/current_directory` 改成返回 isGitRepo:false。
 *   该接口是 `gitStore.isGitRepo` 的**唯一**数据源（App.vue 初始化 + gitStore.checkGitRepo）。
 *   不真调 `/api/change_directory` 切后端工作目录：本仓库是共享工作区，
 *   切目录会把别的会话 / 用户界面上的当前项目一起换掉。
 *
 * 用法：
 *   node scripts/verify-header-git-buttons.cjs
 *   node scripts/verify-header-git-buttons.cjs --reverse   # 反证：撤掉 v-if 后 H1 应变红
 *
 * 依赖：src/ui/client/node_modules/playwright + 5544 上的 dev server。
 * 没有 dev server / 没装 playwright 时**不算失败**，只 NOTE（与仓库其余探针同口径）。
 */

const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const VITE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const PW = path.join(ROOT, 'src/ui/client/node_modules/playwright')
const REVERSE = process.argv.includes('--reverse')

const APP = path.join(ROOT, 'src/ui/client/src/App.vue')

// 反证时要撤掉的那一处（必须与 App.vue 里的字符串逐字一致）
const PATCH = {
  file: APP,
  label: 'H1 撤掉「非 Git 仓库隐藏这两颗按钮」的 v-if',
  from: `      <template v-if="gitStore.isGitRepo">
        <CommandHistory size="small" />
        <GitOperationsButton variant="icon" size="small" />
      </template>`,
  to: `      <template v-if="true">
        <CommandHistory size="small" />
        <GitOperationsButton variant="icon" size="small" />
      </template>`,
}

let failed = 0
function ok(name, detail) { console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`) }
function bad(name, detail) { failed++; console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`) }
function note(s) { console.log(`  NOTE  ${s}`) }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 本机 playwright 自带 chromium 可能缺失，依次退到系统 Edge / Chrome（见 README 的排错表） */
async function launchBrowser(chromium) {
  const tries = [
    ['chromium', {}],
    ['msedge', { channel: 'msedge' }],
    ['chrome', { channel: 'chrome' }],
  ]
  let lastErr
  for (const [name, extra] of tries) {
    try {
      return await chromium.launch({ args: ['--no-proxy-server'], ...extra })
    } catch (e) { lastErr = e; note(`${name} 起不来，换下一个：${String(e.message).split('\n')[0]}`) }
  }
  throw lastErr
}

/** 在页面里数顶栏那两颗按钮（locale 无关：aria-label 中英都认） */
const COUNT_FN = () => {
  const header = document.querySelector('.app-header')
  if (!header) return { header: false }
  const buttons = [...header.querySelectorAll('button')]
  const gitOps = buttons.filter(b => (b.getAttribute('aria-label') || '') === 'Git 操作' ||
    /git operation/i.test(b.getAttribute('aria-label') || ''))
  const history = buttons.filter(b => /命令历史|command history/i.test(b.getAttribute('aria-label') || ''))
  return {
    header: true,
    brand: !!header.querySelector('.header-brand-link, h1'),
    monitor: !!header.querySelector('.header-monitor'),
    userInfo: !!header.querySelector('.user-info-card'),
    gitOps: gitOps.length,
    history: history.length,
    // Git 操作按钮的组件根（口径二：组件级计数，防止 aria-label 被改后探针瞎绿）
    gitOpsNodes: header.querySelectorAll('.git-operations-button').length,
  }
}

/** 两个阶段：真实目录（期望 Git 仓库）→ 劫持 /api/current_directory 伪造非 Git 目录 */
async function measure() {
  const { chromium } = require(PW)
  const browser = await launchBrowser(chromium)
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const ready = async () => {
      await page.waitForFunction(
        () => (document.querySelector('#app')?.querySelectorAll('*').length || 0) > 100,
        null, { timeout: 30000 }
      )
      // header 右侧是异步渲染的（实例切换器 / 监控轮询），等它落地再数
      await sleep(4000)
    }

    await page.goto(VITE, { waitUntil: 'domcontentloaded' })
    await ready()
    const gitState = await page.evaluate(COUNT_FN)

    // 伪造"当前目录不是 Git 仓库"
    await page.route('**/api/current_directory*', async (route) => {
      const res = await route.fetch()
      const json = await res.json().catch(() => ({}))
      await route.fulfill({ json: { ...json, directory: 'C:\\Users\\xuze', isGitRepo: false } })
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready()
    const nonGitState = await page.evaluate(COUNT_FN)

    return { gitState, nonGitState }
  } finally {
    await browser.close()
  }
}

function report(m) {
  const { gitState: g, nonGitState: n } = m

  // H2 先看：白屏 / header 没渲染时 H1 的 0 计数是假绿
  const h2 = n.header && n.brand && n.monitor && n.userInfo
  if (h2) ok('H2 非 Git 目录下顶栏本体正常（品牌 / 监控 / 用户区都在）')
  else bad('H2 非 Git 目录下顶栏没渲染出来', JSON.stringify(n))

  // H1 非 Git 目录：两颗都不在
  const h1 = n.gitOps === 0 && n.gitOpsNodes === 0 && n.history === 0
  if (h1) ok('H1 非 Git 目录下「Git 操作 / 命令历史」两颗按钮都不在顶栏')
  else bad('H1 非 Git 目录下仍能看到按钮', `Git 操作 ${n.gitOps} 颗（组件节点 ${n.gitOpsNodes}）/ 命令历史 ${n.history} 颗`)

  // H3 Git 目录：两颗都在（防"一律隐藏"）
  const h3 = g.gitOps >= 1 && g.gitOpsNodes >= 1 && g.history >= 1
  if (h3) ok('H3 Git 目录下两颗按钮都在', `Git 操作 ${g.gitOps} 颗 / 命令历史 ${g.history} 颗`)
  else bad('H3 Git 目录下按钮不见了', `Git 操作 ${g.gitOps} 颗 / 命令历史 ${g.history} 颗 —— 是不是把 v-if 写成恒假了？`)

  return h1 && h2 && h3
}

;(async () => {
  console.log('── 顶栏 Git 按钮的可见性（非 Git 目录隐藏）──\n')

  let chromium
  try { ({ chromium } = require(PW)) } catch {
    note('未装 playwright（src/ui/client/node_modules/playwright），跳过运行时断言')
    return
  }
  try {
    const r = await fetch(VITE, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
  } catch {
    note(`${VITE} 上没有 dev server，跳过运行时断言（起前端：npm run dev）`)
    return
  }

  if (REVERSE) {
    const original = fs.readFileSync(PATCH.file, 'utf8')
    let exitCode = 1
    try {
      if (!original.includes(PATCH.from)) {
        note(`SKIP ${PATCH.label}（源里没找到待撤的串，可能被别的改动挪了位置）`)
        return
      }
      fs.writeFileSync(PATCH.file, original.replace(PATCH.from, PATCH.to))
      console.log(`  关掉  ${PATCH.label}`)
      await sleep(3500) // 等 Vite HMR 重新编译
      const m = await measure()
      const { gitState: g, nonGitState: n } = m
      const stillRed = n.gitOps === 0 && n.gitOpsNodes === 0 && n.history === 0
      console.log(stillRed
        ? `\n反证失败：撤掉 v-if 后非 Git 目录仍数不到这两颗按钮（${JSON.stringify(n)}）—— 断言对修复不敏感`
        : `\n反证成立：撤掉 v-if 后非 Git 目录里又出现了 Git 操作 ${n.gitOps} 颗（组件节点 ${n.gitOpsNodes}）/ 命令历史 ${n.history} 颗`)
      exitCode = stillRed ? 1 : 0
    } finally {
      fs.writeFileSync(PATCH.file, original)
      console.log('\n已还原 App.vue')
    }
    process.exitCode = exitCode
    return
  }

  const pass = report(await measure())
  console.log(pass ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(pass ? 0 : 1)
})().catch((e) => {
  bad('探针自身异常', e && e.stack ? e.stack.split('\n')[0] : String(e))
  process.exit(1)
})
