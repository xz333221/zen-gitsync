/**
 * 「AI 启动建议」面板的浏览器验收(挂在 NPM 脚本面板**上面**的那个手风琴)。
 *
 * 验收契约:
 *   P1 面板出现在 NPM 脚本面板**上方**(DOM 顺序 + 几何都对)
 *   P2 默认**展开**:一进来就能看到内容;同一屏里 NPM 脚本面板仍是收起的
 *      —— 这条是"默认展开只改了新面板"的反证:两个面板都展开就没证明任何东西
 *   P3 列表按接口给的 order 渲染,每条带序号与「启动」按钮
 *   P4 npm 类建议点「启动」→ 打 /api/run-npm-script,body 里 packagePath/scriptName 精确对应
 *   P5 shell 类建议点「启动」→ **先弹确认框**(框里必须出现完整命令),取消则一个请求都不发;
 *      确认后才打 /api/exec-in-terminal(command + workingDirectory)
 *   P6 反向护栏:两个接口都给得出内容时,两个面板**都在**(E1/E2 的阳性对照)
 *
 * 空态(--empty):两个面板都没有内容时**整块不渲染** —— 一个点开只有"没找到/没看出"
 *   的空壳在左栏既占地方又像自己配错了。
 *   E1 NO_FACTS 时 AI 面板不存在 · E2 扫不到带 scripts 的 package.json 时 NPM 面板不存在
 *   E3 护栏:同一时刻外壳(.activity-bar)还在 —— 证明"面板不见了"不是"整页挂了"
 *
 * 反证(--reverse):把接口换成 NO_MODEL,列表必须消失、只剩"未配置模型"的提示。
 *   如果面板无视接口硬渲染一份列表,这一条会红 —— 用来证明 P3 不是空断言。
 *   (NO_MODEL 是**可操作的指引**,所以面板仍在;只有"没内容"才隐藏。)
 *
 * ⚠️ 全程 stub 掉 /api/config/getConfig、/api/project-startup/suggestions 与
 *    /api/scan-npm-scripts:建议接口真调一次要花钱、还要等模型;脚本扫描依赖跑探针时
 *    **当时的工作目录**是不是 Node 项目(不是的话 NPM 面板压根不渲染,P1 会莫名其妙地红);
 *    配置不 stub 就取决于本机有没有配模型。这里要验的都是**界面**怎么用返回值,
 *    三个接口的真实契约由 src/ui/server/routes/projectStartupAi.test.js 等服务端单测保证。
 *
 * 前置:dev server 已启动(vite 5544 / 后端 5545)。
 * 用法:node scripts/verify-startup-ai-panel.cjs
 *      node scripts/verify-startup-ai-panel.cjs --reverse
 *      node scripts/verify-startup-ai-panel.cjs --empty
 * 退出码:0 全通过,1 有失败项,2 脚本异常。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const EMPTY = process.argv.includes('--empty')
const SHOT = process.env.ZEN_SHOT || ''

const PROJECT = path.join(os.tmpdir(), 'zen-ai-panel-demo')

/** NPM 脚本面板的桩:一个带 scripts 的根 package.json(P6 的阳性对照 / P2 的"仍是收起的") */
const PKG_FIXTURE = {
  path: PROJECT,
  relativePath: '.',
  name: 'demo',
  scripts: { dev: 'concurrently "npm run dev:server" "npm run dev:vue"', 'dev:server': 'nodemon server.js' },
}

/** 三条建议覆盖三种形态:npm 两次(验顺序)+ shell 一次(验确认框) */
const FIXTURE = {
  success: true,
  model: 'fixture-model',
  analyzedAt: Date.now(),
  scannedDirs: 3,
  suggestions: [
    {
      id: 'npm:.:dev',
      kind: 'npm',
      title: '一键启动前后端',
      order: 1,
      reason: '根目录 dev 用 concurrently 同时起 dev:server 和 dev:vue',
      packagePath: PROJECT,
      packageLabel: '.',
      packageName: 'demo',
      scriptName: 'dev',
      command: 'npm run dev',
    },
    {
      id: 'npm:.:dev:server',
      kind: 'npm',
      title: '只启动后端',
      order: 2,
      reason: 'dev:server 用 nodemon 跑 server.js',
      packagePath: PROJECT,
      packageLabel: '.',
      packageName: 'demo',
      scriptName: 'dev:server',
      command: 'npm run dev:server',
    },
    {
      id: `shell:.:docker compose up -d`,
      kind: 'shell',
      title: '用 Docker 起全套',
      order: 3,
      reason: '根目录有 docker-compose.yml',
      command: 'docker compose up -d',
      cwd: PROJECT,
      cwdLabel: '.',
    },
  ],
}

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!fs.existsSync(path.join(__dirname, '../src/ui/client/node_modules/playwright'))) {
    console.error('前置不足：没装 playwright（npm run install:vue）')
    process.exit(2)
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } })

  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))

  /**
   * 配置也 stub:面板**没配模型时压根不发请求**(设计如此),那就只能验到 no-model 分支,
   * NO_FACTS / 有列表这两条全验不到。而真配置是本机 ~/.zen-gitsync/config.json,
   * 跑探针的机器有没有配模型是随机的 —— 这里给一份最小可用配置 + 一个假模型,
   * 三个模式才都验得到,也不再依赖后端进程(后端没起时其余接口 502 也无所谓)。
   */
  await page.route('**/api/config/getConfig', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        currentDirectory: PROJECT,
        models: [{ id: 'probe-model', name: 'Probe Model', baseURL: 'http://127.0.0.1:1/v1', model: 'probe-model', isDefault: true, apiKey: 'probe' }],
        commandTemplates: [],
        descriptionTemplates: [],
        scopeTemplates: [],
        messageTemplates: [],
        lockedFiles: [],
        customCommands: [],
        orchestrations: [],
        startupItems: [],
      }),
    })
  })

  /** 建议接口的返回值:正常给三条,反证给 NO_MODEL,空态给 NO_FACTS */
  await page.route('**/api/project-startup/suggestions', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REVERSE
        ? { success: false, code: 'NO_MODEL', error: '未配置 AI 模型' }
        : EMPTY
          ? { success: false, code: 'NO_FACTS', error: '没有 package.json 或启动相关文件' }
          : FIXTURE),
    })
  })

  /** npm 脚本扫描:空态给空数组,其余给一个带 scripts 的包 —— 别让探针依赖跑它时的工作目录 */
  await page.route('**/api/scan-npm-scripts', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY
        ? { success: true, packages: [], totalScripts: 0 }
        : { success: true, packages: [PKG_FIXTURE], totalScripts: 2 }),
    })
  })

  const runCalls = []
  await page.route('**/api/run-npm-script', (route) => {
    runCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
  const execCalls = []
  await page.route('**/api/exec-in-terminal', (route) => {
    execCalls.push(JSON.parse(route.request().postData() || '{}'))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 首屏 vite 预构建可能慢;空态下面板压根不渲染,只能等外壳
  await page.waitForSelector(EMPTY ? '.activity-bar' : '.startup-ai-panel', { timeout: 90000 })
  await sleep(1500) // 等桩接口回来并渲染

  if (EMPTY) {
    // ── E1/E2 没内容就不渲染 ────────────────────────────────────────────
    const aiCount = await page.locator('.startup-ai-panel').count()
    const npmCount = await page.locator('.npm-scripts-panel').count()
    const suggestionItems = await page.locator('.suggestion-item').count()
    check('E1 NO_FACTS 时 AI 启动建议面板整块不存在', aiCount === 0, `count=${aiCount}`)
    check('E2 扫不到带 scripts 的 package.json 时 NPM 脚本面板整块不存在', npmCount === 0, `count=${npmCount}`)
    check('E2 顺带确认没有建议条目漏在面板外', suggestionItems === 0, `count=${suggestionItems}`)

    // ── E3 护栏:外壳还在,证明"面板不见了"是规则生效而不是整页炸了 ──────
    const shell = await page.locator('.activity-bar').first().isVisible().catch(() => false)
    check('E3 护栏:应用外壳仍在(空面板不是整页挂掉)', shell)

    if (SHOT) {
      // 空态没法截"面板"(面板没了),截左栏整块 —— 看得出那两个位置是空的
      await page.locator('.git-status-card').first().screenshot({ path: SHOT })
      console.log(`  截图: ${SHOT}`)
    }

    check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

    await browser.close()
    return
  }

  // ── P1 位置:在 NPM 脚本面板上面 ────────────────────────────────────────
  const order = await page.evaluate(() => {
    const ai = document.querySelector('.startup-ai-panel')
    const npm = document.querySelector('.npm-scripts-panel')
    if (!ai || !npm) return null
    return {
      domBefore: !!(ai.compareDocumentPosition(npm) & Node.DOCUMENT_POSITION_FOLLOWING),
      aiTop: ai.getBoundingClientRect().top,
      npmTop: npm.getBoundingClientRect().top,
    }
  })
  check('P1 面板在 NPM 脚本面板上方(DOM 顺序)', !!order?.domBefore, JSON.stringify(order))
  check('P1 面板在 NPM 脚本面板上方(几何)', !!order && order.aiTop < order.npmTop,
    order ? `ai.top=${Math.round(order.aiTop)} npm.top=${Math.round(order.npmTop)}` : 'no bars')

  // ── P2 默认展开 ────────────────────────────────────────────────────────
  const aiBodyVisible = await page.locator('.startup-ai-panel .panel-body').isVisible()
  const npmBodyVisible = await page.locator('.npm-scripts-panel .packages-container, .npm-scripts-panel .loading-container')
    .first().isVisible().catch(() => false)
  check('P2 AI 面板默认展开', aiBodyVisible)
  check('P2 对照:NPM 脚本面板默认仍是收起的', !npmBodyVisible)

  if (REVERSE) {
    // ── 反证:列表必须由接口驱动 ────────────────────────────────────────
    const itemCount = await page.locator('.startup-ai-panel .suggestion-item').count()
    const bodyText = (await page.locator('.startup-ai-panel .panel-body').innerText()).replace(/\s+/g, ' ')
    check('反证:NO_MODEL 时不渲染任何建议条目', itemCount === 0, `count=${itemCount}`)
    check('反证:NO_MODEL 时提示去配置模型', bodyText.includes('未配置 AI 模型'), bodyText.slice(0, 120))
    check('反证:NO_MODEL 时一个启动请求都没发', runCalls.length === 0 && execCalls.length === 0)
    // 没内容才隐藏;NO_MODEL 是**可操作的指引**,面板必须还在(否则用户不知道要去配模型)
    check('反证:NO_MODEL 时面板仍在(指引不算"没内容")',
      await page.locator('.startup-ai-panel').first().isVisible().catch(() => false))
  } else {
    // ── P3 列表渲染 ────────────────────────────────────────────────────
    const items = await page.locator('.startup-ai-panel .suggestion-item').count()
    check('P3 渲染出 3 条建议', items === 3, `count=${items}`)

    const rendered = await page.locator('.startup-ai-panel .suggestion-item').evaluateAll((els) => els.map((el) => ({
      order: el.querySelector('.suggestion-order')?.textContent?.trim(),
      title: el.querySelector('.suggestion-name')?.textContent?.trim(),
      cmd: el.querySelector('.suggestion-cmd')?.textContent?.trim(),
      tag: el.querySelector('.suggestion-tag')?.textContent?.trim(),
      hasButton: !!Array.from(el.querySelectorAll('button')).find((b) => b.textContent.trim() === '启动'),
    })))
    check('P3 序号按 order 连续', rendered.map((r) => r.order).join(',') === '1,2,3', JSON.stringify(rendered.map((r) => r.order)))
    check('P3 每条都有命令行与「启动」按钮',
      rendered.every((r) => r.cmd && r.hasButton),
      JSON.stringify(rendered.map((r) => r.cmd)))
    check('P3 npm 与 shell 两类标签都在',
      rendered[0].tag === 'npm 脚本' && rendered[2].tag === '命令行',
      rendered.map((r) => r.tag).join(' | '))

    // ── P4 npm 建议:直接跑 ────────────────────────────────────────────
    await page.locator('.startup-ai-panel .suggestion-item').nth(1)
      .locator('button', { hasText: '启动' }).click()
    await sleep(600)
    check('P4 点 npm 建议 → /api/run-npm-script 收到 packagePath + scriptName',
      runCalls.length === 1
      && path.resolve(runCalls[0].packagePath || '') === path.resolve(PROJECT)
      && runCalls[0].scriptName === 'dev:server',
      JSON.stringify(runCalls))
    const launched = await page.locator('.startup-ai-panel .suggestion-item').nth(1).getAttribute('class')
    check('P4 启动过的条目有已启动标记', String(launched).includes('is-launched'))

    // ── P5 shell 建议:先确认,取消不发请求 ────────────────────────────
    const shellBtn = page.locator('.startup-ai-panel .suggestion-item').nth(2).locator('button', { hasText: '启动' })
    await shellBtn.click()
    await page.waitForSelector('.el-message-box', { timeout: 5000 })
    const boxText = (await page.locator('.el-message-box').innerText()).replace(/\s+/g, ' ')
    check('P5 弹确认框,框里有完整命令', boxText.includes('docker compose up -d'), boxText.slice(0, 120))
    await page.locator('.el-message-box').getByRole('button', { name: '取消' }).click()
    await sleep(400)
    check('P5 取消后没有发执行请求', execCalls.length === 0, JSON.stringify(execCalls))

    await shellBtn.click()
    await page.waitForSelector('.el-message-box', { timeout: 5000 })
    await page.locator('.el-message-box').getByRole('button', { name: '执行' }).click()
    await sleep(600)
    check('P5 确认后 → /api/exec-in-terminal 收到 command + workingDirectory',
      execCalls.length === 1
      && execCalls[0].command === 'docker compose up -d'
      && path.resolve(execCalls[0].workingDirectory || '') === path.resolve(PROJECT),
      JSON.stringify(execCalls))

    // ── P6 阳性护栏:有内容时 NPM 脚本面板必须在,且真的渲染出脚本 ────────
    //    (E2 的对照 —— 只断言"空的时候不见了"会被"整块功能坏掉"骗过去)
    await page.locator('.npm-scripts-panel .accordion-header').click()
    await sleep(300)
    const pkgItems = await page.locator('.npm-scripts-panel .package-item').count()
    check('P6 NPM 脚本面板在(有 scripts 时不隐藏)', pkgItems === 1, `count=${pkgItems}`)
    await page.locator('.npm-scripts-panel .package-header').first().click()
    await sleep(300)
    const scriptItems = await page.locator('.npm-scripts-panel .script-item').count()
    check('P6 展开后渲染出 2 条脚本', scriptItems === 2, `count=${scriptItems}`)
    await page.locator('.npm-scripts-panel .accordion-header').click() // 收回去,别挡住后面的截图

    if (SHOT) {
      await page.locator('.startup-ai-panel').screenshot({ path: SHOT })
      console.log(`  截图: ${SHOT}`)
    }
  }

  check('没有未捕获的页面异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300))

  await browser.close()
}

main()
  .then(() => {
    const failed = results.filter((r) => !r.ok)
    const mode = EMPTY ? '（空态模式）' : REVERSE ? '（反证模式）' : ''
    console.log(`\n${results.length - failed.length}/${results.length} 通过${mode}`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((err) => {
    console.error('探针异常:', err)
    process.exit(2)
  })
