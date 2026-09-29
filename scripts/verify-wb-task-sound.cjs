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
 * 开一个页面并装上拦截。notifyOnTaskDone 由参数决定，不读用户真实配置。
 *
 * ⚠️ sseDelayMs 不是随便加的等待，是这条用例能不能验到东西的前提：
 *   开关是**每次事件实时读** configStore 的（见 useTaskNotifier.handleJob），
 *   而 configStore 里那个 ref 的初始值就是 true。SSE 在页面刚打开时就建连、
 *   合成帧立刻到达的话，读到的是"还没加载完"的初始值而不是被拦成 false 的配置，
 *   于是"开关关着"这条场景根本验不到（会假失败）。让帧晚一点到，配置先落地。
 */
async function openPage(browser, notifyOnTaskDone, sseDelayMs = 2500) {
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

  // 拦配置：把开关钉死，避免用例结果取决于用户当前设置
  await page.route('**/api/config/getConfig*', async (route) => {
    try {
      const resp = await route.fetch()
      const cfg = await resp.json()
      cfg.notifyOnTaskDone = notifyOnTaskDone
      await route.fulfill({ response: resp, json: cfg })
    } catch {
      await route.fulfill({ json: { notifyOnTaskDone } })
    }
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  // 等 configStore 加载完（开关是实时读的，配置没到位时读到的是默认值）
  await sleep(1500)
  return { ctx, page }
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
    // ── 场景 1：开关打开 ──────────────────────────────────────────────
    const { ctx, page } = await openPage(browser, true)
    try {
      const got = await waitSoundCount(page, 2)
      check('A0 状态跃迁后确实发起了播放', got, `soundLog=${JSON.stringify((await readSoundLog(page)).map(r => r.src))}`)

      // 给解码留点时间（readyState 是异步推进的）
      await sleep(1200)
      const soundLog = await readSoundLog(page)
      const srcs = [...new Set(soundLog.map(r => r.src))].sort()

      check('A1 跑完响 done 音源', soundLog.some(r => r.src === DONE_SRC), srcs.join(', '))
      check('B1 出错响 error 音源（与 done 不是一个音）', soundLog.some(r => r.src === ERROR_SRC))
      check('C1 主动停止不碰任何音源（没有多出第三种 src）',
        srcs.length === 2 && srcs[0] === DONE_SRC && srcs[1] === ERROR_SRC, srcs.join(', '))

      const done = soundLog.find(r => r.src === DONE_SRC)
      const err = soundLog.find(r => r.src === ERROR_SRC)
      check('D1 done 音源在真实浏览器里解码成功（readyState ≥ 2）',
        !!done && done.readyState >= 2 && done.mediaError === 0,
        done ? `readyState=${done.readyState} mediaError=${done.mediaError}` : 'missing')
      check('D2 done 音源时长约 0.29s（对得上 Kenney confirmation_001）',
        !!done && done.duration > 0.2 && done.duration < 0.4, done ? `duration=${done.duration.toFixed(3)}` : 'missing')
      check('D3 error 音源解码成功且时长约 0.52s',
        !!err && err.readyState >= 2 && err.duration > 0.4 && err.duration < 0.7,
        err ? `readyState=${err.readyState} duration=${err.duration.toFixed(3)}` : 'missing')
      check('D4 play() 真的播出去了（未被自动播放策略拦下）',
        !!done && done.plays > 0 && done.playResolved && !done.playError,
        done ? `plays=${done.plays} resolved=${done.playResolved} err=${done.playError}` : 'missing')

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
    const { ctx: ctx2, page: page2 } = await openPage(browser, false)
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
