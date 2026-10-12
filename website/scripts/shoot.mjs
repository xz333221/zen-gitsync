/**
 * 官网视觉自检:构建产物起一个静态服务,用项目里已有的 Playwright 截图。
 * 用法:npm run build && node scripts/shoot.mjs
 * 产物落在 website/tmp-shots/(不入库)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const dist = path.join(root, 'website', 'dist')
const outDir = path.join(root, 'website', 'tmp-shots')

if (!fs.existsSync(dist)) {
  console.error('缺少 dist,请先 npm run build')
  process.exit(1)
}
fs.mkdirSync(outDir, { recursive: true })

// 复用主项目 src/ui/client 里已安装的 playwright(浏览器已下载)
const require = createRequire(path.join(root, 'src', 'ui', 'client', 'package.json'))
const { chromium } = require('playwright')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0])
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html'
  const file = path.join(dist, rel)
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch()
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'mobile', width: 390, height: 844 }
]

for (const vp of viewports) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1
  })
  const problems = []
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`))
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`))

  await page.goto(url, { waitUntil: 'load' })
  // 先滚一遍整页触发 scroll-reveal,再回到顶部等动效收尾
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8)
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 180))
    }
    window.scrollTo(0, document.body.scrollHeight)
    await new Promise((r) => setTimeout(r, 400))
    window.scrollTo(0, 0)
  })
  await page.waitForTimeout(1600)
  await page.screenshot({ path: path.join(outDir, `${vp.name}-fold.png`) })
  await page.screenshot({ path: path.join(outDir, `${vp.name}-full.png`), fullPage: true })

  const title = await page.title()
  console.log(`[${vp.name}] ${vp.width}x${vp.height} title="${title}"`)
  console.log(problems.length ? problems.map((p) => '  ! ' + p).join('\n') : '  ok,无控制台报错')
  await page.close()
}

await browser.close()
server.close()
console.log('截图输出:', outDir)
