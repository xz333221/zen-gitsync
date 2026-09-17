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
// e2e: Ctrl+点击常用目录用新标签打开
// 准备: 先 node server.js 启后端,再 npm run dev 启 vite,最后 npx playwright test

import { test, expect, type Page } from '@playwright/test'

// 常用目录卡片是异步拉取 /api/recent_directories 后才渲染的,
// 直接 count() 会拿到 0 导致后续断言被 test.skip 静默跳过(历史问题)。
// 统一走这个 helper:等首张卡片出现,拿不到就返回 0 交给调用方 skip。
// 超时给到 25s:刚改过前端代码时 vite 要重新编译整个 app,首次导航实测能超过 15s,
// 于是 count() 读到 0 → 整条用例变 skipped,看起来"通过"其实啥也没验(本文件已踩过三次)。
async function countDirectoryCards(page: Page): Promise<number> {
  const cards = page.locator('.dir-card')
  await cards.first().waitFor({ state: 'visible', timeout: 25_000 }).catch(() => {})
  return cards.count()
}

test.describe('DirectorySelector - Ctrl+点击新标签', () => {
  test('页面能正常加载', async ({ page }) => {
    await page.goto('/')
    // 等 vite 编译完成,主容器出现
    await expect(page.locator('body')).toBeVisible()
  })

  test('打开切换目录弹窗,显示常用目录', async ({ page }) => {
    await page.goto('/')

    // 等待目录选择器组件出现
    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 10_000 })

    // 点击它打开弹窗
    await dirDisplay.click()

    // 弹窗应该出现,标题"切换工作目录"
    const dialogTitle = page.locator('text=切换工作目录').first()
    await expect(dialogTitle).toBeVisible({ timeout: 5_000 })

    // 至少有一个常用目录项(假设有历史记录)
    // 这里不强制 assert,只检查 DOM 结构
    const count = await countDirectoryCards(page)
    console.log(`找到 ${count} 个常用目录`)

    if (count > 0) {
      // 第一个目录项的 title 应包含"按住 Ctrl 点击用新标签打开"或"按住 ⌘ 点击"
      const firstItem = page.locator('.dir-card').first()
      const title = await firstItem.getAttribute('title')
      expect(title).toMatch(/按住 (Ctrl|⌘) 点击用新标签打开/)

      // 与"最近项目"共用的卡片结构:目录名 + 完整路径两行都要渲染出来
      await expect(firstItem.locator('.dir-card__name-base')).toBeVisible()
      await expect(firstItem.locator('.dir-card__name-path')).toBeVisible()
    }
  })

  test('Ctrl+点击触发 open-new-tab-gui API 而不是 change_directory', async ({ page }) => {
    await page.goto('/')

    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 10_000 })
    await dirDisplay.click()

    const count = await countDirectoryCards(page)
    test.skip(count === 0, '没有常用目录,跳过此测试')
    const recentDirs = page.locator('.dir-card')

    // 监听 API 请求
    const apiCalls: { url: string; postData: string | null }[] = []
    page.on('request', req => {
      if (req.url().includes('/api/')) {
        apiCalls.push({ url: req.url(), postData: req.postData() })
      }
    })

    // Ctrl + 点击第一个常用目录
    const firstItem = recentDirs.first()
    await firstItem.click({ modifiers: ['Control'] })

    // 等一会儿,让 fetch 完成
    await page.waitForTimeout(500)

    // 应该只调用了 open-new-tab-gui,没有调用 change_directory
    const newTabCall = apiCalls.find(c => c.url.includes('open-new-tab-gui'))
    const changeDirCall = apiCalls.find(c => c.url.includes('change_directory'))

    expect(newTabCall, '应调用 open-new-tab-gui').toBeTruthy()
    expect(changeDirCall, '不应调用 change_directory').toBeFalsy()
  })

  test('普通点击填充输入框,不触发 API', async ({ page }) => {
    await page.goto('/')

    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 10_000 })
    await dirDisplay.click()

    const count = await countDirectoryCards(page)
    test.skip(count === 0, '没有常用目录,跳过此测试')

    // 监听 API 请求
    let apiCalled = false
    page.on('request', req => {
      if (req.url().includes('/api/open-new-tab-gui') || req.url().includes('/api/change_directory')) {
        apiCalled = true
      }
    })

    // 普通点击(点卡片主体按钮,而不是 li 中心,避免误命中右侧操作按钮)
    const firstCard = page.locator('.dir-card').first()
    const expected = await firstCard.locator('.dir-card__name-path').innerText()
    await firstCard.locator('.dir-card__btn').click()

    await page.waitForTimeout(300)

    // 不应调用任何变更 API
    expect(apiCalled, '普通点击不应触发 API').toBe(false)

    // 输入框应该被回填为该卡片的路径
    const input = page.locator('.modern-input input')
    const value = await input.inputValue()
    expect(value).toBe(expected.trim())
  })

  // 回归:用户反馈"弹窗太小、看到的项目太少" —— 保证弹窗够宽(≥ 窗口的 90%,上限 1040),
  // 卡片排成两列,且滚动只发生在列表内部(弹窗 body 不能出现二级滚动条,
  // 否则路径输入框和底部按钮会被顶出视口)
  test('弹窗尺寸与两列网格:滚动只发生在列表内部', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 790 })
    await page.goto('/')
    await expect(page.locator('.directory-display')).toBeVisible({ timeout: 10_000 })
    await page.locator('.directory-display').click()
    await page.locator('.directory-dialog').waitFor({ timeout: 8_000 })

    const count = await countDirectoryCards(page)
    test.skip(count === 0, '没有常用目录,跳过此测试')

    const m = await page.evaluate(() => {
      const dlg = document.querySelector('.directory-dialog') as HTMLElement
      const body = dlg.querySelector('.el-dialog__body') as HTMLElement
      const list = dlg.querySelector('.dir-list__items') as HTMLElement
      const cols = getComputedStyle(list).gridTemplateColumns.trim().split(/\s+/)
      const listBox = list.getBoundingClientRect()
      const fully = [...dlg.querySelectorAll('.dir-card')].filter(c => {
        const r = c.getBoundingClientRect()
        return r.top >= listBox.top - 1 && r.bottom <= listBox.bottom + 1
      }).length
      return {
        dialogW: Math.round(dlg.getBoundingClientRect().width),
        dialogH: Math.round(dlg.getBoundingClientRect().height),
        bodyScroll: body.scrollHeight - body.clientHeight,
        cols: cols.length,
        colWidth: Math.round(parseFloat(cols[0])),
        fullyVisible: fully,
        truncated: [...dlg.querySelectorAll('.dir-card__name-path')].filter(p => p.scrollWidth > p.clientWidth + 1).length,
      }
    })

    expect(m.dialogW).toBeGreaterThanOrEqual(Math.min(1040, 1400 * 0.9) - 1)
    expect(m.dialogH).toBeGreaterThanOrEqual(700)          // 790 视口下接近满高
    expect(m.bodyScroll).toBeLessThanOrEqual(1)            // 无二级滚动条
    expect(m.cols).toBeGreaterThanOrEqual(2)               // 两列
    expect(m.colWidth).toBeGreaterThanOrEqual(380)         // 每列够宽,路径不被省略号截断
    expect(m.truncated).toBe(0)
    expect(m.fullyVisible).toBeGreaterThanOrEqual(12)      // 一屏至少看到 12 个
  })

  // Git 状态徽标:哪些是 Git 目录、有几个未提交项。
  // 探测走 /api/recent_directories/git-state,这个端点在组件里只有 loadGitStates() 一个调用方、
  // 也没有 socket 广播回写,所以可以安全 stub(对比:目录列表本身是 HTTP + socket 双通道,
  // 只 stub 一路会被广播刷回真实值 —— 见 e2e/commit-flow.spec.ts 顶部说明)。
  // stub 而不是依赖本机真实仓库:真实仓库的 staged/unstaged 数在跑测试时会变,断言必然不稳。
  test('卡片徽标:未提交 / 领先 / 落后 / Git / 非 Git 仓库,探不到则不显示', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 790 })

    // 按请求体里的 paths 顺序造状态,覆盖所有徽标分支:
    //   0 → 脏 + 领先 4 + 落后 17(三徽标同时在,最挤的情况)
    //   1 → 干净且与上游同步(应只显示中性的 Git 标签)
    //   2 → 非仓库
    //   3+ → isGitRepo=null(模拟探测超时)→ 一个徽标都不许有,更不能谎报"非 Git 仓库"
    await page.route('**/api/recent_directories/git-state', async route => {
      const body = JSON.parse(route.request().postData() || '{}')
      const results: Record<string, unknown> = {}
      const base = {
        exists: true, isGitRepo: true,
        changed: 0, staged: 0, unstaged: 0, untracked: 0,
        branch: 'develop', upstream: 'origin/develop', hasUpstream: true, detached: false,
        ahead: 0, behind: 0,
      }
      ;(body.paths ?? []).forEach((p: string, i: number) => {
        if (i === 0) results[p] = { ...base, changed: 3, staged: 1, unstaged: 1, untracked: 1, ahead: 4, behind: 17 }
        else if (i === 1) results[p] = { ...base }
        else if (i === 2) results[p] = { ...base, isGitRepo: false, branch: null, upstream: null, hasUpstream: false }
        else results[p] = { ...base, isGitRepo: null }
      })
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, results }),
      })
    })

    await page.goto('/')
    await expect(page.locator('.directory-display')).toBeVisible({ timeout: 10_000 })
    await page.locator('.directory-display').click()
    await page.locator('.directory-dialog').waitFor({ timeout: 8_000 })

    const count = await countDirectoryCards(page)
    test.skip(count === 0, '没有常用目录,跳过此测试')
    test.skip(count < 3, '常用目录少于 3 个,无法构造三种状态')

    const cards = page.locator('.directory-dialog .dir-card')

    // ① 三徽标同时在:未提交 / 领先 / 落后,明细都进悬浮提示
    await expect(cards.nth(0).locator('.dir-card__tag--dirty')).toHaveText('未提交 3 项')
    await expect(cards.nth(0).locator('.dir-card__tag--ahead')).toHaveText('领先 4')
    await expect(cards.nth(0).locator('.dir-card__tag--behind')).toHaveText('落后 17')
    const busyTitle = await cards.nth(0).getAttribute('title')
    expect(busyTitle).toContain('已暂存 1 · 未暂存 1 · 未跟踪 1')
    expect(busyTitle).toContain('领先 origin/develop 4 个提交')
    expect(busyTitle).toContain('落后 origin/develop 17 个提交')
    // 有具体信号时不再挂那个中性的 Git 标签 —— 它只会白占宽度
    await expect(cards.nth(0).locator('.dir-card__tag--git')).toHaveCount(0)

    // ② 干净且与上游同步:只有 Git 标签,不该出现"未提交 0 项 / 领先 0 / 落后 0"这种噪音
    await expect(cards.nth(1).locator('.dir-card__tag--git')).toHaveText('Git')
    await expect(cards.nth(1).locator('.dir-card__tag--dirty')).toHaveCount(0)
    await expect(cards.nth(1).locator('.dir-card__tag--ahead')).toHaveCount(0)
    await expect(cards.nth(1).locator('.dir-card__tag--behind')).toHaveCount(0)
    expect(await cards.nth(1).getAttribute('title')).toContain('工作区干净')

    // ③ 非仓库:只显示"非 Git 仓库",不带任何 Git 标记
    await expect(cards.nth(2).locator('.dir-card__tag--plain')).toHaveText('非 Git 仓库')
    await expect(cards.nth(2).locator('.dir-card__tag--git')).toHaveCount(0)

    // ④ 探测没结果(isGitRepo=null):整组徽标都不渲染,不猜、不谎报
    const tail = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.directory-dialog .dir-card')]
      return all.slice(3).filter(c => c.querySelector('.dir-card__tag')).length
    })
    expect(tail).toBe(0)

    // ⑤ 每种徽标全列表各出现 1 次,没有多余的
    await expect(page.locator('.directory-dialog .dir-card__tag--dirty')).toHaveCount(1)
    await expect(page.locator('.directory-dialog .dir-card__tag--ahead')).toHaveCount(1)
    await expect(page.locator('.directory-dialog .dir-card__tag--behind')).toHaveCount(1)

    // 回归:用户反馈"这个按钮高度怎么是撑起来的"。
    // 根因有两层 —— Element Plus 的 .el-form-item__content 带 line-height:32px,会一路继承到徽标
    // (10px 的字号被 32px 行高撑成 34px);再加上"未提交"徽标额外一条 1px 描边,同排就差 2px。
    // 现在徽标高度只由字号 + padding 决定,四种徽标必须一样高。
    const tagHeights = await page.evaluate(() => {
      const seen = new Map<string, number>()
      for (const t of document.querySelectorAll('.directory-dialog .dir-card__tag')) {
        const variant = [...t.classList].find(c => c.startsWith('dir-card__tag--')) ?? 'base'
        seen.set(variant, +t.getBoundingClientRect().height.toFixed(1))
      }
      return [...seen]
    })
    expect(tagHeights.length).toBeGreaterThanOrEqual(5)   // 未提交 / 领先 / 落后 / Git / 非 Git 仓库 都在
    const heights = tagHeights.map(([, h]) => h)
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(0.5)

    // 同排多个徽标必须垂直居中对齐(顶边齐不够,还要中心点齐)
    const centerSpread = await page.evaluate(() => {
      const perGroup = [...document.querySelectorAll('.directory-dialog .dir-card__tags')]
        .filter(g => g.children.length >= 2)
        .map(g => [...g.children].map(c => {
          const r = c.getBoundingClientRect()
          return (r.top + r.bottom) / 2
        }))
      if (!perGroup.length) return null
      return Math.max(...perGroup.map(ys => Math.max(...ys) - Math.min(...ys)))
    })
    expect(centerSpread).not.toBeNull()
    expect(centerSpread!).toBeLessThanOrEqual(0.5)

    // 宽度预算:三徽标同时在(最挤的情况)也不能把路径挤到截断 ——
    // 1400 视口下弹窗 1040px、卡片 493px,三徽标实测 136px,仍有余量
    const truncated = await page.evaluate(() =>
      [...document.querySelectorAll('.directory-dialog .dir-card__name-path')]
        .filter(p => p.scrollWidth > p.clientWidth + 1).length)
    expect(truncated).toBe(0)
  })

  // 回归:用户反馈"没 hover 时候右边不用占位,这按钮也太丑了"。
  // ① 空闲时徽标必须贴到卡片右内边缘(此前操作按钮在流内占 60px,右边永远空一条)
  // ② hover 时操作按钮淡入、徽标在同一锚点淡出,且徽标位置不移动(交叉过渡,不是布局抖动)
  test('空闲时右侧不占位:hover 时按钮与徽标交叉过渡且无位移', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 790 })
    await page.goto('/')
    await expect(page.locator('.directory-display')).toBeVisible({ timeout: 10_000 })
    await page.locator('.directory-display').click()
    await page.locator('.directory-dialog').waitFor({ timeout: 8_000 })

    const count = await countDirectoryCards(page)
    test.skip(count === 0, '没有常用目录,跳过此测试')

    // 挑一张有 Git 徽标、且不是"不存在"的有效目录卡(失效卡的移除按钮是常驻的,规则不同)
    const card = page
      .locator('.directory-dialog .dir-card')
      .filter({ has: page.locator('.dir-card__tag--git') })
      .first()
    await expect(card).toBeVisible()

    const probe = () => card.evaluate(el => {
      const tags = el.querySelector('.dir-card__tags') as HTMLElement
      const actions = el.querySelector('.dir-card__actions') as HTMLElement
      const style = getComputedStyle(el)
      return {
        padRight: Math.round(parseFloat(style.paddingRight)),
        // 卡片右边缘到徽标右边缘的距离:等于 padding-right 才说明右侧没被占位
        gapRight: Math.round(el.getBoundingClientRect().right - tags.getBoundingClientRect().right),
        tagsOpacity: Number(getComputedStyle(tags).opacity),
        actionsOpacity: Number(getComputedStyle(actions).opacity),
        actionsPosition: getComputedStyle(actions).position,
      }
    })

    const idle = await probe()
    // 右侧不留空条:徽标右边缘就是卡片内容区右边缘(容 1px 取整误差)
    expect(Math.abs(idle.gapRight - idle.padRight)).toBeLessThanOrEqual(1)
    expect(idle.actionsPosition).toBe('absolute')   // 操作按钮脱离文档流
    expect(idle.tagsOpacity).toBe(1)
    expect(idle.actionsOpacity).toBe(0)

    await card.hover()
    await page.waitForTimeout(300)                  // 等 opacity 过渡结束

    const hovered = await probe()
    expect(hovered.actionsOpacity).toBe(1)          // 按钮淡入
    expect(hovered.tagsOpacity).toBe(0)             // 徽标让位
    expect(hovered.gapRight).toBe(idle.gapRight)    // 徽标只淡出不位移 → 无布局抖动
  })
})
