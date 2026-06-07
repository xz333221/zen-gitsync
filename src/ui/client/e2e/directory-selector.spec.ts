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

import { test, expect } from '@playwright/test'

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
    const recentDirs = page.locator('.recent-dir-item')
    const count = await recentDirs.count()
    console.log(`找到 ${count} 个常用目录`)

    if (count > 0) {
      // 第一个目录项的 title 应包含"按住 Ctrl 点击用新标签打开"或"按住 ⌘ 点击"
      const firstItem = recentDirs.first()
      const title = await firstItem.getAttribute('title')
      expect(title).toMatch(/按住 (Ctrl|⌘) 点击用新标签打开/)
    }
  })

  test('Ctrl+点击触发 open-new-tab-gui API 而不是 change_directory', async ({ page }) => {
    await page.goto('/')

    const dirDisplay = page.locator('.directory-display')
    await expect(dirDisplay).toBeVisible({ timeout: 10_000 })
    await dirDisplay.click()

    const recentDirs = page.locator('.recent-dir-item')
    const count = await recentDirs.count()
    test.skip(count === 0, '没有常用目录,跳过此测试')

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

    const recentDirs = page.locator('.recent-dir-item')
    const count = await recentDirs.count()
    test.skip(count === 0, '没有常用目录,跳过此测试')

    // 监听 API 请求
    let apiCalled = false
    page.on('request', req => {
      if (req.url().includes('/api/open-new-tab-gui') || req.url().includes('/api/change_directory')) {
        apiCalled = true
      }
    })

    // 普通点击
    await recentDirs.first().click()

    await page.waitForTimeout(300)

    // 不应调用任何变更 API
    expect(apiCalled, '普通点击不应触发 API').toBe(false)

    // 输入框应该有值
    const input = page.locator('.modern-input input')
    const value = await input.inputValue()
    expect(value.length).toBeGreaterThan(0)
  })
})
