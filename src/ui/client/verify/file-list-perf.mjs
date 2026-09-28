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
/**
 * 文件列表渲染性能探针 runner（真实 Chromium，无头）。
 *
 * 需要前端 dev server 已在跑（默认 127.0.0.1:5544，即 npm run dev:vue）。
 * 探针页面 /verify/file-list-perf.html 是 dev-only（vite build 只吃 index.html，
 * 不会进产物）。改完文件列表 / 文件树组件后跑一次，即可拿到
 * 「挂载 / 首帧 / 刷新重渲染 / DOM 节点数 / 滚到底滚到中间 / 交互」两组数字。
 *
 *   node verify/file-list-perf.mjs
 *   VITE_PORT=5544 N=8000 node verify/file-list-perf.mjs
 *   node verify/file-list-perf.mjs --json      # 只输出 JSON，便于脚本比对
 *
 * 退出码：功能断言（滚到底 / 滚到中间 / 点文件 / 折叠分组 / 目录展开折叠）不过 → 1；
 * 性能数字不设阈值（交人工比对），只打印。
 */
import { chromium } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const VITE_PORT = process.env.VITE_PORT || '5544'
const N = process.env.N || '5073'
const JSON_ONLY = process.argv.includes('--json')
const BASE = `http://127.0.0.1:${VITE_PORT}`
// 仓库根：脚本在 src/ui/client/verify/ → 上溯四级（client → ui → src → repo）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const SHOT_DIR = path.join(ROOT, '.tmp', 'file-list-perf')

function log(...a) {
  if (!JSON_ONLY) console.log(...a)
}

async function runScenario(browser, mode) {
  // 每个场景用独立 page/tab：上一场景残留的几千 DOM 节点会拖慢下一次导航
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  const url = `${BASE}/verify/file-list-perf.html?mode=${mode}&n=${N}`
  log(`\n→ ${mode}  n=${N}  ${url}`)
  // 只等 commit：vite dev 首次可能因依赖发现触发 full reload，等 load 会挂
  await page.goto(url, { waitUntil: 'commit', timeout: 120000 })
  await page.waitForFunction(() => window.__PERF__ && window.__PERF__.done, null, { timeout: 300000 })
  const perf = await page.evaluate(() => window.__PERF__)
  if (perf.error) throw new Error(`${mode} 探针报错:\n${perf.error}`)

  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shot = path.join(SHOT_DIR, `${mode}-${N}.png`)
  await page.screenshot({ path: shot })
  await ctx.close()
  return { ...perf, screenshot: shot, errors }
}

const COLUMNS = [
  'mode', 'n', 'buildTreeMs', 'mountMs', 'firstPaintMs', 'patchMs', 'domNodes',
  'renderedItems', 'totalRows', 'domNodesAfterScroll',
  'scrolledToBottom', 'midRowOk', 'fileClickOk', 'collapseOk', 'nodeToggleOk',
]

function printTable(rows) {
  const width = 20
  const head = COLUMNS.map((c) => c.padEnd(width)).join('')
  log('\n' + head)
  log('-'.repeat(head.length))
  for (const r of rows) log(COLUMNS.map((c) => String(r[c] ?? '-').padEnd(width)).join(''))
}

/** 功能断言：两个视图都必须成立（性能数字不判） */
function functionalFailures(r) {
  const bad = []
  if (!r.renderedItems || r.firstPaintMs == null) bad.push('未渲染出行')
  if (!r.scrolledToBottom) bad.push(`滚到底没渲染出 ${r.lastRowProbe}`)
  if (!r.midRowOk) bad.push(`滚到中间没渲染出 ${r.midRowProbe}`)
  if (!r.fileClickOk) bad.push('点文件行没有回调')
  if (!r.collapseOk) bad.push(`点标题行折叠失败（spacer=${r.collapsedSpacerHeight}）`)
  if (r.mode === 'tree' && !r.nodeToggleOk) bad.push(`点目录展开/折叠失败（${r.nodeToggleDetail}）`)
  return bad
}

;(async () => {
  const browser = await chromium.launch()
  const errors = []
  const results = []
  const failures = []

  try {
    for (const mode of ['list', 'tree']) {
      const r = await runScenario(browser, mode)
      errors.push(...r.errors)
      results.push(r)
      const bad = functionalFailures(r)
      if (bad.length) failures.push(`${mode}: ${bad.join('；')}`)

      // 每个场景跑完就报一次，避免后面的场景挂了前面的数字拿不到
      log(
        `   mount=${r.mountMs}ms  firstPaint=${r.firstPaintMs}ms  patch=${r.patchMs}ms  ` +
          `dom=${r.domNodes}  渲染行=${r.renderedItems}/${r.totalRows}  ` +
          `滚到底=${r.scrolledToBottom}  中间行=${r.midRowOk}  点文件=${r.fileClickOk}  ` +
          `折叠分组=${r.collapseOk}` +
          (r.mode === 'tree' ? `  目录展开折叠=${r.nodeToggleOk}（${r.nodeToggleDetail}）` : ''),
      )
    }
  } finally {
    await browser.close()
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ results, errors, failures }, null, 2))
  } else {
    printTable(results)
    log(`\n截图: ${results.map((r) => r.screenshot).join('  ')}`)
    if (errors.length) log(`\n页面错误 (${errors.length}):\n` + errors.slice(0, 10).join('\n'))
    else log('\n无页面错误')
  }

  if (failures.length) {
    log('\n功能断言失败:')
    for (const f of failures) log(' - ' + f)
    process.exit(1)
  }
})()
