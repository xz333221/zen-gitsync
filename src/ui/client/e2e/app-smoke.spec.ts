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
  // Git 视图根节点的 class 是 "view-pane git-pane"(网格布局已下移到 .git-pane__body
  // 里的 .grid-layout,不再挂在 pane 根上);其他 6 个 pane 同构,都带 -pane 后缀
  { label: 'Git',        pane: '.view-pane.git-pane' },
  { label: '控制台',     pane: '.console-pane' },
  { label: '文件空间',   pane: '.editor-pane' },
  // 源码地图:入口已由 ActivityBar 的 SHOW_SOURCE_MAP 关闭,恢复时把下面这行加回来
  // { label: '源码地图',   pane: '.source-map-pane' },
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
    // .view-pane.git-pane 是 git 视图的根节点
    await expect(page.locator('.view-pane.git-pane').first()).toBeVisible()
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

  test('9. 文件空间: g ai 对话面板可打开,并显示当前文档 chip', async ({ page }) => {
    await page.locator('.activity-bar button[aria-label^="文件空间"]').first().click()
    await expect(page.locator('.editor-pane')).toBeVisible()

    // 面板只在"有打开的文件"时可见，先点左树里的第一个文件
    const firstFile = page.locator('.tree-node--file').first()
    await expect(firstFile).toBeVisible({ timeout: 30_000 })
    await firstFile.click()

    // Tab 栏右侧的第三个 toggle：g ai 对话
    const toggle = page.locator('.agent-toggle-btn')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveClass(/active/)
    await expect(page.locator('.editor-agent-panel')).toBeVisible()
    await expect(page.locator('.agent-context-chip')).toBeVisible()

    // 光"可见"不够：组件库的样式表要真的生效，否则面板是裸的（2026-09-27 用户实测报过）。
    // 本用例是全新 context、直接进文件空间，从未加载 AgentView / WorkbenchView / JobLogDetails
    // 那三个引了 zen-ai-chat-ui/style.css 的懒加载 chunk —— 正好是漏引样式时的现场。
    // .acu-chat 的 flex-direction: column 来自库样式表，浏览器默认是 row。
    const chatDir = await page.locator('.editor-agent-panel .acu-chat')
      .evaluate(el => getComputedStyle(el).flexDirection)
    expect(chatDir).toBe('column')
    // 会话列表同理：库的 ConversationList 根节点（样式表没加载也能"可见"，配套上面那条断言）
    await expect(page.locator('.editor-agent-panel .acu-conv').first()).toBeVisible()
  })

  // 附件：图片走多模态（images[] dataURL），非图片走"服务端落盘 + 只把路径给模型"（attachments[]）。
  // 这条用例同时守两件事：① accept 被放开后非图片真能选进来并变成 chip；
  // ② 请求体里两类附件各归各位（前端只过滤"能不能发"，落盘与注入由服务端负责）。
  test('10. 文件空间对话: 图片进 images[]、非图片进 attachments[]', async ({ page }) => {
    const bodies: any[] = []
    await page.route('/api/agent/chat', async route => {
      bodies.push(route.request().postDataJSON())
      // 直接收尾，别真去调模型
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"type":"done","content":"ok"}\n\n'
      })
    })

    await page.locator('.activity-bar button[aria-label^="文件空间"]').first().click()
    await expect(page.locator('.tree-node--file').first()).toBeVisible({ timeout: 30_000 })
    await page.locator('.tree-node--file').first().click()
    await page.locator('.agent-toggle-btn').click()
    await expect(page.locator('.editor-agent-panel')).toBeVisible()

    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
    await page.locator('.editor-agent-panel input[type=file]').setInputFiles([
      { name: 'a.log', mimeType: 'text/plain', buffer: Buffer.from('log line\n') },
      { name: 'shot.png', mimeType: 'image/png', buffer: png }
    ])
    await expect(page.locator('.editor-agent-panel .acu-input-att')).toHaveCount(2)

    await page.locator('.editor-agent-panel .acu-input-textarea').fill('看下这两个')
    await page.locator('.editor-agent-panel .acu-input-send').click()

    await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(1)
    expect(bodies[0].attachments.map((a: any) => a.name)).toEqual(['a.log'])
    expect(bodies[0].attachments[0].dataUrl).toMatch(/^data:text\/plain;base64,/)
    expect(bodies[0].images).toHaveLength(1)
    expect(bodies[0].images[0]).toMatch(/^data:image\/png;base64,/)
  })
})
