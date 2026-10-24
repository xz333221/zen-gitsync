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
    // 2026-10-06 两轮改动后的契约：
    //  ①「无事可做时整块收起」现在收的是 `.commit-form-panel`（grid-template-rows: 0fr），
    //    所以 is-idle 在 **panel** 上、0 高也发生在 panel 上 —— Playwright 把空盒子判为
    //    不可见，原来的 toBeVisible 不再是"懒加载成功"的判据 → 改成 attached + 自洽断言。
    //  ②「命令历史 / Git 操作」已搬到常驻顶栏（原主题按钮的位置），它们必须一直在 ——
    //    否则工作区干净时 pull/fetch/merge 就没有入口了。这条护栏放在这里最省事。
    const card = page.locator('.commit-form-panel .app-card').first()
    await expect(card).toHaveCount(1, { timeout: 30_000 })
    const m = await page.locator('.commit-form-panel').first().evaluate((panel) => {
      const card = panel.querySelector('.app-card') as HTMLElement | null
      const content = card && (card.querySelector('.card-content') as HTMLElement | null)
      return {
        idle: panel.classList.contains('is-idle'),
        panelH: panel.getBoundingClientRect().height,
        contentH: content ? content.getBoundingClientRect().height : -1,
      }
    })
    // 收起 ⇔ 面板高 0；展开则必须有真实高度（两者自洽，防"永远收起"）
    expect(m.idle ? m.panelH < 1 && m.contentH < 1 : m.panelH > 100 && m.contentH > 40).toBe(true)
    // 护栏：两个常驻入口必须在顶栏可见
    const header = page.locator('.main-header')
    await expect(header.getByRole('button', { name: /Git 命令历史|命令历史/ }).first()).toBeVisible()
    await expect(header.getByRole('button', { name: /Git 操作/ }).first()).toBeVisible()
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

  // ── g ai 悬浮 dock（2026-10 AI 对话入口从活动栏 tab / 编辑器面板整合而来）──
  // 原「文件空间 g ai 对话面板」的两条用例（当前文档卡 / 附件分流）移植到 dock：
  // 编辑器视图激活时，App 把当前打开文件经 :context-file 传进 dock 的 AgentView，
  // 卡片与附件行为与旧面板同一套实现（Teleport 锚点 + sendMessage 的 openFilePath 注入）。
  test('9. g ai dock: 当前文档卡片落在输入框内部，引擎下拉全量', async ({ page }) => {
    await page.locator('.activity-bar button[aria-label^="文件空间"]').first().click()
    await expect(page.locator('.editor-pane')).toBeVisible()

    // dock 的文件上下文来自「编辑器当前激活文件」，先点左树里的第一个文件
    const firstFile = page.locator('.tree-node--file').first()
    await expect(firstFile).toBeVisible({ timeout: 30_000 })
    await firstFile.click()

    // 右下角 mascot 展开 dock
    await page.locator('.agent-dock__mascot').click()
    const view = page.locator('.agent-view')
    await expect(view).toBeVisible({ timeout: 30_000 })
    await expect(view.locator('.acu-input-textarea').first()).toBeVisible({ timeout: 30_000 })

    // 当前文档卡片在输入框**内部**第一行（库的附件行 .acu-input-attachments 待的那一层），
    // 不是浮在输入框外面。这里不只断言"可见"，还量了它确实排在 .acu-input-row 之上 ——
    // 光 toBeVisible() 的话，绝对定位浮在输入框上方也能骗过用例（上一版就是这么错的）。
    const ctxCard = view.locator('.agent-chat-host .acu-input-wrap .agent-context-att')
    await expect(ctxCard).toBeVisible()
    await expect(view.locator('.agent-dock__head .agent-context-att')).toHaveCount(0)
    expect(await ctxCard.evaluate(el => {
      const row = el.closest('.acu-input-wrap')?.querySelector('.acu-input-row')
      if (!row) return false
      return el.getBoundingClientRect().bottom <= row.getBoundingClientRect().top + 1
    })).toBe(true)
    // 和附件一样带移除按钮（只是它移除的是"这一条不带当前文档"，不是删文件）
    await expect(view.locator('.agent-context-att-remove')).toHaveCount(1)

    // 执行器切换：与旧文件空间面板同款引擎下拉 —— 默认 g ai，点开后是全部引擎。
    // 条数 = 内置 g ai + TASK_EXECUTOR_OPTIONS（claude / opencode / codex /
    // codebuddy / pi，2026-10 已 5 家）。新增执行器时这条要跟着改，是刻意的门。
    const engine = view.locator('.agent-engine')
    await expect(engine).toBeVisible()
    await expect(engine.locator('.agent-engine__name')).toHaveText('g ai')
    await engine.locator('.agent-engine__btn').click()
    await expect(page.locator('.el-dropdown-menu .agent-engine__item')).toHaveCount(6)
    await page.keyboard.press('Escape')

    // 光"可见"不够：组件库的样式表要真的生效，否则对话区是裸的（2026-09-27 用户实测报过）。
    // .acu-chat 的 flex-direction: column 来自库样式表，浏览器默认是 row。
    const chatDir = await view.locator('.acu-chat')
      .evaluate(el => getComputedStyle(el).flexDirection)
    expect(chatDir).toBe('column')
  })

  // 附件：图片走多模态（images[] dataURL），非图片走"服务端落盘 + 只把路径给模型"（attachments[]）。
  // 这条用例同时守两件事：① accept 被放开后非图片真能选进来并变成 chip；
  // ② 请求体里两类附件各归各位（前端只过滤"能不能发"，落盘与注入由服务端负责）。
  test('10. g ai dock 对话: 图片进 images[]、非图片进 attachments[]', async ({ page }) => {
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
    await page.locator('.agent-dock__mascot').click()
    const view = page.locator('.agent-view')
    await expect(view).toBeVisible({ timeout: 30_000 })
    await expect(view.locator('.acu-input-textarea').first()).toBeVisible({ timeout: 30_000 })

    // 1x1 透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64'
    )
    await view.locator('input[type=file]').setInputFiles([
      { name: 'a.log', mimeType: 'text/plain', buffer: Buffer.from('log line\n') },
      { name: 'shot.png', mimeType: 'image/png', buffer: png }
    ])
    await expect(view.locator('.acu-input-att')).toHaveCount(2)

    // 「当前文档」卡片和这两个附件**并排在同一行**（这就是"跟加附件一样"）：
    // 它住在 .acu-input-attachments 里，是那一行的一个 flex item。
    // 上一版靠"插在输入框最前面"保位置，Vue 更新输入框时会把它挤到下一行 —— 用户截图报过。
    // 判据用"垂直方向有重叠"而不是"top 相等"：附件里的图片缩略图是 56px 固定高，
    // flex 的 align-items 会把同行各 item 拉伸成不同高度，top 本来就不一定相等。
    expect(await view.locator('.agent-context-att').evaluate(el => {
      const att = el.closest('.acu-input-attachments')?.querySelector('.acu-input-att')
      if (!att) return false
      const a = el.getBoundingClientRect()
      const b = att.getBoundingClientRect()
      return a.bottom > b.top && a.top < b.bottom
    })).toBe(true)

    await view.locator('.acu-input-textarea').first().fill('看下这两个')
    await view.locator('.acu-input-send').first().click()

    await expect.poll(() => bodies.length, { timeout: 15_000 }).toBe(1)
    expect(bodies[0].attachments.map((a: any) => a.name)).toEqual(['a.log'])
    expect(bodies[0].attachments[0].dataUrl).toMatch(/^data:text\/plain;base64,/)
    expect(bodies[0].images).toHaveLength(1)
    expect(bodies[0].images[0]).toMatch(/^data:image\/png;base64,/)
  })

  // ── dock 默认 560px 窄面板：AgentView 折成「会话列表页 ↔ 对话页」──
  // 旧第 11/12 条分别守编辑器面板（恒两页）与智能体视图（窄屏两页）；
  // 入口整合后 dock 恒窄屏（560 < 680），两条合成这一条。
  // 注意 .agent-sidebar 现在是 v-show（不是 v-if）：窄屏下节点还在 DOM 里，
  // 只是 display:none 不占布局 —— 断言"隐藏"而不是"不存在"。
  test('11. g ai dock 默认窄面板：会话列表页 ↔ 对话页', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 720 })
    await page.locator('.agent-dock__mascot').click()

    const view = page.locator('.agent-view')
    await expect(view).toBeVisible({ timeout: 30_000 })

    // 窄面板：宽屏那套并排的左侧栏 + 拖拽条藏起来（v-show，不占布局）
    await expect(view.locator('.agent-page-bar')).toBeVisible()
    await expect(view.locator('.agent-sidebar')).toBeHidden()
    await expect(view.locator('.sidebar-resizer')).toBeHidden()
    await expect(view.locator('.acu-chat')).toBeVisible()

    // 返回箭头 → 会话列表页独占，对话整块退场
    await view.locator('.agent-page-back').click()
    await expect(view.locator('.agent-list-page .acu-conv').first()).toBeVisible()
    await expect(view.locator('.acu-chat')).toHaveCount(0)
    await expect(view.locator('.agent-page-bar')).toHaveCount(0)
  })

  // ── dock 开合与最大化（整合后新增的入口行为）──
  test('12. g ai dock: mascot 开合 / Esc / ✕ / 最大化宽屏两栏', async ({ page }) => {
    const panel = page.locator('.agent-dock__panel')
    const view = page.locator('.agent-view')

    // 初始收起：面板在 DOM 里但不可见（v-show）
    await expect(page.locator('.agent-dock__mascot')).toBeVisible()
    await expect(panel).toBeHidden()

    // 点 mascot 展开
    await page.locator('.agent-dock__mascot').click()
    await expect(panel).toBeVisible()
    await expect(view).toBeVisible({ timeout: 30_000 })

    // Esc 收起（焦点归还 mascot）
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
    await expect(page.locator('.agent-dock__mascot')).toBeFocused()

    // 再点展开 → 头部 ✕ 收起
    await page.locator('.agent-dock__mascot').click()
    await expect(panel).toBeVisible()
    await page.locator('.agent-dock__btn--close').click()
    await expect(panel).toBeHidden()

    // 最大化 → 宽屏两栏（会话列表侧栏真的可见）；还原 → 又藏起来
    await page.locator('.agent-dock__mascot').click()
    await expect(view).toBeVisible({ timeout: 30_000 })
    await expect(view.locator('.agent-sidebar')).toBeHidden()
    await page.locator('.agent-dock__btn--max').click()
    await expect(view.locator('.agent-sidebar')).toBeVisible()
    await page.locator('.agent-dock__btn--max').click()
    await expect(view.locator('.agent-sidebar')).toBeHidden()
  })

  // ── dock 不随底层视图销毁：切走再切回，对话原地不动 ──
  test('13. g ai dock: 切底层视图不关面板，会话状态保留', async ({ page }) => {
    await page.locator('.agent-dock__mascot').click()
    const view = page.locator('.agent-view')
    await expect(view).toBeVisible({ timeout: 30_000 })

    // 切到工作台视图：dock 是 fixed 覆盖层，不随 activeView 销毁
    await page.locator('.activity-bar button[aria-label^="工作台"]').first().click()
    await expect(page.locator('.workbench-pane')).toBeVisible()
    await expect(page.locator('.agent-dock__panel')).toBeVisible()
    await expect(view).toBeVisible()

    // 切回 Git 视图：仍在
    await page.locator('.activity-bar button[aria-label^="Git"]').first().click()
    await expect(page.locator('.agent-dock__panel')).toBeVisible()
    await expect(view).toBeVisible()
  })
})
