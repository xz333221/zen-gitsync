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
async function countDirectoryCards(page: Page): Promise<number> {
  const cards = page.locator('.dir-card')
  await cards.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
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
  test('卡片展示 Git / 未提交 N 项 / 非 Git 仓库徽标,探不到则不显示', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 790 })

    // 按请求体里的 paths 顺序造状态:第 1 个脏仓库、第 2 个干净仓库、第 3 个非仓库,
    // 其余一律 isGitRepo=null(模拟探测超时)→ 不能显示任何 Git 徽标,也不能谎报"非 Git 仓库"
    await page.route('**/api/recent_directories/git-state', async route => {
      const body = JSON.parse(route.request().postData() || '{}')
      const results: Record<string, unknown> = {}
      const clean = { exists: true, isGitRepo: true, changed: 0, staged: 0, unstaged: 0, untracked: 0 }
      ;(body.paths ?? []).forEach((p: string, i: number) => {
        if (i === 0) results[p] = { exists: true, isGitRepo: true, changed: 3, staged: 1, unstaged: 1, untracked: 1 }
        else if (i === 1) results[p] = clean
        else if (i === 2) results[p] = { ...clean, isGitRepo: false }
        else results[p] = { ...clean, isGitRepo: null }
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

    // ① 脏仓库:Git + 未提交 3 项,悬浮提示给明细
    await expect(cards.nth(0).locator('.dir-card__tag--git')).toHaveText('Git')
    await expect(cards.nth(0).locator('.dir-card__tag--dirty')).toHaveText('未提交 3 项')
    expect(await cards.nth(0).getAttribute('title')).toContain('已暂存 1 · 未暂存 1 · 未跟踪 1')

    // ② 干净仓库:只有 Git 徽标,不该出现"未提交 0 项"这种噪音
    await expect(cards.nth(1).locator('.dir-card__tag--git')).toBeVisible()
    await expect(cards.nth(1).locator('.dir-card__tag--dirty')).toHaveCount(0)
    expect(await cards.nth(1).getAttribute('title')).toContain('工作区干净')

    // ③ 非仓库:只显示"非 Git 仓库",不带 Git 徽标
    await expect(cards.nth(2).locator('.dir-card__tag--plain')).toHaveText('非 Git 仓库')
    await expect(cards.nth(2).locator('.dir-card__tag--git')).toHaveCount(0)

    // ④ 探测没结果(isGitRepo=null):整组徽标都不渲染,不猜、不谎报
    const tail = await page.evaluate(() => {
      const all = [...document.querySelectorAll('.directory-dialog .dir-card')]
      return all.slice(3).filter(c => c.querySelector('.dir-card__tag')).length
    })
    expect(tail).toBe(0)

    // 全列表"未提交"徽标有且仅有 1 个(即只有第 1 张卡)
    await expect(page.locator('.directory-dialog .dir-card__tag--dirty')).toHaveCount(1)
  })
})
