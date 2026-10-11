/**
 * g ai 问答的两件事一起验：提问提示音 + 答完之后问答留在消息流里。
 *
 * 验收契约（改这块时别破坏）：
 *   A 模型 ask_user 到帧 → 创建 /sounds/task-question.wav 的 Audio 并真的发起播放
 *   B 这一声**不是**终态那两声（done / error 的音源），否则两个信号分不开
 *   C 作答（POST /api/agent/respond）本身不响 —— 响的是"它问话了"，不是"我答了"
 *   D 音源能在这台机器的真实浏览器里解码（decodeAudioData 拿得到时长）
 *     —— 路径错 / 文件损坏 / 格式不支持都会在这里挂掉，而单测的 Audio 是假的
 *   E 提问不弹 toast、不发系统通知（这一轮还没结束，面板就杵在输入框上方）
 *   F 页面无 console / page 错误（存量 rail.getBoundingClientRect 除外）
 *   G **等回答时**面板钉在输入框上方（消息列表之外），且是可交互的那版
 *   H **作答之后**钉的那块消失 —— 不再一直占着屏幕
 *   I 问答留档出现在**消息流里**（祖先链上有 .acu-message-list），收起成一行
 *   J 点它能展开回完整问题与选项
 *   K 「已回答」没被右边那串答案压成竖排（宽 > 高、与答案同排）
 *
 * 为什么拦 fetch 造合成 SSE，而不是真让模型调一次 ask_user：
 *   真跑一轮要几十秒、要花额度，且"模型这次会不会调 ask_user"本身不可控；
 *   这里要验的是「ask_user 帧 → 响一声 / 留档进消息流」这条链路，合成帧秒级且确定。
 *   帧的形状照抄服务端（见 agentChat.js 顶部的协议注释）：tool_call_start 带 arguments，
 *   ask_user 带问题，tool_result 带答案 —— 留档就是从前两个里还原出来的。
 *   拦 /api/agent/sessions 是因为会话列表为空时 AgentView 会走 newSession()，
 *   不拦的话第一轮跑完整个屏幕会被清掉（只见欢迎页）。
 *
 * 前置：vite dev server 已启动（5544）。其余接口仍走真实后端，所以后端也得活着。
 * 用法：node scripts/verify-agent-ask-sound.cjs
 * 退出码：0 全通过，1 有失败项。
 */
const path = require('node:path')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'

const TOOLCALL_ID = 'probe-ask-tc1'
const QUESTION = '探针：选一个'
const OPTIONS = ['甲', '乙']

const results = []
const consoleErrors = []
const pageErrors = []
/** 非 2xx 的响应 URL。用来把"资源加载失败"这类 console 错误归因到具体接口 */
const badUrls = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)

/** 存量红：库 MessageRail 里 rail.getBoundingClientRect 不是函数（与本轮改动无关） */
const isPreExistingError = (t) => /getBoundingClientRect is not a function/.test(String(t))

/**
 * "资源加载失败"这类 console 错误不带 URL，只能靠响应监听归因。
 * 只有**全部**失败响应都在 /api/agent/ 之外时才放行 —— 本轮的链路全在 /api/agent/ 下，
 * 别的接口（如开机建议那支 AI 调用）受模型环境影响，不该拿它判本轮的绿红。
 */
function isUnrelatedResourceError(text) {
  if (!/Failed to load resource/.test(String(text))) return false
  return badUrls.length > 0 && badUrls.every((u) => !u.includes('/api/agent/'))
}

async function main() {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

  page.on('console', (m) => {
    if (m.type() === 'error' && !isPreExistingError(m.text())) consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => {
    if (!isPreExistingError(e)) pageErrors.push(String(e))
  })
  page.on('response', (r) => {
    if (r.status() >= 400) badUrls.push(r.url())
  })

  // 合成 SSE + 记录 Audio 音源。addInitScript 保证在任何模块执行前就位
  await page.addInitScript(({ toolCallId, question, options }) => {
    window.__sounds = []
    window.__respondCalls = 0
    const RealAudio = window.Audio
    class RecordingAudio extends RealAudio {
      constructor(src) {
        super(src)
        window.__sounds.push(String(src))
      }
    }
    window.Audio = RecordingAudio

    const realFetch = window.fetch.bind(window)
    const enc = new TextEncoder()
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.includes('/api/agent/sessions')) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, sessions: [] }), {
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      if (url.includes('/api/agent/chat')) {
        const stream = new ReadableStream({
          start(c) {
            const send = (o) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
            window.__sseSend = send
            setTimeout(() => {
              send({ type: 'meta', sessionId: 'probe-ask-sound', title: '提问探针' })
              // 先来两次普通工具调用：这样工具组会折叠起来（阈值 2），用来验
              // "问答留档常驻在折叠组之外" 那条 —— 只有一次调用时压根不分组，验不到
              for (const [i, name] of ['list_files', 'search_text'].entries()) {
                send({
                  type: 'tool_call_start',
                  toolCallId: `probe-plain-${i}`,
                  name,
                  argsPreview: '{}',
                  arguments: '{}'
                })
                send({ type: 'tool_result', toolCallId: `probe-plain-${i}`, name, result: 'ok' })
              }
              send({
                type: 'tool_call_start',
                toolCallId,
                name: 'ask_user',
                argsPreview: JSON.stringify({ question }).slice(0, 200),
                arguments: JSON.stringify({ question, options, allow_free_text: false, multiple: false })
              })
              send({
                type: 'ask_user',
                interactionId: toolCallId,
                question,
                options,
                allowFreeText: false,
                multiple: false
              })
            }, 60)
            // 故意不 close：服务端就是这样挂着等回答的（见 agentRoutes 的 pendingInteractions）
          }
        })
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        }))
      }
      if (url.includes('/api/agent/respond')) {
        window.__respondCalls += 1
        // 真服务端答完就把答案作为 tool 结果回灌；这里照做，否则留档没东西可还原
        try {
          const body = JSON.parse(String((init && init.body) || '{}'))
          const answer = body.answer
          window.__sseSend?.({
            type: 'tool_result',
            toolCallId,
            name: 'ask_user',
            result: Array.isArray(answer) ? JSON.stringify(answer) : String(answer ?? '')
          })
        } catch { /* 解析不出来就只当提交成功 */ }
        return Promise.resolve(new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        }))
      }
      return realFetch(input, init)
    }
  }, { toolCallId: TOOLCALL_ID, question: QUESTION, options: OPTIONS })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // 切到智能体视图：ActivityBar 里 aria-label 是"智能体"的那个按钮
  const buttons = page.locator('.activity-btn')
  const n = await buttons.count()
  let clicked = false
  for (let i = 0; i < n; i++) {
    const label = (await buttons.nth(i).getAttribute('aria-label')) || ''
    if (/智能体|Agent/i.test(label)) {
      await buttons.nth(i).click()
      clicked = true
      break
    }
  }
  if (!clicked && n > 0) await buttons.nth(n - 1).click()
  await page.waitForTimeout(1200)

  const input = page.locator('.acu-input-textarea').first()
  await input.waitFor({ timeout: 20000 })
  await input.fill('探针：随便说句话，触发提问')
  await input.press('Enter')
  await page.waitForTimeout(2000)

  const sounds = await page.evaluate(() => window.__sounds.slice())

  // ── G 等回答时：面板钉在输入框上方，且可交互 ──
  const awaiting = await page.evaluate(() => {
    const pinned = document.querySelector('.acu-chat-question .acu-ask-user')
    return {
      pinnedExists: !!pinned,
      pinnedReadonly: pinned ? pinned.classList.contains('is-answered') : null,
      inlineCount: document.querySelectorAll('.acu-message-list .acu-ask-user').length
    }
  })
  check('A 响的是 /sounds/task-question.wav', sounds.includes('/sounds/task-question.wav'), JSON.stringify(sounds))
  check('B 不是终态那两声', !sounds.includes('/sounds/task-done.wav') && !sounds.includes('/sounds/task-error.wav'), JSON.stringify(sounds))
  check('G 等回答时面板钉在输入框上方且可交互',
    awaiting.pinnedExists && awaiting.pinnedReadonly === false, JSON.stringify(awaiting))
  check('G 等回答时消息流里还没有留档（不重复画）',
    awaiting.inlineCount === 0, JSON.stringify(awaiting))

  await page.screenshot({ path: 'tmp-verify-agent-ask-awaiting.png' })

  // ── 作答 ──
  await page.locator('.acu-chat-question .acu-ask-user-option').first().click()
  await page.waitForTimeout(1500)

  const after = await page.evaluate(() => {
    const pinned = document.querySelector('.acu-chat-question .acu-ask-user')
    const inline = document.querySelector('.acu-message-list .acu-ask-user')
    const box = (el) => {
      const b = el.getBoundingClientRect()
      return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }
    }
    const label = inline?.querySelector('.acu-ask-user-title-text')
    const ans = inline?.querySelector('.acu-ask-user-title-answer')
    return {
      responds: window.__respondCalls,
      sounds: window.__sounds.slice(),
      pinnedExists: !!pinned,
      inlineExists: !!inline,
      inlineInMessageList: !!inline?.closest('.acu-message-list'),
      inlineCollapsed: inline ? inline.classList.contains('is-collapsed') : null,
      inlineHasOptions: inline ? !!inline.querySelector('.acu-ask-user-options') : null,
      inlineHeight: inline ? Math.round(inline.getBoundingClientRect().height) : null,
      inlineTitle: (inline?.querySelector('.acu-ask-user-title')?.innerText || '').replace(/\n/g, '|'),
      label: label ? box(label) : null,
      answer: ans ? box(ans) : null
    }
  })

  check('C 作答本身不响（仍只有一声）',
    after.responds === 1 && after.sounds.filter((s) => s.includes('task-question')).length === 1,
    JSON.stringify({ responds: after.responds, sounds: after.sounds }))
  check('H 作答后钉着的那块消失', !after.pinnedExists, JSON.stringify({ pinnedExists: after.pinnedExists }))
  check('I 留档出现在消息流里（祖先链上有 .acu-message-list）',
    after.inlineExists && after.inlineInMessageList, JSON.stringify(after))
  // 工具组折叠 ≠ 问答被折进去：它和任务计划一样是常驻的
  const group = await page.evaluate(() => ({
    grouped: !!document.querySelector('.acu-toolgroup-header'),
    inlineVisible: (() => {
      const el = document.querySelector('.acu-message-list .acu-ask-user')
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })()
  }))
  check('L 工具组折叠着，问答留档照样看得见（常驻区）',
    group.grouped && group.inlineVisible, JSON.stringify(group))

  check('I 留档收起成一行（问题与选项都藏起来了）',
    after.inlineCollapsed === true && after.inlineHasOptions === false && after.inlineHeight < 60,
    JSON.stringify({ collapsed: after.inlineCollapsed, hasOptions: after.inlineHasOptions, h: after.inlineHeight }))
  // 「已回答」三个字被右边那串答案压到 min-content 时会竖着摞成一列：那三个字的盒子
  // 会变成"一列宽"且比答案高。判据量几何（宽 > 高、与答案同排、与答案同高），
  // 别数 innerText 的换行 —— flex 行里两个 span 的 innerText 本来就用 \n 分隔
  check('K 「已回答」没被压成竖排（一行内，与答案同排同高）',
    !!after.label && !!after.answer
      && after.label.w > after.label.h
      && Math.abs(after.label.top - after.answer.top) <= 2
      && Math.abs(after.label.h - after.answer.h) <= 2,
    JSON.stringify({ label: after.label, answer: after.answer, title: after.inlineTitle }))

  await page.screenshot({ path: 'tmp-verify-agent-ask-collapsed.png' })

  // ── J 展开 ──
  await page.locator('.acu-message-list .acu-ask-user-title.is-toggle').first().click()
  await page.waitForTimeout(400)
  const expanded = await page.evaluate(() => {
    const inline = document.querySelector('.acu-message-list .acu-ask-user')
    return {
      collapsed: inline.classList.contains('is-collapsed'),
      hasQuestion: !!inline.querySelector('.acu-ask-user-question'),
      hasOptions: !!inline.querySelector('.acu-ask-user-options')
    }
  })
  check('J 点它能展开回完整问题与选项',
    !expanded.collapsed && expanded.hasQuestion && expanded.hasOptions, JSON.stringify(expanded))
  await page.screenshot({ path: 'tmp-verify-agent-ask-expanded.png' })

  // ── D 音源能在真实浏览器里解码 ──
  const decoded = await page.evaluate(async () => {
    const buf = await (await fetch('/sounds/task-question.wav')).arrayBuffer()
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    try {
      const audio = await ctx.decodeAudioData(buf.slice(0))
      return { ok: true, duration: audio.duration }
    } catch (e) {
      return { ok: false, error: String(e) }
    } finally {
      ctx.close?.()
    }
  })
  check('D 音源可解码', decoded.ok && decoded.duration > 0.2 && decoded.duration < 2, JSON.stringify(decoded))

  // ── E 提问不弹 toast ──
  const toastCount = await page.locator('.el-message').count()
  check('E 提问不弹应用内提示条', toastCount === 0, `toast=${toastCount}`)

  const realConsoleErrors = consoleErrors.filter((t) => !isUnrelatedResourceError(t))
  check('F 无 console 错误', realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 3).join(' | ') || `（已放行与本轮无关的失败响应：${[...new Set(badUrls)].join(', ')}）`)
  check('F 无 page 错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  log(`${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[verify] 探针自身出错：', e)
  process.exit(1)
})
