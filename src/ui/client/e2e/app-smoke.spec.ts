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

  test('6. CommitForm card mounted (lazy-loaded)', async ({ page }) => {
    // .app-card 是 .card 通用容器,CommitForm 根上挂这个 class
    // 2026-10-06：「无事可做时提交区整块收起」上线后，`.header-left` 与 `.card-content`
    // 会被压成 grid-template-rows: 0fr（0 高、opacity 0）—— Playwright 把空盒子判为
    // **不可见**，所以原来的 toBeVisible 不再是"懒加载成功"的判据。
    // 懒加载要验的是"挂载了没" → attached；顺手把收起态的自洽性钉住。
    const card = page.locator('.commit-form-panel .app-card').first()
    await expect(card).toHaveCount(1, { timeout: 30_000 })
    const m = await card.evaluate((el) => {
      const q = (s: string) => el.querySelector(s) as HTMLElement | null
      const box = (n: HTMLElement | null) => (n ? n.getBoundingClientRect() : null)
      const content = box(q('.card-content'))
      const icons = box(q('.header-right'))
      const stageBtn = box(q('.header-left'))
      return {
        idle: el.classList.contains('is-idle'),
        contentH: content ? content.height : -1,
        iconsH: icons ? icons.height : -1,
        stageH: stageBtn ? stageBtn.height : -1,
      }
    })
    // 收起 ⇔ 表单区高度为 0；展开则必须有真实高度（两者自洽，防"永远收起"）
    expect(m.idle ? m.contentH < 1 : m.contentH > 40).toBe(true)
    // 护栏：收起时**右侧三个图标必须还在**（AI 生成 / 命令历史 / Git 操作菜单）——
    // 干净工作区恰好是最想 pull / fetch 的时刻，不许把整块面板一起藏掉
    expect(m.iconsH).toBeGreaterThan(10)
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

  test('9. 文件空间: g ai 对话面板可打开,当前文档卡片落在输入框内部', async ({ page }) => {
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
    // 当前文档卡片在输入框**内部**第一行（库的附件行 .acu-input-attachments 待的那一层），
    // 不是浮在输入框外面。这里不只断言"可见"，还量了它确实排在 .acu-input-row 之上 ——
    // 光 `toBeVisible()` 的话，绝对定位浮在输入框上方也能骗过用例（上一版就是这么错的）。
    const ctxCard = page.locator('.editor-agent-panel .acu-input-wrap .agent-context-att')
    await expect(ctxCard).toBeVisible()
    await expect(page.locator('.agent-panel-header .agent-context-att')).toHaveCount(0)
    expect(await ctxCard.evaluate(el => {
      const row = el.closest('.acu-input-wrap')?.querySelector('.acu-input-row')
      if (!row) return false
      return el.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 1
    })).toBe(true)
    // 和附件一样带移除按钮（只是它移除的是"这一条不带当前文档"，不是删文件）
    await expect(page.locator('.editor-agent-panel .agent-context-att-remove')).toHaveCount(1)

    // 执行器切换：用户反馈过"文件空间里的 g ai 没有执行器的切换"。面板头部要有与
    // 智能体视图同款的引擎下拉 —— 默认 g ai，点开后有全部四个引擎。
    const engine = page.locator('.editor-agent-panel .agent-engine')
    await expect(engine).toBeVisible()
    await expect(engine.locator('.agent-engine__name')).toHaveText('g ai')
    await engine.locator('.agent-engine__btn').click()
    await expect(page.locator('.el-dropdown-menu .agent-engine__item')).toHaveCount(4)
    await page.keyboard.press('Escape')

    // 光"可见"不够：组件库的样式表要真的生效，否则面板是裸的（2026-09-27 用户实测报过）。
    // 本用例是全新 context、直接进文件空间，从未加载 AgentView / WorkbenchView / JobLogDetails
    // 那三个引了 zen-ai-chat-ui/style.css 的懒加载 chunk —— 正好是漏引样式时的现场。
    // .acu-chat 的 flex-direction: column 来自库样式表，浏览器默认是 row。
    const chatDir = await page.locator('.editor-agent-panel .acu-chat')
      .evaluate(el => getComputedStyle(el).flexDirection)
    expect(chatDir).toBe('column')
    // 会话列表的渲染与样式由下面第 11 条用例守（它会翻到列表页）。
    // 这里不再断言 .acu-conv —— 列表默认整块 display:none，写在这里只会永远红。
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

    // 「当前文档」卡片和这两个附件**并排在同一行**（这就是"跟加附件一样"）：
    // 它住在 .acu-input-attachments 里，是那一行的一个 flex item。
    // 上一版靠"插在输入框最前面"保位置，Vue 更新输入框时会把它挤到下一行 —— 用户截图报过。
    // 判据用"垂直方向有重叠"而不是"top 相等"：附件里的图片缩略图是 56px 固定高，
    // flex 的 align-items 会把同行各 item 拉伸成不同高度，top 本来就不一定相等。
    expect(await page.locator('.editor-agent-panel .agent-context-att').evaluate(el => {
      const att = el.closest('.acu-input-attachments')?.querySelector('.acu-input-att')
      if (!att) return false
      const a = el.getBoundingClientRect()
      const b = att.getBoundingClientRect()
      return a.bottom > b.top && a.top < b.bottom
    })).toBe(true)

    await page.locator('.editor-agent-panel .acu-input-textarea').fill('看下这两个')
    await page.locator('.editor-agent-panel .acu-input-send').click()

    await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(1)
    expect(bodies[0].attachments.map((a: any) => a.name)).toEqual(['a.log'])
    expect(bodies[0].attachments[0].dataUrl).toMatch(/^data:text\/plain;base64,/)
    expect(bodies[0].images).toHaveLength(1)
    expect(bodies[0].images[0]).toMatch(/^data:image\/png;base64,/)
  })

  // ── 文件空间 g ai 面板：会话列表 ↔ 对话 **恒为两个整页** ──
  // 这块面板挂在编辑器里跟 Monaco 分宽度，天生长得窄；原先"列表压在上面 + 对话在下面"，
  // 列表一开就只剩两三行对话。现在不按宽度分支，任何宽度都是两个整页 ——
  // 所以这里要**同时**在宽窄两个视口下断言，防止哪天有人把宽度分支加回来。
  test('11. 文件空间 g ai 面板：会话列表页 ↔ 对话页（恒两页，与宽度无关）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })

    await page.locator('.activity-bar button[aria-label^="文件空间"]').first().click()
    await expect(page.locator('.tree-node--file').first()).toBeVisible({ timeout: 30_000 })
    await page.locator('.tree-node--file').first().click()
    await page.locator('.agent-toggle-btn').click()

    const panel = page.locator('.editor-agent-panel')
    await expect(panel).toBeVisible()
    // 恒两页：宽度分支该留下的痕迹一个都不该有
    await expect(panel).not.toHaveClass(/is-narrow/)

    // 默认在对话页：对话铺满，列表整块让位
    await expect(panel.locator('.agent-panel-chat')).toBeVisible()
    await expect(panel.locator('.agent-panel-convs')).toBeHidden()

    // 点头部按钮 → 会话列表页整页铺开（组件库的 ConversationList 真的渲染出来）
    await panel.locator('.agent-panel-list-btn').click()
    await expect(panel.locator('.acu-conv').first()).toBeVisible()
    await expect(panel.locator('.agent-panel-chat')).toBeHidden()
    // 头部整条让给「返回对话 + 会话列表」，列表按钮退场
    await expect(panel.locator('.agent-panel-back-btn')).toBeVisible()
    await expect(panel.locator('.agent-panel-title')).toHaveText('会话列表')
    await expect(panel.locator('.agent-panel-list-btn')).toHaveCount(0)

    // 点 ← 返回对话页
    await panel.locator('.agent-panel-back-btn').click()
    await expect(panel.locator('.agent-panel-chat')).toBeVisible()
    await expect(panel.locator('.agent-panel-convs')).toBeHidden()

    // 视口拉宽（面板跟着变宽）后**仍是两页** —— 这正是"恒两页"与旧版的分水岭：
    // 旧版一宽就退回上下堆叠（列表与对话同屏），用户看到的就是"没变"。
    await page.setViewportSize({ width: 1600, height: 900 })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.agent-panel-chat')).toBeVisible()
    await expect(panel.locator('.agent-panel-convs')).toBeHidden()
  })

  test('12. 窄屏：智能体视图折成「会话列表页 ↔ 对话页」', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 720 })
    await page.locator('.activity-bar button[aria-label^="智能体"]').first().click()

    const view = page.locator('.agent-view')
    await expect(view).toBeVisible({ timeout: 30_000 })

    // 窄屏：宽屏那套并排的左侧栏 + 拖拽条整块不渲染
    await expect(view.locator('.agent-page-bar')).toBeVisible()
    await expect(view.locator('.agent-sidebar')).toHaveCount(0)
    await expect(view.locator('.sidebar-resizer')).toHaveCount(0)
    await expect(view.locator('.acu-chat')).toBeVisible()

    // 返回箭头 → 会话列表页独占，对话整块退场
    await view.locator('.agent-page-back').click()
    await expect(view.locator('.agent-list-page .acu-conv').first()).toBeVisible()
    await expect(view.locator('.acu-chat')).toHaveCount(0)
    await expect(view.locator('.agent-page-bar')).toHaveCount(0)
  })
})
