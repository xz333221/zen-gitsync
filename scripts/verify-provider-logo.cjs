/**
 * 「设置 → AI 模型配置」已配置模型列表的服务商图标验证。
 *
 * 验收的行为契约（改这块 UI 时别破坏）：
 *   A 每张模型卡片左侧要显示服务商图标，取的是 `utils/providerLogo.ts` 那份映射
 *     （与底栏「默认模型」、ai-model-form 表单里接口地址左侧那颗同一套图标）。
 *   B 图标按 host 认，不是整串 URL 相等 —— 同一个域名换条路径（火山的
 *     /api/coding/v3 与 /api/plan/v3）仍要认出来；认不出的 host 不渲染图。
 *   C 单色图标跟着**实际渲染主题**（`<html data-theme>`）挑 dark/ 或 light/ 目录；
 *     `-color` 结尾的彩色图标固定走 dark/，不随主题变。
 *   D 图标是卡片里的一个 flex 项：在模型名左侧、与两行文字垂直居中，且真的是张
 *     加载成功的图（CDN 路径写错时 naturalWidth=0，光看 DOM 有 img 是看不出的）。
 *   E 浅色主题下不能白底白字 —— CDN 的 dark/ 目录放的是**白色**字形、light/ 放的是
 *     **黑色**字形（实测 luminance 255 vs 0），所以"单色图标跟着主题换目录"不是可选项：
 *     恒定走 dark/ 在浅色主题下整颗图标就消失了（本次实测踩到，截图里两行图标全空）。
 *     这条断言直接量两张图的实际亮度，映射写反 / 被"简化"掉都会红。
 *
 * 前置：dev server 已启动（npm run dev；前端 5544，后端 5545）。
 * 用法：
 *   node scripts/verify-provider-logo.cjs            # 正向
 *   node scripts/verify-provider-logo.cjs --reverse  # 反证：把 CDN 打成 404，D 必须变红
 * 退出码：0 全通过，1 有失败项。
 * 截图：默认写 os.tmpdir()，可用 ZEN_SHOT_DIR 覆盖。
 */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// playwright 装在 src/ui/client 下，这里把它的 node_modules 挂进解析路径，脚本可独立运行
module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://127.0.0.1:5544'
const REVERSE = process.argv.includes('--reverse')
const SHOT_DIR = process.env.ZEN_SHOT_DIR || path.join(os.tmpdir(), 'zen-provider-logo')
const CDN = 'https://cdn.jsdelivr.net/npm/@lobehub/icons-static-png'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const log = (...a) => console.log('[verify]', ...a)

// 固定夹具：不依赖真机上配了哪几个模型
const FIXTURE_MODELS = [
  // 彩色图标 + 火山域名下的第二条路径（B 项：同域不同路径也要认出来）
  { id: 'fx-volc', name: '火山-编码', baseURL: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'deepseek-v3', isDefault: true },
  // 单色图标（C 项：跟着主题换目录）
  { id: 'fx-cc', name: 'commandcode', baseURL: 'https://api.commandcode.ai/provider/v1', model: 'deepseek-v4.1-flash' },
  // 同一家的另一条路径，尾斜杠 + 多级路径
  { id: 'fx-openai', name: '本家', baseURL: 'https://api.openai.com/v1/', model: 'gpt-5' },
  // 认不出的 host（B 项反向）：不该渲染出图
  { id: 'fx-self', name: '自建', baseURL: 'https://llm.internal.example.com/v1', model: 'local-7b' },
]

/** 读卡片上的图标：src + 是否真加载出来 + 几何 */
async function readCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.model-card')]
    return cards.map((card) => {
      const img = card.querySelector('img.model-logo')
      const fallback = card.querySelector('.model-logo--fallback')
      const name = card.querySelector('.model-name')
      const info = card.querySelector('.model-info')
      const r = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: b.x, y: b.y, w: b.width, h: b.height, cy: b.y + b.height / 2, right: b.right }
      }
      return {
        name: name ? name.textContent.trim() : '',
        src: img ? img.getAttribute('src') : '',
        // 认不出服务商时的首字母砖（没有 img 时才有意义）
        fallback: fallback ? fallback.textContent.trim() : '',
        fallbackRect: r(fallback),
        // display:none（@error 兜底）时也算没展示出来
        visible: !!img && getComputedStyle(img).display !== 'none',
        naturalWidth: img ? img.naturalWidth : 0,
        imgRect: r(img),
        nameRect: r(name),
        infoRect: r(info),
      }
    })
  })
}

/** 等卡片上的图标全部解码完（CDN 是 640×640 的 png，切主题后要重新下载） */
async function waitLogosLoaded(page, timeout = 15000) {
  await page
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll('img.model-logo')]
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0)
      },
      null,
      { timeout }
    )
    .catch(() => {}) // 超时就交给下面的断言报红，别在这里抛
}

/** 把一张图标画进 canvas，量它不透明像素的平均亮度（白字形≈255，黑字形≈0） */
async function iconLuminance(page, url) {
  return page.evaluate(async (u) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = () => rej(new Error('load failed: ' + u))
      img.src = u
    })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let a = 0
    let lum = 0
    for (let i = 0; i < d.length; i += 4) {
      const al = d[i + 3] / 255
      a += al
      lum += al * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])
    }
    return a ? lum / a : -1
  }, url)
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  if (REVERSE) {
    // 反证：把 CDN 上的图标全打成 404。DOM 里 img 还在，但"真的加载出来了"必然变红。
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.fulfill({ status: 404, body: '' }))
    log('reverse 模式：CDN 图标一律 404')
  }

  // 只桩 models 字段，其余配置取真机的（直接造一份完整 config 会把别的面板带坏）
  await page.route('**/api/config/getConfig*', async (route) => {
    const resp = await route.fetch()
    const body = await resp.json().catch(() => ({}))
    body.models = FIXTURE_MODELS
    await route.fulfill({ response: resp, body: JSON.stringify(body) })
  })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.footer-model-hint', { timeout: 30000 })
  await page.click('.footer-model-hint')
  await page.waitForSelector('.model-card', { timeout: 15000 })
  await page.waitForTimeout(600) // 等 CDN 图解码完

  // 深色主题（夹具里 -color 与单色图标都在，便于对比 C 项）
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await waitLogosLoaded(page)
  const dark = await readCards(page)
  await page.screenshot({ path: path.join(SHOT_DIR, 'settings-model-list-dark.png') }).catch(() => {})

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await waitLogosLoaded(page)
  const light = await readCards(page)
  await page.screenshot({ path: path.join(SHOT_DIR, 'settings-model-list-light.png') }).catch(() => {})

  // E 项要量 CDN 上两套字形本身的亮度；reverse 模式下 CDN 被打成 404，量不了
  let darkLum = null
  let lightLum = null
  if (!REVERSE) {
    darkLum = await iconLuminance(page, `${CDN}/dark/commandcode.png`).catch(() => null)
    lightLum = await iconLuminance(page, `${CDN}/light/commandcode.png`).catch(() => null)
  }

  check('A 四张夹具卡片都渲染出来了', dark.length === 4, `实际 ${dark.length}`)

  const byName = (list, n) => list.find((c) => c.name === n) || {}
  const volcDark = byName(dark, '火山-编码')
  const ccDark = byName(dark, 'commandcode')
  const openaiDark = byName(dark, '本家')
  const selfDark = byName(dark, '自建')

  check('A 火山卡片的图标指向 volcengine-color', /\/dark\/volcengine-color\.png$/.test(volcDark.src || ''), volcDark.src)
  check('A commandcode 卡片有图标', /\/commandcode\.png$/.test(ccDark.src || ''), ccDark.src)

  check('B 同域名不同路径（/api/coding/v3）仍认得出服务商', !!volcDark.src)
  check('B 尾斜杠 + 多级路径（/provider/v1/）不影响识别', /\/commandcode\.png$/.test(ccDark.src || ''))
  check('B 认不出的 host 不渲染图标', !selfDark.src, `src=${selfDark.src || '(空)'}`)
  check('B 认不出的 host 退成首字母砖', selfDark.fallback === '自', `砖上的字=${selfDark.fallback || '(无)'}`)
  check(
    'B 首字母砖与图标左边距对齐（列表不塌边）',
    !!selfDark.fallbackRect && !!volcDark.imgRect && Math.abs(selfDark.fallbackRect.x - volcDark.imgRect.x) <= 0.5,
    selfDark.fallbackRect && volcDark.imgRect ? `砖.x=${selfDark.fallbackRect.x} 图.x=${volcDark.imgRect.x}` : 'no rect'
  )

  check('C 彩色图标固定 dark/ 目录（深色下）', (volcDark.src || '').includes('/dark/'))
  check('C 彩色图标不随主题变（浅色下仍是 dark/）', (byName(light, '火山-编码').src || '') === volcDark.src)
  check('C 单色图标深色下取 dark/', (ccDark.src || '').includes('/dark/commandcode.png'))
  check('C 单色图标浅色下换成 light/', (byName(light, 'commandcode').src || '').includes('/light/commandcode.png'))
  check('C openai 单色图标同样跟随主题', (byName(light, '本家').src || '').includes('/light/openai.png') && (openaiDark.src || '').includes('/dark/openai.png'))
  check(
    'E 浅色下的单色图标真的加载出来了（不是白底白字的空图）',
    (byName(light, 'commandcode').naturalWidth || 0) > 0 && (byName(light, '本家').naturalWidth || 0) > 0,
    `cc=${byName(light, 'commandcode').naturalWidth} openai=${byName(light, '本家').naturalWidth}`
  )
  if (!REVERSE) {
    check('E CDN dark/ 目录是白色字形（给深色主题用）', darkLum !== null && darkLum > 200, `lum=${darkLum === null ? 'n/a' : darkLum.toFixed(0)}`)
    check('E CDN light/ 目录是黑色字形（给浅色主题用）', lightLum !== null && lightLum < 60, `lum=${lightLum === null ? 'n/a' : lightLum.toFixed(0)}`)
  }

  check('D 图标真加载出来了（CDN 路径有效）', (volcDark.naturalWidth || 0) > 0 && (ccDark.naturalWidth || 0) > 0, `volc=${volcDark.naturalWidth} cc=${ccDark.naturalWidth}`)
  check('D 图标可见（没走 @error 兜底藏掉）', volcDark.visible === true && ccDark.visible === true)
  const g = volcDark.imgRect
  check('D 图标量到 20×20 的盒子', !!g && Math.abs(g.w - 20) <= 0.5 && Math.abs(g.h - 20) <= 0.5, g ? `${g.w}×${g.h}` : 'no rect')
  check('D 图标在模型名左侧', !!g && !!volcDark.nameRect && g.right <= volcDark.nameRect.x + 0.5, g && volcDark.nameRect ? `logo.right=${g.right} name.x=${volcDark.nameRect.x}` : 'no rect')
  check(
    'D 图标与两行文字块垂直居中（±2px）',
    !!g && !!volcDark.infoRect && Math.abs(g.cy - volcDark.infoRect.cy) <= 2,
    g && volcDark.infoRect ? `Δcy=${(g.cy - volcDark.infoRect.cy).toFixed(1)}` : 'no rect'
  )

  await browser.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n[verify] ${results.length - failed.length}/${results.length} 通过${REVERSE ? '（reverse 模式：D 项本该变红）' : ''}`)
  if (failed.length) console.log('[verify] 失败项：' + failed.map((f) => f.name).join(' | '))
  console.log(`[verify] 截图目录：${SHOT_DIR}`)
  process.exit(failed.length ? 1 : 0)
})().catch((err) => {
  console.error('[verify] 脚本异常：', err)
  process.exit(1)
})
