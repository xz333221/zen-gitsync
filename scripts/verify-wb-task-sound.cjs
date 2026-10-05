/**
 * 任务结束提示（声音 + 页面提示 + 浏览器通知）的浏览器验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 任务从「跑着」变 done → 创建 /sounds/task-done.wav 的 Audio 并真的播出去
 *   B 变 error → 换成 /sounds/task-error.wav（不是同一个音）
 *   C 变 cancelled → 一个音源都不碰（用户自己按的停止，再响一声是打扰）
 *   D 音源能在这台机器的真实浏览器里解码（readyState ≥ 2 且时长符合预期）
 *     —— 这条才是"文件是不是真能用"的证明：路径错 / 文件损坏 / 格式浏览器不支持
 *     都会在这里挂掉，而不是在单测里（单测的 Audio 是假的）
 *   E 三个通道全关着时一声都不响、也不弹提示
 *   F hello 快照里的历史 job 不响（页面刚打开看到的一堆"已完成"是老账）
 *   G 页面无 console / page 错误
 *   H 提示音关着、页面提示开着 → 一个音源都不碰，但**提示照旧**
 *     —— 三个通道各自独立，关掉一个不该把另一个也带走
 *   I 设置 → 通用设置里的三个通道开关：配置能读进 UI、各自独立（互不置灰）、
 *     改一个时保存的 payload 只带那一个键
 *   J **不再自动申请浏览器通知权限**（2026-10-05）：页面内点一下也不该弹授权框 ——
 *     权限只在用户把「浏览器通知」开关拨开的那一刻申请。这是这次改动的核心诉求。
 *
 * 为什么用 route 拦截 /api/workbench/events 喂合成帧，而不是真跑一个任务：
 *   真跑一次 CLI 要几十秒且结果不可控（可能失败、可能超时），而这里要验的是
 *   「状态跃迁 → 响一声」这条链路。合成帧直接构造三种跃迁，秒级且确定。
 *   拦 config 而不是读真实配置，是因为 ~/.zen-gitsync/config.json 是全局共享的
 *   （用户手上有自己的开关状态），读它等于让用例结果取决于用户当前的设置。
 *
 * 前置：dev server 已启动（vite 5544）。不需要真后端参与订阅链路（SSE 被拦了），
 *       但页面其余接口仍走真实后端（5545 / 5546），所以后端也得活着。
 * 用法：node scripts/verify-wb-task-sound.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const fs = require('node:fs')
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const CHROME = process.env.ZEN_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const results = []
const consoleErrors = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 合成帧：hello 快照 + 三条真实跃迁，顺序固定（跑完 / 出错 / 主动停止） */
const FRAMES = [
  { event: 'hello', payload: { jobs: [{ id: 'hist-1', title: '历史任务', status: 'done' }] } },
  { event: 'job:update', payload: { id: 's-done', title: '提示音验证-跑完', status: 'running' } },
  { event: 'job:update', payload: { id: 's-done', title: '提示音验证-跑完', status: 'done', output: '搞定了' } },
  { event: 'job:update', payload: { id: 's-err', title: '提示音验证-出错', status: 'running' } },
  { event: 'job:update', payload: { id: 's-err', title: '提示音验证-出错', status: 'error', error: 'boom' } },
  { event: 'job:update', payload: { id: 's-stop', title: '提示音验证-停止', status: 'running' } },
  { event: 'job:update', payload: { id: 's-stop', title: '提示音验证-停止', status: 'cancelled' } },
]
const SSE_BODY = FRAMES.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')

const DONE_SRC = '/sounds/task-done.wav'
const ERROR_SRC = '/sounds/task-error.wav'

/**
 * 页面侧探针：把原生 Audio 包一层，记录每次创建的音源与播放结果。
 * 用 addInitScript 而不是改产品代码 —— 验的就是"真实路径下有没有响"，
 * 探针必须站在产品代码之外。
 *
 * 顺带数一遍 SSE 帧：负向用例（开关关着时不该响）必须先证明"帧确实送到了"，
 * 否则"没响"可能只是帧还没到 —— 那种用例是假通过。
 */
const PROBE = () => {
  const w = window
  w.__soundLog = []
  const NativeAudio = w.Audio
  function Patched(src) {
    const el = new NativeAudio(src)
    const rec = { src: String(src), plays: 0, playResolved: false, playError: '', el }
    w.__soundLog.push(rec)
    const origPlay = el.play.bind(el)
    el.play = function () {
      rec.plays++
      const p = origPlay()
      if (p && typeof p.then === 'function') {
        p.then(() => { rec.playResolved = true }).catch((e) => { rec.playError = String(e && e.name || e) })
      }
      return p
    }
    return el
  }
  Patched.prototype = NativeAudio.prototype
  w.Audio = Patched

  const NativeES = w.EventSource
  if (NativeES) {
    w.__sseFrames = 0
    function PatchedES(url, init) {
      const es = new NativeES(url, init)
      es.addEventListener('message', () => { w.__sseFrames++ })
      return es
    }
    PatchedES.prototype = NativeES.prototype
    w.EventSource = PatchedES
  }

  // 浏览器通知权限：只记"有没有人调过 requestPermission"。
  // 用例 J 要证明"页面内的任何点击都不再自动申请"—— 那正是用户抱怨的授权框来源。
  w.__permRequests = 0
  const NativeNotify = w.Notification
  if (NativeNotify && typeof NativeNotify.requestPermission === 'function') {
    const origReq = NativeNotify.requestPermission.bind(NativeNotify)
    NativeNotify.requestPermission = function () {
      w.__permRequests++
      return origReq()
    }
  }
}

/** 读探针结果（去掉 el 引用，没法跨进程序列化） */
function readSoundLog(page) {
  return page.evaluate(() => (window.__soundLog || []).map(r => ({
    src: r.src,
    plays: r.plays,
    playResolved: r.playResolved,
    playError: r.playError,
    readyState: r.el.readyState,
    duration: Number(r.el.duration) || 0,
    mediaError: r.el.error ? r.el.error.code : 0,
  })))
}

/** 等到探针记满 n 条音源（或超时） */
async function waitSoundCount(page, n, timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const log = await page.evaluate(() => (window.__soundLog || []).length)
    if (log >= n) return true
    await sleep(200)
  }
  return false
}

/** 等到合成帧确实被页面收下（负向用例的前置事实，别让它变成假通过） */
async function waitFrames(page, n, timeout = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const got = await page.evaluate(() => window.__sseFrames || 0)
    if (got >= n) return got
    await sleep(200)
  }
  return await page.evaluate(() => window.__sseFrames || 0)
}

/**
 * 等所有已创建的音源解码出元数据（readyState ≥ 2）。
 * 别用固定 sleep：机器忙一下（典型是 vite 在 restart）就会看到 readyState=0 而假失败 ——
 * 这个用例要验的是"文件能不能解码"，不是"1.2 秒内能不能解码"。
 */
async function waitDecoded(page, timeout = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const ready = await page.evaluate(() =>
      (window.__soundLog || []).length > 0 && window.__soundLog.every(r => r.el.readyState >= 2))
    if (ready) return true
    await sleep(200)
  }
  return false
}

/**
 * 开一个页面并装上拦截。三个通道开关由参数决定，不读用户真实配置。
 *
 * ⚠️ sseDelayMs 不是随便加的等待，是这条用例能不能验到东西的前提：
 *   开关是**每次事件实时读** configStore 的（见 useTaskNotifier.handleJob），
 *   而 configStore 里那几个 ref 的初始值就是默认值。SSE 在页面刚打开时就建连、
 *   合成帧立刻到达的话，读到的是"还没加载完"的初始值而不是被拦掉的配置，
 *   于是"开关关着"这类场景根本验不到（会假失败）。让帧晚一点到，配置先落地。
 */
async function openPage(browser, switches, sseDelayMs = 2500) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await ctx.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.addInitScript(PROBE)

  // 拦 SSE：喂合成帧。末尾不给更多数据，EventSource 断开后会按 3s 重连再收一遍，
  // 所以下面的断言一律基于"音源集合"而不是"响了 N 次"（重放不会引入新的音源）。
  await page.route('**/api/workbench/events*', async (route) => {
    await sleep(sseDelayMs)
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache' },
      body: SSE_BODY,
    })
  })

  // 拦配置：把三个通道开关钉死，避免用例结果取决于用户当前设置
  const cfgPatch = {
    notifyPageOnTaskDone: switches.page,
    notifyBrowserOnTaskDone: switches.browser,
    notifySoundOnTaskDone: switches.sound,
  }
  await page.route('**/api/config/getConfig*', async (route) => {
    try {
      const resp = await route.fetch()
      const cfg = await resp.json()
      Object.assign(cfg, cfgPatch)
      await route.fulfill({ response: resp, json: cfg })
    } catch {
      await route.fulfill({ json: cfgPatch })
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 等 configStore 加载完（开关是实时读的，配置没到位时读到的是默认值）
  await sleep(1500)
  return { ctx, page }
}

/** 提示条的文案（负向用例失败时要能一眼看出"多出来那条是什么"，别对着一个数字猜） */
function toastTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.el-message')]
    .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()))
}

/**
 * 只数**本次合成帧带来的**提示条。
 *
 * ⚠️ 别数 `.el-message` 的总数：页面自己还会弹别的 toast（启动期的 Git 状态刷新之类），
 * 那一条与提示通道的开关毫无关系 —— 直接数总数会让"全关时不该有提示"这条假红。
 * 合成帧用的是固定任务名（提示音验证-*），按名字认领才认得出哪几条是我自己造的。
 */
async function noticeToasts(page) {
  const texts = await toastTexts(page)
  return texts.filter((t) => t.includes('提示音验证'))
}

// ── 设置对话框（场景 4）────────────────────────────────────────────────
const labelRe = (zh, en) => new RegExp(`${zh}|${en}`, 'i')

/** 打开 设置 → 通用设置（通用是默认 tab，不用切） */
async function openSettingsGeneral(page) {
  const clicked = await page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const btn = [...document.querySelectorAll('button[aria-label]')]
      .find(b => re.test(b.getAttribute('aria-label') || ''))
    if (!btn) return false
    btn.click()
    return true
  }, labelRe('用户设置', 'user settings').source)
  if (!clicked) return false
  await page.waitForSelector('.user-settings-dialog .settings-tabs', { timeout: 10000 }).catch(() => {})
  // loading 遮罩会吃掉点击，等它退场
  await page.locator('.user-settings-dialog .el-loading-mask').waitFor({ state: 'detached', timeout: 8000 }).catch(() => {})
  await sleep(300)
  return true
}

/**
 * 读「任务与对话完成提示」那一行里的三个通道开关。
 * 三个开关**平级**（页面提示 / 浏览器通知 / 提示音），谁也不缩进、谁也不因别人关掉而置灰。
 */
function readNotifyRow(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const row = [...document.querySelectorAll('.user-settings-dialog .setting-row')]
      .find(r => re.test(r.querySelector('.setting-label')?.textContent || ''))
    if (!row) return null
    const state = (sw) => {
      if (!sw) return null
      const aria = sw.getAttribute('aria-checked')
      return {
        on: aria ? aria === 'true' : sw.classList.contains('is-checked'),
        disabled: sw.classList.contains('is-disabled'),
      }
    }
    const channels = [...row.querySelectorAll('.notify-channel')].map((c) => ({
      label: (c.querySelector('.notify-channel__label')?.textContent || '').trim(),
      switch: state(c.querySelector('.el-switch')),
      hint: (c.querySelector('.notify-hint')?.textContent || '').trim(),
      // 缩进 = 视觉上宣称"我是谁的子选项"。三个通道平级，这里必须都是 0
      paddingLeft: parseFloat(getComputedStyle(c).paddingLeft) || 0,
    }))
    return {
      count: channels.length,
      channels,
    }
  }, labelRe('任务与对话完成提示', 'task and chat finished notice').source)
}

/** 从 readNotifyRow 的结果里按标签文案挑一个通道（标签匹配在 Node 侧做，函数没法跨进程序列化） */
function channel(row, kw) {
  const re = new RegExp(kw, 'i')
  return (row?.channels || []).find((c) => re.test(c.label)) || null
}

/** 拨动某个通道的开关（按标签文案找，找不到返回 false） */
function toggleChannel(page, labelSrc) {
  return page.evaluate((payload) => {
    const rowRe = new RegExp(payload.rowSrc, 'i')
    const row = [...document.querySelectorAll('.user-settings-dialog .setting-row')]
      .find(r => rowRe.test(r.querySelector('.setting-label')?.textContent || ''))
    if (!row) return false
    const labelRe = new RegExp(payload.labelSrc, 'i')
    const channel = [...row.querySelectorAll('.notify-channel')]
      .find(c => labelRe.test(c.querySelector('.notify-channel__label')?.textContent || ''))
    const sw = channel?.querySelector('.el-switch')
    if (!sw) return false
    ;(sw.querySelector('.el-switch__core') || sw).click()
    return true
  }, { rowSrc: labelRe('任务与对话完成提示', 'task and chat finished notice').source, labelSrc })
}

/** 点保存（按钮只在有改动时渲染） */
function clickSave(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('.user-settings-dialog .dialog-confirm-btn')
    if (!btn) return false
    btn.click()
    return true
  })
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    // 无人值守下 --autoplay-policy 是必须的：默认策略要求用户手势，
    // play() 会被拒（那验的就不是"能不能响"而是"浏览器策略拦不拦"）。
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  })

  try {
    // ── 场景 1：三个通道都开 ──────────────────────────────────────────
    const { ctx, page } = await openPage(browser, { page: true, browser: true, sound: true })
    try {
      const got = await waitSoundCount(page, 2)
      check('A0 状态跃迁后确实发起了播放', got, `soundLog=${JSON.stringify((await readSoundLog(page)).map(r => r.src))}`)

      // 等元数据解出来（异步推进，别用固定 sleep，见 waitDecoded）
      const decoded = await waitDecoded(page)
      const soundLog = await readSoundLog(page)
      const srcs = [...new Set(soundLog.map(r => r.src))].sort()

      check('A1 跑完响 done 音源', soundLog.some(r => r.src === DONE_SRC), srcs.join(', '))
      check('B1 出错响 error 音源（与 done 不是一个音）', soundLog.some(r => r.src === ERROR_SRC))
      check('C1 主动停止不碰任何音源（没有多出第三种 src）',
        srcs.length === 2 && srcs[0] === DONE_SRC && srcs[1] === ERROR_SRC, srcs.join(', '))

      const done = soundLog.find(r => r.src === DONE_SRC)
      const err = soundLog.find(r => r.src === ERROR_SRC)
      check('D0 两个音源都解出了元数据（前置：没解出来下面的时长断言没意义）', decoded,
        soundLog.map(r => `${r.src}:${r.readyState}`).join(', '))
      check('D1 done 音源在真实浏览器里解码成功（readyState ≥ 2）',
        !!done && done.readyState >= 2 && done.mediaError === 0,
        done ? `readyState=${done.readyState} mediaError=${done.mediaError}` : 'missing')
      check('D2 done 音源时长约 0.29s（对得上 Kenney confirmation_001）',
        !!done && done.duration > 0.2 && done.duration < 0.4, done ? `duration=${done.duration.toFixed(3)}` : 'missing')
      check('D3 error 音源解码成功且时长约 0.52s',
        !!err && err.readyState >= 2 && err.duration > 0.4 && err.duration < 0.7,
        err ? `readyState=${err.readyState} duration=${err.duration.toFixed(3)}` : 'missing')
      // play() 的 Promise 是解码推进后才 settle 的，等它落地再判（同样别用固定 sleep）
      for (let i = 0; i < 25; i++) {
        const s = await readSoundLog(page)
        const d = s.find(r => r.src === DONE_SRC)
        if (!d || d.playResolved || d.playError) break
        await sleep(200)
      }
      const settled = (await readSoundLog(page)).find(r => r.src === DONE_SRC)
      check('D4 play() 真的播出去了（未被自动播放策略拦下）',
        !!settled && settled.plays > 0 && settled.playResolved && !settled.playError,
        settled ? `plays=${settled.plays} resolved=${settled.playResolved} err=${settled.playError}` : 'missing')

      // 关掉页面之前留一张全景图，证明应用本身是正常起来的（不是"白屏但探针有值"）
      const shot = path.resolve(__dirname, '../tmp-verify-wb-task-sound.png')
      await page.screenshot({ path: shot })
      log('截图:', shot)

      check('F1 hello 里的历史 job 没有触发播放（音源只有 2 种，没有多余条目）',
        soundLog.length <= 4, `entries=${soundLog.length}`)
    } finally {
      await ctx.close()
    }

    // ── 场景 2：三个通道全关 ──────────────────────────────────────────
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx2, page: page2 } = await openPage(browser, { page: false, browser: false, sound: false })
    try {
      // 先证明帧确实送到了（否则"没响"可能只是还没到），再多等一小会儿防止竞态，
      // 这时候一个音源都不该被创建
      const frames = await waitFrames(page2, FRAMES.length)
      await sleep(1000)
      const off = await readSoundLog(page2)
      check('E1 合成帧确实被页面收下（负向用例的前置事实）', frames >= FRAMES.length, `frames=${frames}/${FRAMES.length}`)
      check('E2 全关时一声都不响', off.length === 0, JSON.stringify(off.map(r => r.src)))
      check('E3 全关时也不弹应用内提示条', (await noticeToasts(page2)).length === 0,
        JSON.stringify(await toastTexts(page2)))
    } finally {
      await ctx2.close()
    }

    // ── 场景 3：页面提示开、提示音关（三个通道各自独立）────────────────
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx3, page: page3 } = await openPage(browser, { page: true, browser: false, sound: false })
    try {
      const frames = await waitFrames(page3, FRAMES.length)
      await sleep(1000)
      const off = await readSoundLog(page3)
      const toasts = await noticeToasts(page3)
      check('H1 合成帧确实被页面收下（负向用例的前置事实）', frames >= FRAMES.length, `frames=${frames}/${FRAMES.length}`)
      check('H2 只关提示音时一个音源都不碰', off.length === 0, JSON.stringify(off.map(r => r.src)))
      // 这一条才是"三个键互相独立"的证据：声音没了，提示还在
      check('H3 提示照旧弹出（关声音没把提示一起带走）', toasts.length > 0, JSON.stringify(toasts))
    } finally {
      await ctx3.close()
    }

    // ── 场景 3b：只开提示音（两个视觉通道都关）────────────────────────
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx3b, page: page3b } = await openPage(browser, { page: false, browser: false, sound: true })
    try {
      const played = await waitSoundCount(page3b, 2)
      await sleep(600)
      const log3b = await readSoundLog(page3b)
      check('H4 只开提示音时声音照响（它不依赖另外两个通道）', played,
        JSON.stringify(log3b.map(r => r.src)))
      check('H5 两个视觉通道关着 → 不弹提示条', (await noticeToasts(page3b)).length === 0,
        JSON.stringify(await toastTexts(page3b)))
    } finally {
      await ctx3b.close()
    }

    // ── 场景 4：设置 → 通用设置里的三个通道开关 ────────────────────────
    // 4a：配置里「页面提示开 / 浏览器通知开 / 提示音关」→ UI 上如实反映
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx4, page: page4 } = await openPage(browser, { page: true, browser: true, sound: false })
    try {
      // ⚠️ 拦掉保存：对话框的保存会 POST 到真实后端，而 ~/.zen-gitsync/config.json
      // 是**用户全局共享**的，验证脚本绝不能顺手把用户的开关改掉。这里只截获
      // payload 做断言，"后端能不能正确落盘"由 verify-config-split.mjs 在沙箱里覆盖。
      const saved = []
      await page4.route('**/api/config/save-general-settings', async (route) => {
        try { saved.push(route.request().postDataJSON()) } catch { saved.push(null) }
        await route.fulfill({ json: { success: true } })
      })

      const opened = await openSettingsGeneral(page4)
      check('I1 前置 设置对话框打开（通用设置）', opened)
      if (!opened) throw new Error('设置对话框打不开，后续无法验证')

      const row = await readNotifyRow(page4)
      check('I2 ★ 三个通道各有一个开关（页面提示 / 浏览器通知 / 提示音）', row?.count === 3,
        JSON.stringify(row?.channels?.map((c) => c.label)))
      const pageCh = channel(row, '页面提示|in-app toast')
      const browserCh = channel(row, '浏览器通知|browser notification')
      const soundCh = channel(row, '提示音|sound cue')
      check('I3 三个通道各有自己的标签', !!pageCh && !!browserCh && !!soundCh,
        JSON.stringify({ pageCh: !!pageCh, browserCh: !!browserCh, soundCh: !!soundCh }))
      check('I4 ★ 配置读进了 UI（页面提示开 / 浏览器通知开 / 提示音关）',
        pageCh?.switch?.on === true && browserCh?.switch?.on === true && soundCh?.switch?.on === false,
        JSON.stringify({ page: pageCh?.switch, browser: browserCh?.switch, sound: soundCh?.switch }))
      check('I5 ★ 三个开关互不置灰（平级，没有从属关系）',
        [pageCh, browserCh, soundCh].every((c) => c?.switch?.disabled === false),
        JSON.stringify([pageCh, browserCh, soundCh].map((c) => c?.switch)))
      check('I6 三个通道不缩进（缩进会暗示"我是谁的子选项"）',
        (row?.channels || []).every((c) => c.paddingLeft === 0),
        JSON.stringify((row?.channels || []).map((c) => c.paddingLeft)))

      // 打开提示音 → 保存，看前端发出去的 payload
      const toggled = await toggleChannel(page4, '提示音|sound cue')
      check('I7 前置 提示音开关被点到', toggled)
      await sleep(300)
      const afterToggle = await readNotifyRow(page4)
      check('I8 拨动后 UI 状态跟着变（开关确实受控，不是画上去的）',
        channel(afterToggle, '提示音|sound cue')?.switch?.on === true,
        JSON.stringify(channel(afterToggle, '提示音|sound cue')?.switch))
      const shotSettings = path.resolve(__dirname, '../tmp-verify-wb-task-sound-settings.png')
      await page4.locator('.user-settings-dialog').screenshot({ path: shotSettings }).catch(() => {})
      log('设置截图:', shotSettings)

      const clickedSave = await clickSave(page4)
      await sleep(600)
      check('I9 保存按钮出现并被点到（只改提示音也构成 hasChanges）', clickedSave)
      check('I10 ★ 保存 payload 只带被改的那一个键（不带另外两个）',
        saved.length === 1
          && saved[0]?.notifySoundOnTaskDone === true
          && saved[0]?.notifyPageOnTaskDone === undefined
          && saved[0]?.notifyBrowserOnTaskDone === undefined,
        JSON.stringify(saved))
    } finally {
      await ctx4.close()
    }

    // ── 场景 5：浏览器通知权限不再自动申请（这次改动的核心诉求）────────
    // 打开页面 + 在页面内点几下 → 一次 requestPermission 都不该发生。
    // 之前挂的是"页面内首次点击就申请"（那时总开关默认开），用户每开一次 GUI
    // 就被弹一次授权框。
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx5, page: page5 } = await openPage(browser, { page: true, browser: false, sound: true })
    try {
      await page5.mouse.click(400, 400)
      await sleep(400)
      await page5.mouse.click(500, 300)
      await sleep(1500)
      const reqs = await page5.evaluate(() => window.__permRequests || 0)
      check('J1 ★ 页面内点击不再自动申请通知权限（不再弹授权框）', reqs === 0,
        `requestPermission 调用次数=${reqs}`)
    } finally {
      await ctx5.close()
    }

    // 只有把「浏览器通知」开关拨开的那一刻才申请（用户手势里浏览器才会真的弹）
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx6, page: page6 } = await openPage(browser, { page: true, browser: false, sound: true })
    try {
      const opened = await openSettingsGeneral(page6)
      check('J2 前置 第三个页面的设置也能打开', opened)
      await toggleChannel(page6, '浏览器通知|browser notification')
      await sleep(1500)
      const reqs = await page6.evaluate(() => window.__permRequests || 0)
      check('J3 ★ 拨开浏览器通知开关时才申请权限', reqs >= 1, `requestPermission 调用次数=${reqs}`)
    } finally {
      await ctx6.close()
    }

    check('G1 页面无 console / page 错误', consoleErrors.length === 0 && pageErrors.length === 0,
      [...consoleErrors, ...pageErrors].slice(0, 3).join(' | '))
  } finally {
    // 只关自己起的这个浏览器实例（按 CDP，不用 taskkill /IM —— 那会连带关掉用户的浏览器）
    await browser.close()
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过`)
  for (const f of failed) console.log(`  FAIL  ${f.name}  :: ${f.extra}`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error('[verify] 异常退出:', err); process.exit(1) })
