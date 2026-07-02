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
// 应用冒烟 E2E:启动 + ActivityBar 导航 + 默认 Git 视图渲染。
// 这是 Round 1 的最小回归网,后续 spec 可基于此文件加更多场景。

import { test, expect } from '@playwright/test'

const VIEW_BUTTONS = [
  // Git 视图的 pane class 是 "view-pane grid-layout"(App.vue:679),不带 git-pane
  // —— 其他 6 个 pane 都带 -pane 后缀
  { label: 'Git',        pane: '.view-pane.grid-layout' },
  { label: '控制台',     pane: '.console-pane' },
  { label: '编辑器',     pane: '.editor-pane' },
  { label: '源码地图',   pane: '.source-map-pane' },
  { label: '工作台',     pane: '.workbench-pane' },
  { label: '系统监控',   pane: '.monitor-pane' },
  { label: '思维导图',   pane: '.mindmap-pane' },
] as const

test.describe('App smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // 等待 initCompleted:见 App.vue:614-670 渲染 .loading-container,完成后整段消失
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
  })

  test('1. loading gate clears, app-body renders', async ({ page }) => {
    await expect(page.locator('.app-body')).toBeVisible()
  })

  test('2. footer branch button visible (signal: app fully mounted)', async ({ page }) => {
    await expect(page.locator('footer .branch-btn')).toBeVisible()
  })

  test('3. version badge matches v\\d+(\\.\\d+)* pattern', async ({ page }) => {
    await expect(page.locator('.app-version-badge .version-link'))
      .toHaveText(/^v\d+(\.\d+)*$/, { timeout: 10_000 })
  })

  test('4. default view is git-pane, Git button is active', async ({ page }) => {
    // .view-pane.grid-layout 是 git 视图的根(App.vue:679)
    await expect(page.locator('.view-pane.grid-layout').first()).toBeVisible()
    // aria-label 前缀匹配:ActivityBar 按钮可能带状态后缀(如 "Git · 3 个未提交文件")
    const gitBtn = page.locator('.activity-bar button[aria-label^="Git"]').first()
    await expect(gitBtn).toHaveClass(/active/)
  })

  test('5. GitStatus card visible on default view', async ({ page }) => {
    await expect(page.locator('.git-status-card')).toBeVisible()
  })

  test('6. CommitForm card visible (lazy-loaded)', async ({ page }) => {
    // .app-card 是 .card 通用容器,CommitForm 根上挂这个 class
    await expect(page.locator('.app-card').first()).toBeVisible({ timeout: 30_000 })
  })

  test('7. LogList card visible (lazy-loaded)', async ({ page }) => {
    // LogList 内部有 .log-actions 工具栏,定位到再向上找父卡片
    await expect(page.locator('.log-actions').first()).toBeVisible({ timeout: 30_000 })
  })

  for (const { label, pane } of VIEW_BUTTONS) {
    test(`8. ActivityBar: clicking "${label}" activates ${pane}`, async ({ page }) => {
      const btn = page.locator(`.activity-bar button[aria-label^="${label}"]`).first()
      await expect(btn).toBeVisible()
      await btn.click()
      await expect(btn).toHaveClass(/active/)
      await expect(page.locator(pane)).toBeVisible()
    })
  }
})
