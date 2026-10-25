/**
 * 右下角 g ai dock（AgentView）输入框工具条「当前分支 + 默认模型」展示的验证。
 *
 * 为什么要有这个：
 *   工作台 g ai 面板自 66034b76 起，输入框工具条就有分支 + 默认模型两片；
 *   对话页（AgentView）的 ChatContainer 一直没传这两个 prop，用户 2026-10-15
 *   反馈"对话页没显示出分支和模型"。本探针钉住补上之后的契约，防回归。
 *   2026-10 AI 入口整合：原「文件空间 g ai 面板」宿主（自己摆的 ChatInput）
 *   随编辑器 AI 面板并入 dock 移除，那份同契约的实地检查一并收编到这里。
 *   数据口径与主 Agent 控制台的派发栏 / App.vue 底栏一致：分支读 gitStore.currentBranch，
 *   模型读设置里标了「默认」的那一条（name || model），库只排版不猜。
 *
 * 验收契约（改这块时别破坏）：
 *   对话页：
 *     A1 分支片 `.acu-input-chip.is-git` 可见，文本 == 后端 /api/branch 的 branch
 *     A2 模型片 `.acu-input-chip.is-model` 可见，文本 == 后端默认模型的 name||model
 *        （期望值为空时该片必须不渲染 —— 库的约定是"不传则不渲染"，没有占位）
 *     A3 无 pageerror
 * 反向（--reverse）：注入 `.acu-input-chip{display:none!important}` 后
 *   R1/R2 必须翻红，且芯片仍在 DOM 里
 *   （证明是 CSS 藏掉的、不是数据没到）—— 没有这个反证，"可见"断言可能恒绿。
 *
 * 前置：dev server 已起（后端 5545 / 前端 5544）；当前目录是 git 仓库、
 * 设置里有默认模型（否则正向组退化成"必须不渲染"、反向组无可反证，exit 2）。
 * 用法：node scripts/verify-agent-input-facts.cjs
 *       node scripts/verify-agent-input-facts.cjs --reverse
 * 退出码：0 全通过；1 有失败项；2 环境没起 / 前置不足。
 */
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const REVERSE = process.argv.includes('--reverse')

// playwright 装在 src/ui/client 下，把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const API = process.env.ZEN_API || 'http://127.0.0.1:5545'

const results = []
const pageErrors = []

function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) return null
  return res.json().catch(() => null)
}

/** 期望值：分支走 /api/branch（git symbolic-ref，非仓库时 500 → 空）；模型走 config 的 isDefault */
async function expectedFacts() {
  const branchRes = await getJson(`${API}/api/branch`)
  const branch = branchRes?.branch || ''
  const config = await getJson(`${API}/api/config/getConfig`)
  const def = (config?.models || []).find(m => m.isDefault)
  const model = def ? (def.name || def.model || '') : ''
  return { branch, model }
}

/** 点开右下角 g ai dock 并等到对话输入框就绪（AI 入口 2026-10 整合为悬浮 dock） */
async function openAgentView(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-body', { timeout: 60000 })
  await page.click('.agent-dock__mascot')
  await page.waitForSelector('.agent-view', { timeout: 30000 })
  await page.waitForSelector('.acu-input-textarea', { timeout: 30000 })
}

/** 读工具条上那两片：返回 { git: {exists, visible, text}, model: {...} }。scope 传宿主选择器 */
async function readChips(page, scope = '') {
  return page.evaluate((sc) => {
    const read = (sel) => {
      const el = document.querySelector((sc ? sc + ' ' : '') + sel)
      if (!el) return { exists: false, visible: false, text: '' }
      return { exists: true, visible: !!el.offsetParent, text: (el.textContent || '').trim() }
    }
    return { git: read('.acu-input-chip.is-git'), model: read('.acu-input-chip.is-model') }
  }, scope)
}

async function browserChecks(facts) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)))

    if (REVERSE) {
      // 反证：把两片芯片整体藏掉（!important 压过库的 display:flex），
      // 数据链路不动 —— 芯片还在 DOM 里，只是看不见。
      await page.addInitScript(() => {
        const style = document.createElement('style')
        style.textContent = '.acu-input-chip { display: none !important; }'
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style))
      })
    }

    await openAgentView(page)
    await sleep(500) // 等工具条渲染稳定（输入框就绪时两片是同步渲染的，这点余量是防慢机器）
    const chips = await readChips(page)

    if (REVERSE) {
      // R1/R2：芯片必须还在 DOM 里（数据/ prop 链路没断）但不可见（被 CSS 藏了）
      // —— 只断言"不可见"不够：产品代码真坏了（没传 prop）也会不可见，那是恒绿。
      check('R1 分支片被 CSS 藏掉后不可见（且仍在 DOM）',
        chips.git.exists && !chips.git.visible,
        `exists=${chips.git.exists} visible=${chips.git.visible} text=${chips.git.text}`)
      check('R2 模型片被 CSS 藏掉后不可见（且仍在 DOM）',
        chips.model.exists && !chips.model.visible,
        `exists=${chips.model.exists} visible=${chips.model.visible} text=${chips.model.text}`)
    } else {
      // A1/A2：期望值非空 → 必须可见且文本一致；为空 → 必须不渲染（无占位）
      check(`A1 分支片可见且为「${facts.branch || '（空，应不渲染）'}」`,
        facts.branch
          ? (chips.git.visible && chips.git.text === facts.branch)
          : !chips.git.visible,
        `visible=${chips.git.visible} text=${chips.git.text}`)
      check(`A2 模型片可见且为「${facts.model || '（空，应不渲染）'}」`,
        facts.model
          ? (chips.model.visible && chips.model.text === facts.model)
          : !chips.model.visible,
        `visible=${chips.model.visible} text=${chips.model.text}`)
      check('A3 对话页无 pageerror', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

// ══════════════════════════════════════════════════════════════
;(async () => {
  let facts
  try {
    facts = await expectedFacts()
  } catch (err) {
    console.error(`前置不足：后端没起？${err?.message || err}`)
    process.exit(2)
  }
  log('期望值：', JSON.stringify(facts))

  if (REVERSE && (!facts.branch || !facts.model)) {
    console.error('前置不足：反向组需要非空的分支与默认模型（否则无可反证），当前：'
      + JSON.stringify(facts))
    process.exit(2)
  }

  await browserChecks(facts)

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    for (const f of failed) console.error(`  FAIL  ${f.name}${f.extra ? '  :: ' + f.extra : ''}`)
    process.exit(1)
  }
  console.log(REVERSE
    ? '反证通过：对话页的两片芯片都如期翻红'
    : '通过：dock 对话页输入框工具条展示了分支与默认模型')
  process.exit(0)
})().catch((err) => {
  console.error('[verify] 异常:', err?.stack || err)
  process.exit(1)
})
