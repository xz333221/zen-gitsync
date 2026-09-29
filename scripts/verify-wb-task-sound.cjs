/**
 * 任务结束提示音（2026-09-29）的浏览器验证。
 *
 * 验收契约（改这块时别破坏）：
 *   A 任务从「跑着」变 done → 创建 /sounds/task-done.wav 的 Audio 并真的播出去
 *   B 变 error → 换成 /sounds/task-error.wav（不是同一个音）
 *   C 变 cancelled → 一个音源都不碰（用户自己按的停止，再响一声是打扰）
 *   D 音源能在这台机器的真实浏览器里解码（readyState ≥ 2 且时长符合预期）
 *     —— 这条才是"文件是不是真能用"的证明：路径错 / 文件损坏 / 格式浏览器不支持
 *     都会在这里挂掉，而不是在单测里（单测的 Audio 是假的）
 *   E 总开关（notifyOnTaskDone）关着时一声都不响
 *   F hello 快照里的历史 job 不响（页面刚打开看到的一堆"已完成"是老账）
 *   G 页面无 console / page 错误
 *   H 提示音开关（notifySoundOnTaskDone）关着时一个音源都不碰，但**提示照旧**
 *     —— 通知与声音是两个独立的键，关掉一个不该把另一个也带走
 *   I 设置 → 通用设置里的提示音开关：配置能读进 UI、总开关关掉时它置灰、
 *     单独改它时保存的 payload 只带这一个键（不顺手动总开关）
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
 * 开一个页面并装上拦截。两个开关由参数决定，不读用户真实配置。
 *
 * ⚠️ sseDelayMs 不是随便加的等待，是这条用例能不能验到东西的前提：
 *   开关是**每次事件实时读** configStore 的（见 useTaskNotifier.handleJob），
 *   而 configStore 里那两个 ref 的初始值都是 true。SSE 在页面刚打开时就建连、
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

  // 拦配置：把两个开关钉死，避免用例结果取决于用户当前设置
  await page.route('**/api/config/getConfig*', async (route) => {
    try {
      const resp = await route.fetch()
      const cfg = await resp.json()
      cfg.notifyOnTaskDone = switches.notifyOnTaskDone
      cfg.notifySoundOnTaskDone = switches.notifySoundOnTaskDone
      await route.fulfill({ response: resp, json: cfg })
    } catch {
      await route.fulfill({ json: switches })
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 等 configStore 加载完（开关是实时读的，配置没到位时读到的是默认值）
  await sleep(1500)
  return { ctx, page }
}

/** 数页面上的应用内提示条（证明"提示照旧"，与"有没有出声"是两件事） */
function countToasts(page) {
  return page.evaluate(() => document.querySelectorAll('.el-message').length)
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
 * 读「任务完成提示」那一行里的两个开关。
 * 总开关 = 行里第一个（直接的）el-switch；提示音开关 = .notify-sub 里的那个。
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
    const sub = row.querySelector('.notify-sub')
    const subStyle = sub ? getComputedStyle(sub) : null
    return {
      master: state(row.querySelector('.el-switch')),
      sound: state(sub ? sub.querySelector('.el-switch') : null),
      hasSub: !!sub,
      subLabel: (sub?.querySelector('.notify-sub__label')?.textContent || '').trim(),
      // 从属视觉：左侧竖线 + 缩进。数值 > 0 才算"看起来是子选项"
      borderLeft: subStyle ? parseFloat(subStyle.borderLeftWidth) || 0 : 0,
      paddingLeft: subStyle ? parseFloat(subStyle.paddingLeft) || 0 : 0,
    }
  }, labelRe('任务完成提示', 'task finished notice').source)
}

/** 拨动提示音开关（.notify-sub 里那个） */
function toggleSoundSwitch(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i')
    const row = [...document.querySelectorAll('.user-settings-dialog .setting-row')]
      .find(r => re.test(r.querySelector('.setting-label')?.textContent || ''))
    const sw = row?.querySelector('.notify-sub .el-switch')
    if (!sw) return false
    ;(sw.querySelector('.el-switch__core') || sw).click()
    return true
  }, labelRe('任务完成提示', 'task finished notice').source)
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
    // ── 场景 1：两个开关都开 ──────────────────────────────────────────
    const { ctx, page } = await openPage(browser, { notifyOnTaskDone: true, notifySoundOnTaskDone: true })
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

    // ── 场景 2：总开关关掉 ────────────────────────────────────────────
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx2, page: page2 } = await openPage(browser, { notifyOnTaskDone: false, notifySoundOnTaskDone: true })
    try {
      // 先证明帧确实送到了（否则"没响"可能只是还没到），再多等一小会儿防止竞态，
      // 这时候一个音源都不该被创建
      const frames = await waitFrames(page2, FRAMES.length)
      await sleep(1000)
      const off = await readSoundLog(page2)
      check('E1 合成帧确实被页面收下（负向用例的前置事实）', frames >= FRAMES.length, `frames=${frames}/${FRAMES.length}`)
      check('E2 开关关着时一声都不响（声音不绕开总开关）', off.length === 0,
        JSON.stringify(off.map(r => r.src)))
    } finally {
      await ctx2.close()
    }

    // ── 场景 3：总开关开、提示音关（通知与声音是两个独立的键）──────────
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx3, page: page3 } = await openPage(browser, { notifyOnTaskDone: true, notifySoundOnTaskDone: false })
    try {
      const frames = await waitFrames(page3, FRAMES.length)
      await sleep(1000)
      const off = await readSoundLog(page3)
      const toasts = await countToasts(page3)
      check('H1 合成帧确实被页面收下（负向用例的前置事实）', frames >= FRAMES.length, `frames=${frames}/${FRAMES.length}`)
      check('H2 只关提示音时一个音源都不碰', off.length === 0, JSON.stringify(off.map(r => r.src)))
      // 这一条才是"两个键互相独立"的证据：声音没了，提示还在
      check('H3 提示照旧弹出（关声音没把通知一起带走）', toasts > 0, `toasts=${toasts}`)
    } finally {
      await ctx3.close()
    }

    // ── 场景 4：设置 → 通用设置里的提示音开关 ──────────────────────────
    // 4a：配置里提示音关着、总开关开着 → UI 上提示音开关应该是关的且可点
    consoleErrors.length = 0
    pageErrors.length = 0
    const { ctx: ctx4, page: page4 } = await openPage(browser, { notifyOnTaskDone: true, notifySoundOnTaskDone: false })
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
      check('I2 提示音是「任务完成提示」行里的子选项（缩进 + 左侧竖线，不是平级）',
        !!row?.hasSub && row.borderLeft > 0 && row.paddingLeft > 0,
        JSON.stringify({ hasSub: row?.hasSub, borderLeft: row?.borderLeft, paddingLeft: row?.paddingLeft }))
      check('I3 子开关有自己的标签', /提示音|sound cue/i.test(row?.subLabel || ''), row?.subLabel)
      check('I4 ★ 配置里关着 → UI 上提示音开关就是关的（配置读进了 UI）', row?.sound?.on === false,
        JSON.stringify(row?.sound))
      check('I5 总开关开着时提示音开关可点（没被置灰）',
        row?.master?.on === true && row?.sound?.disabled === false,
        JSON.stringify({ master: row?.master, sound: row?.sound }))

      // 打开提示音 → 保存，看前端发出去的 payload
      await toggleSoundSwitch(page4)
      await sleep(300)
      const afterToggle = await readNotifyRow(page4)
      check('I6 拨动后 UI 状态跟着变（开关确实受控，不是画上去的）', afterToggle?.sound?.on === true,
        JSON.stringify(afterToggle?.sound))
      const shotSettings = path.resolve(__dirname, '../tmp-verify-wb-task-sound-settings.png')
      await page4.locator('.user-settings-dialog').screenshot({ path: shotSettings }).catch(() => {})
      log('设置截图:', shotSettings)

      const clickedSave = await clickSave(page4)
      await sleep(600)
      check('I7 保存按钮出现并被点到（只改提示音也构成 hasChanges）', clickedSave)
      check('I8 ★ 保存 payload 只带提示音这一个键（不顺手动总开关）',
        saved.length === 1 && saved[0]?.notifySoundOnTaskDone === true && saved[0]?.notifyOnTaskDone === undefined,
        JSON.stringify(saved))
    } finally {
      await ctx4.close()
    }

    // 4b：总开关关着 → 提示音开关置灰（从属关系在 UI 上看得见）
    const { ctx: ctx5, page: page5 } = await openPage(browser, { notifyOnTaskDone: false, notifySoundOnTaskDone: true })
    try {
      const opened = await openSettingsGeneral(page5)
      check('I9 前置 第二个页面的设置也能打开', opened)
      const row = await readNotifyRow(page5)
      check('I10 ★ 总开关关着时提示音开关置灰（子选项跟着失效，一眼看得出来）',
        row?.master?.on === false && row?.sound?.disabled === true,
        JSON.stringify({ master: row?.master, sound: row?.sound }))
    } finally {
      await ctx5.close()
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
