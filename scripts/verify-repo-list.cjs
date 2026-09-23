/**
 * 「GitHub / Gitee 仓库」面板:排序 + 卡片元信息 的浏览器验收。
 *
 * 验收契约:
 *   P1 排序下拉渲染 4 个选项,默认值 = pushed
 *   P2 默认顺序 = **最近推送倒序**,且不同于 CLI 的字母序
 *      —— 两个平台的 CLI 顺序本来不一样(gh 按推送倒序 / gitee 按 full_name 字母序),
 *      这条断言就是为了证明"面板里统一过了",不是碰巧一致。
 *      ⚠️ 期望顺序按 **fullName** 排,不是 name:同一个账号下
 *      `xuze333221/vue` 和 `xz_web/HomePage` 按 name 排会得出完全不同的结果
 *      (这条写错过一次,报了个假 FAIL)。
 *   P3 每张卡片都有第三行元信息,含「更新于 YYYY-MM-DD」;有许可证的仓库要把许可证显示出来;
 *      Fork 数 > 0 才显示 Fork 数;默认分支是 main/master 时**不**显示分支
 *   P4 切换排序真的重排 DOM,切回去能回到原顺序(说明排的是副本,没改源数据)
 *   P5 搜索时头部提示变成「匹配 M / 共 N 个仓库」
 *   P6 明暗两套主题下,排序下拉与 option 的底色都必须是**不透明**的
 *      —— 原生下拉弹出层是独立画布,拿 select 自身的 background-color 当底色,
 *      半透明会叠在 UA 浅色兜底上 = 白底弹出层(见 styles/common.scss 的 select option 注释)
 *   P7 卡片高度容得下三行(在「不分组」下量 —— 分组态下没描述的卡片只有两行)
 *   P8 默认按工作空间分组:同一 owner 的仓库收拢在同一个容器里,组头写明空间名与数量,
 *      组内顺序仍跟随排序规则,组间顺序 = 组内最靠前的那个仓库的位次;
 *      只有一个空间时不渲染组头(那时它只是把每张卡片的前缀重复一遍)
 *
 * ⚠️ 排序断言(P2 / P4)一律在**不分组**下做:分组会把跨空间的全局顺序按空间收拢,
 *    在分组态下比全局序列必然对不上 —— 那是分组生效的证据,不是排序坏了。
 * ⚠️ 分组态下卡片第二行是**描述**(空间名已经在组头上,不再重复 fullName),
 *    所以拿 fullName 要从卡片的 title 取,不能从第二行取。
 *
 * ⚠️ 写这个脚本时踩的坑:判"不透明"时只匹配了 rgba() 的四段式,
 *    而浅色主题算出来是 `rgb(255, 255, 255)`(三段、本来就不透明)—— 被自己的正则判成 FAIL。
 *    三段 rgb() 一律视为不透明,别再写成"取最后一组数字当 alpha"。
 *
 * 前置:dev server 已启动(npm run dev,后端 5545 / 前端 5544),且 gh / gitee 已登录。
 * 用法:node scripts/verify-repo-list.cjs
 * 退出码:0 全通过,1 有失败项,2 脚本异常。
 */
const path = require('node:path')
const os = require('node:os')

module.paths.unshift(path.resolve(__dirname, '../src/ui/client/node_modules'))
const { chromium } = require('playwright')

const BASE = process.env.ZEN_BASE || 'http://localhost:5544'

const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  :: ' + extra : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** rgba(r,g,b,a) 与 rgb(r,g,b) —— 后者本来就不透明,不要拿最后一组数字当 alpha */
const isOpaque = (color) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(color)
  if (!m) return false
  const parts = m[1].split(',').map((s) => s.trim())
  return parts.length < 4 || Number(parts[3]) === 1
}

const byFullName = (a, b) => (a.fullName.toLowerCase() < b.fullName.toLowerCase() ? -1 : 1)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 950 } })
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await sleep(1500)
  await page.getByRole('tab', { name: 'Gitee 仓库' }).click()
  await page.waitForSelector('.repo-card', { timeout: 60000 })
  await sleep(500)

  // 服务端返回的顺序/字段 —— 真值来源,期望顺序都由它算出来
  const serverOrder = await page.evaluate(async () => {
    const res = await fetch('/api/remote-repos?provider=gitee', { cache: 'no-store' })
    const body = await res.json()
    return body.repos.map((r) => ({
      name: r.name,
      fullName: r.fullName,
      pushedAt: r.pushedAt,
      createdAt: r.createdAt,
      stars: r.stars,
      forks: r.forks,
      defaultBranch: r.defaultBranch,
      license: r.license,
    }))
  })
  console.log(`  服务端返回 ${serverOrder.length} 个仓库`)
  if (!serverOrder.length) {
    console.log('  (gitee 未登录或没有仓库,无法验收 —— 先完成 gitee auth login)')
    await browser.close()
    process.exit(2)
  }

  const domNames = () => page.$$eval('.repo-card__name-base', (els) => els.map((e) => e.textContent.trim()))

  // ── P1 排序控件 ────────────────────────────────────────────────────────
  const sortOptions = await page.$$eval('.repo-list__sort-select option', (els) => els.map((e) => e.textContent.trim()))
  check('P1 排序下拉渲染了 4 个选项', sortOptions.length === 4, sortOptions.join(' / '))
  const sortValue = await page.$eval('.repo-list__sort-select', (e) => e.value)
  check('P1 默认排序 = 最近推送', sortValue === 'pushed', `value=${sortValue}`)

  // ── P8 分组:同一工作空间(owner)下的仓库收拢在一起 ─────────────────────
  // 先验:此刻还是默认的分组态(DOM 就是首屏那张)
  const groupOptions = await page.$$eval('.repo-list__group-select option', (els) => els.map((e) => e.textContent.trim()))
  check('P8 分组下拉渲染了 2 个选项', groupOptions.length === 2, groupOptions.join(' / '))
  const groupValue = await page.$eval('.repo-list__group-select', (e) => e.value)
  check('P8 默认分组 = 按工作空间', groupValue === 'workspace', `value=${groupValue}`)

  const owners = [...new Set(serverOrder.map((r) => r.fullName.split('/')[0]))]
  const domGroups = await page.$$eval('.repo-group', (sections) => sections.map((s) => ({
    owner: s.querySelector('.repo-group__owner')?.textContent.trim() ?? '',
    count: s.querySelector('.repo-group__count')?.textContent.trim() ?? '',
    // 分组态下卡片第二行是描述,拿 fullName 得从 title(第一行就是)
    repos: [...s.querySelectorAll('.repo-card')].map((c) => (c.getAttribute('title') || '').split('\n')[0]),
  })))
  check('P8 每个空间一个分组', domGroups.length === owners.length,
    `${domGroups.length} 组 / 数据里 ${owners.length} 个空间`)

  if (owners.length > 1) {
    // "收拢"的字面含义:一个分组里不能混进别的空间的仓库
    const mixed = domGroups.filter((g) => g.repos.some((f) => f.split('/')[0] !== g.owner))
    check('P8 没有跨空间混装的分组', mixed.length === 0, mixed.map((g) => g.owner).join(', '))
    check('P8 组头数量 = 组内卡片数',
      domGroups.every((g) => Number(g.count) === g.repos.length),
      domGroups.map((g) => `${g.owner}:${g.count}/${g.repos.length}`).join(' '))
  } else {
    // 只有一个空间时组头是纯噪音,不该出现
    check('P8 只有一个空间时不渲染组头', domGroups.length === 1 && domGroups[0].owner === '',
      `owner="${domGroups[0]?.owner}"`)
  }

  const groupOrderOk = domGroups.every((g) => {
    const expected = serverOrder
      .filter((r) => r.fullName.split('/')[0] === g.owner)
      .sort((a, b) => Date.parse(b.pushedAt || 0) - Date.parse(a.pushedAt || 0) || byFullName(a, b))
      .map((r) => r.fullName)
    return JSON.stringify(expected) === JSON.stringify(g.repos)
  })
  check('P8 组内顺序 = 最近推送倒序(分组没有打乱组内排序)', groupOrderOk,
    domGroups.map((g) => `${g.owner}[${g.repos.length}]`).join(' '))

  // 组间顺序 = 组内排最前的那个仓库的位次 —— "最近有推送的空间排前面"
  const domGroupOwners = domGroups.map((g) => g.owner)
  const expectedGroupOwners = [...owners].sort((a, b) => {
    const first = (owner) => {
      const list = serverOrder.filter((r) => r.fullName.split('/')[0] === owner)
      return list.sort((x, y) => Date.parse(y.pushedAt || 0) - Date.parse(x.pushedAt || 0) || byFullName(x, y))[0]
    }
    const fa = first(a)
    const fb = first(b)
    return Date.parse(fb.pushedAt || 0) - Date.parse(fa.pushedAt || 0) || byFullName(fa, fb)
  })
  check('P8 组间顺序 = 组内最靠前的仓库的位次', JSON.stringify(domGroupOwners) === JSON.stringify(expectedGroupOwners),
    domGroupOwners.join(', '))

  // ── P2 默认顺序 = pushedAt 倒序(不分组下比全局序列) ────────────────────
  await page.selectOption('.repo-list__group-select', 'none')
  await sleep(300)
  const expectedPushed = [...serverOrder]
    .sort((a, b) => Date.parse(b.pushedAt || 0) - Date.parse(a.pushedAt || 0) || byFullName(a, b))
    .map((r) => r.name)
  const alphabetical = [...serverOrder].sort(byFullName).map((r) => r.name)
  const domPushed = await domNames()
  check('P2 默认顺序 = 最近推送倒序', JSON.stringify(domPushed) === JSON.stringify(expectedPushed),
    `前 5: ${domPushed.slice(0, 5).join(', ')}`)
  check('P2 默认顺序不同于字母序(排序真的生效了,不是碰巧)',
    JSON.stringify(domPushed) !== JSON.stringify(alphabetical))

  // ── P3 卡片第三行元信息 ────────────────────────────────────────────────
  const cardCount = (await page.$$('.repo-card')).length
  const metas = await page.$$eval('.repo-card__meta', (els) => els.map((e) => e.textContent.trim()))
  check('P3 每张卡片都有元信息行', metas.length === cardCount, `meta ${metas.length} / 卡片 ${cardCount}`)
  console.log('      样例: ' + metas.slice(0, 3).map((m) => `「${m}」`).join('  '))
  check('P3 元信息含「更新于 YYYY-MM-DD」', metas.every((m) => /^更新于 \d{4}-\d{2}-\d{2}/.test(m)), metas[0])
  const licensed = serverOrder.find((r) => r.license)
  check('P3 许可证显示出来了',
    !licensed || metas.some((m) => m.includes(licensed.license)),
    licensed ? `含 ${licensed.name}(${licensed.license})` : '(列表里没有带许可证的仓库)')
  const forked = serverOrder.find((r) => r.forks > 0)
  // ⚠️ 别用 m.includes('0 个 Fork') 判"显示了 0 个 Fork":`40 个 Fork` 也包含这个子串,
  //    会报假 FAIL(已踩)。元信息是 ' · ' 拼起来的,所以要求 0 前面是开头或分隔符。
  check('P3 Fork 数 > 0 时显示 Fork 数,为 0 时整段省略',
    (!forked || metas.some((m) => m.includes(`${forked.forks} 个 Fork`)))
    && !metas.some((m) => /(?:^|[ ·])0 个 Fork/.test(m)),
    forked ? `含 ${forked.name}(${forked.forks})` : '(列表里没有 fork 数 > 0 的仓库)')
  const oddBranch = serverOrder.find((r) => r.defaultBranch && !['main', 'master'].includes(r.defaultBranch))
  check('P3 非 main/master 才显示分支',
    !metas.some((m) => /分支 (main|master)\b/.test(m))
    && (!oddBranch || metas.some((m) => m.includes(`分支 ${oddBranch.defaultBranch}`))),
    oddBranch ? `含 ${oddBranch.name}(${oddBranch.defaultBranch})` : '(没有非默认分支的仓库)')

  // ── P4 排序切换 ────────────────────────────────────────────────────────
  await page.selectOption('.repo-list__sort-select', 'name')
  await sleep(300)
  check('P4 切到「仓库名」= 字母序',
    JSON.stringify(await domNames()) === JSON.stringify(alphabetical),
    `前 3: ${(await domNames()).slice(0, 3).join(', ')}`)

  const expectedStars = [...serverOrder]
    .sort((a, b) => (b.stars || 0) - (a.stars || 0) || byFullName(a, b))
    .map((r) => r.name)
  await page.selectOption('.repo-list__sort-select', 'stars')
  await sleep(300)
  check('P4 切到「星标最多」= 星标倒序(全 0 时退化成名称序)',
    JSON.stringify(await domNames()) === JSON.stringify(expectedStars))

  const expectedCreated = [...serverOrder]
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0) || byFullName(a, b))
    .map((r) => r.name)
  await page.selectOption('.repo-list__sort-select', 'created')
  await sleep(300)
  check('P4 切到「最近创建」= 创建时间倒序',
    JSON.stringify(await domNames()) === JSON.stringify(expectedCreated))

  await page.selectOption('.repo-list__sort-select', 'pushed')
  await sleep(300)
  check('P4 切回「最近推送」恢复原顺序', JSON.stringify(await domNames()) === JSON.stringify(domPushed))

  // ── P5 搜索提示 ────────────────────────────────────────────────────────
  await page.fill('.repo-list__search-input', 'web')
  await sleep(400)
  const hint = await page.$eval('.repo-list__hint', (e) => e.textContent.trim())
  const shown = (await domNames()).length
  check('P5 搜索时提示「匹配 M / 共 N 个仓库」', hint === `匹配 ${shown} / 共 ${serverOrder.length} 个仓库`, hint)
  await page.fill('.repo-list__search-input', '')
  await sleep(300)

  // ── P6 下拉弹出层的底色(明暗两套主题) ─────────────────────────────────
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark')
      else document.documentElement.removeAttribute('data-theme')
    }, theme)
    await sleep(200)
    const colors = await page.evaluate(() => {
      // 两个下拉(分组 / 排序)共用同一条样式规则,但分别取一遍 ——
      // 哪天分组那个被拆出去单独写样式,这条能立刻发现
      const pick = (sel) => {
        const select = document.querySelector(sel)
        const option = document.querySelector(`${sel} option`)
        return {
          select: getComputedStyle(select).backgroundColor,
          option: getComputedStyle(option).backgroundColor,
          optionText: getComputedStyle(option).color,
        }
      }
      return { sort: pick('.repo-list__sort-select'), group: pick('.repo-list__group-select') }
    })
    check(`P6 ${theme} 主题:排序下拉底色不透明(弹出层不会叠在白底上)`, isOpaque(colors.sort.select), colors.sort.select)
    check(`P6 ${theme} 主题:option 底色不透明且与文字色不同`,
      isOpaque(colors.sort.option) && colors.sort.option !== colors.sort.optionText,
      `option ${colors.sort.option} / 文字 ${colors.sort.optionText}`)
    check(`P6 ${theme} 主题:分组下拉同款底色`,
      isOpaque(colors.group.select) && isOpaque(colors.group.option),
      `${colors.group.select} / option ${colors.group.option}`)
  }
  // 只改 DOM 属性,不落盘、不碰用户配置
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await sleep(200)

  // ── P7 卡片高度(不分组下量:分组态里没描述的卡片只有两行,量不出三行) ────
  const box = await (await page.$('.repo-card')).boundingBox()
  check('P7 卡片高度容得下三行', box.height >= 56, `${box.height}px`)

  // ── 截图存证 ───────────────────────────────────────────────────────────
  const shotDir = process.env.ZEN_SHOT_DIR || os.tmpdir()
  await page.selectOption('.repo-list__group-select', 'workspace')
  await sleep(400)
  await page.screenshot({ path: path.join(shotDir, 'repolist-grouped.png') })
  await page.selectOption('.repo-list__group-select', 'none')
  await sleep(300)
  await page.screenshot({ path: path.join(shotDir, 'repolist-sorted.png') })
  await page.fill('.repo-list__search-input', 'book')
  await sleep(400)
  await page.screenshot({ path: path.join(shotDir, 'repolist-search.png') })
  console.log(`  截图: ${path.join(shotDir, 'repolist-grouped.png')} / repolist-sorted.png / repolist-search.png`)
  check('  页面无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  await browser.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n通过 ${results.length - failed.length}/${results.length}`)
  process.exit(failed.length ? 1 : 0)
})().catch((error) => {
  console.error('脚本异常:', error)
  process.exit(2)
})
