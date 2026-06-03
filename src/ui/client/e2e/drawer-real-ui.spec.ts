// Real UI screenshot test for Git Operations drawer
// Run: npm run e2e:headed e2e/drawer-real-ui.spec.ts
// Prereq: 后端 (node server.js) + vite (npm run dev) 都跑着

import { test, expect } from '@playwright/test'

// 你的环境 baseURL 在 playwright.config.ts 里配了 http://localhost:5544
// 这个测试会去那里加载真实 Vue 应用

test.describe('Git Operations drawer - 真实 UI 截图', () => {
  test('截改前真实样式', async ({ page }) => {
    // 访问真实 Vite dev server
    await page.goto('/')

    // 等应用初始化(目录选择器出现)
    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 15_000 })

    // 点开 Git 操作抽屉
    // 真实按钮是 .git-operations-button 里的 IconButton(只显示 Menu 图标,无文字)
    const gitOpsButton = page.locator('.git-operations-button button').first()
    await gitOpsButton.click()

    // 等抽屉完全展开
    await page.waitForTimeout(800)

    // 截整个 drawer 区域
    const drawer = page.locator('.git-operations-drawer').last()
    await expect(drawer).toBeVisible({ timeout: 5_000 })
    await drawer.screenshot({ path: 'test-results/real-drawer-before.png' })

    // 读真实样式值(给后续 SCSS 修改做参考)
    const styles = await page.evaluate(() => {
      const groups = document.querySelector('.action-groups')
      const group = document.querySelector('.action-group')
      const title = document.querySelector('.group-title')
      const button = document.querySelector('.group-buttons .el-button')
      const buttonsContainer = document.querySelector('.group-buttons')
      if (!groups || !group || !title || !button || !buttonsContainer) return null
      return {
        groupGap: getComputedStyle(groups).gap,
        groupPad: getComputedStyle(group).padding,
        groupRadius: getComputedStyle(group).borderRadius,
        titleSize: getComputedStyle(title).fontSize,
        titleWeight: getComputedStyle(title).fontWeight,
        btnHeight: getComputedStyle(button).height,
        buttonsGap: getComputedStyle(buttonsContainer).gap
      }
    })

    console.log('\n[真实 UI 当前样式]')
    if (styles) {
      for (const [k, v] of Object.entries(styles)) {
        console.log('  ' + k.padEnd(15) + ': ' + v)
      }
    } else {
      console.log('  (没找到样式,检查选择器)')
    }
  })

  test('截整页改前真实样式', async ({ page }) => {
    await page.goto('/')

    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 15_000 })

    // 点开 Git 操作抽屉
    const gitOpsButton = page.locator('.git-operations-button button').first()
    await gitOpsButton.click()
    await page.waitForTimeout(800)

    // 整页截图,看上下文
    await page.screenshot({ path: 'test-results/real-page-before.png', fullPage: true })
  })
})
