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
// E2E: 远程仓库管理(列表 / 多远程推送下拉 / 添加 / 全部推送)
//
// 三条设计约束,与 commit-flow.spec.ts 同源:
//
//   1. 绝不真改用户的 .git/config。
//      `git remote add` / `rename` / `remove` 会写进用户仓库配置,一旦用例中途
//      失败就留下脏 remote(甚至让后续 pull 指错上游)。所以所有变更类端点
//      (/api/add-remote、/api/remote/*、/api/push-all-remotes) 一律 route 拦截,
//      断言请求体后返回模拟结果。远程仓库的增删改本身是 git 的职责,这里验的
//      是 UI 是否把正确的参数送到后端。
//
//   2. 列表渲染用 stub 的 GET /api/remotes 保证确定性。
//      真实仓库只有 1 个 remote,断言不了多远程分支(多 push URL、上游标记、
//      推送下拉)。GET 可以安全 stub —— 与 status 不同,remotes 没有 socket.io
//      广播回写通道,只有 fetchRemotes() 这一个来源,不会被刷回真实值。
//
//   3. 不 stub 任何写端点但不做断言 —— 每个拦截都要验请求体,否则等于没测。
//
// 前置: 后端 + vite dev 已运行(参见 README.md)

import { test, expect, request, type Page, type APIRequestContext } from '@playwright/test'

const ORIGIN = 'http://127.0.0.1:5544'

function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: ORIGIN })
}

/** 构造 GET /api/remotes 的响应体 */
function remotesPayload(remotes: Array<Partial<{
  name: string
  fetchUrl: string
  pushUrls: string[]
  hasExplicitPushUrls: boolean
  isPushDefault: boolean
  isUpstream: boolean
}>>) {
  return {
    success: true,
    remotes: remotes.map(r => ({
      pushUrls: [],
      hasExplicitPushUrls: false,
      isPushDefault: false,
      isUpstream: false,
      ...r
    })),
    currentBranch: 'main',
    upstreamBranch: 'origin/main',
    pushDefault: ''
  }
}

async function gotoApp(page: Page) {
  await page.goto('/')
  await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
}

/** 打开远程管理弹窗(齿轮入口在底部状态栏远程地址左侧) */
async function openManager(page: Page) {
  await page.locator('.remote-wrapper button.icon-button').first().click()
  await expect(page.locator('.remote-manager-dialog')).toBeVisible()
}

test.describe('Remote management', () => {
  test('1. 齿轮入口打开弹窗，并列出仓库真实 remote', async ({ page }) => {
    const api = await newApi()
    const res = await api.get('/api/remotes')
    const real = (await res.json()).remotes as Array<{ name: string; fetchUrl: string }>
    await api.dispose()
    expect(real.length).toBeGreaterThan(0)

    await gotoApp(page)
    await openManager(page)

    const rows = page.locator('.rm-row')
    await expect(rows).toHaveCount(real.length)
    await expect(rows.first().locator('.rm-row__name')).toHaveText(real[0].name)
    // 拉取地址原样展示
    await expect(rows.first()).toContainText(real[0].fetchUrl)
  })

  test('2. 列表标注上游 / 显式推送地址，未配置时回落提示', async ({ page }) => {
    await page.route('**/api/remotes', route => route.fulfill({
      json: remotesPayload([
        {
          name: 'origin',
          fetchUrl: 'git@github.com:user/project.git',
          isUpstream: true,
          isPushDefault: true
        },
        {
          name: 'backup',
          fetchUrl: 'git@gitee.com:user/project.git',
          pushUrls: ['git@gitee.com:user/project.git', 'git@gitlab.com:user/project.git'],
          hasExplicitPushUrls: true
        }
      ])
    }))

    await gotoApp(page)
    await openManager(page)

    const origin = page.locator('.rm-row', { has: page.locator('.rm-row__name', { hasText: 'origin' }) })
    const backup = page.locator('.rm-row', { has: page.locator('.rm-row__name', { hasText: 'backup' }) })

    // 上游 / 默认推送标记都挂在 origin 上
    await expect(origin).toContainText('上游')
    await expect(origin).toContainText('默认推送')

    // backup 有 2 条显式 push URL
    await expect(backup.locator('.rm-pushurl')).toHaveCount(2)
    // origin 没配 pushurl → 走"与拉取地址一致"提示,不展示 push 标签
    await expect(origin.locator('.rm-pushurl')).toHaveCount(0)
    await expect(origin).toContainText('推送地址与拉取地址一致')
  })

  test('3. 多远程才出现推送下拉，单远程保持原样', async ({ page }) => {
    // 单远程:无下拉触发器(外观与历史完全一致)
    await page.route('**/api/remotes', route => route.fulfill({
      json: remotesPayload([{ name: 'origin', fetchUrl: 'git@github.com:user/project.git', isUpstream: true }])
    }))
    await gotoApp(page)
    await expect(page.locator('.push-button').first()).toBeVisible()
    await expect(page.locator('.push-button__caret')).toHaveCount(0)

    // 多远程:出现下拉,且上游排第一
    await page.unroute('**/api/remotes')
    await page.route('**/api/remotes', route => route.fulfill({
      json: remotesPayload([
        { name: 'backup', fetchUrl: 'git@gitee.com:user/project.git' },
        { name: 'origin', fetchUrl: 'git@github.com:user/project.git', isUpstream: true }
      ])
    }))
    await page.reload()
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })

    const caret = page.locator('.push-button__caret').first()
    await expect(caret).toBeVisible()
    await caret.click()

    const items = page.locator('.el-dropdown-menu:visible .el-dropdown-menu__item')
    await expect(items).toHaveCount(4) // 2 个远程 + 全部推送 + 管理远程
    await expect(items.nth(0)).toContainText('推送到 origin') // 上游排第一
    await expect(items.nth(1)).toContainText('推送到 backup')
    await expect(items.nth(2)).toContainText('推送到全部远程')
    await expect(items.nth(3)).toContainText('管理远程')
  })

  test('4. 添加远程表单把 name / url 原样送到后端', async ({ page }) => {
    let body: { name?: string; url?: string } | null = null
    await page.route('**/api/add-remote', async route => {
      body = route.request().postDataJSON()
      await route.fulfill({ json: { success: true } })
    })

    await gotoApp(page)
    await openManager(page)

    await page.fill('#rm-add-name', 'upstream')
    await page.fill('#rm-add-url', 'git@github.com:org/project.git')
    // 命令预览随输入实时更新
    await expect(page.locator('.remote-manager-dialog')).toContainText('git remote add upstream git@github.com:org/project.git')

    await page.locator('.rm-add__btn').click()

    // 按文案过滤:应用自身会弹「Git 状态已刷新」等其他 success 提示,
    // 直接断言 .el-message--success 会被 strict mode 判成多元素命中
    await expect(page.locator('.el-message--success', { hasText: '远程添加成功' })).toBeVisible()
    expect(body).toEqual({ name: 'upstream', url: 'git@github.com:org/project.git' })
    // 添加成功后表单清空,便于连续加第二个远程
    await expect(page.locator('#rm-add-name')).toHaveValue('')
    await expect(page.locator('#rm-add-url')).toHaveValue('')
  })

  test('5. 下拉「管理远程…」打开同一弹窗', async ({ page }) => {
    await page.route('**/api/remotes', route => route.fulfill({
      json: remotesPayload([
        { name: 'origin', fetchUrl: 'git@github.com:user/project.git', isUpstream: true },
        { name: 'backup', fetchUrl: 'git@gitee.com:user/project.git' }
      ])
    }))

    await gotoApp(page)
    await expect(page.locator('.remote-manager-dialog')).toBeHidden()

    await page.locator('.push-button__caret').first().click()
    await page.locator('.el-dropdown-menu:visible .el-dropdown-menu__item', { hasText: '管理远程' }).click()

    await expect(page.locator('.remote-manager-dialog')).toBeVisible()
    await expect(page.locator('.rm-row')).toHaveCount(2)
  })

  test('6. 全部推送按钮仅多远程时出现，点击后逐条展示结果', async ({ page }) => {
    await page.route('**/api/remotes', route => route.fulfill({
      json: remotesPayload([
        { name: 'origin', fetchUrl: 'git@github.com:user/project.git', isUpstream: true },
        { name: 'backup', fetchUrl: 'git@gitee.com:user/project.git' }
      ])
    }))

    let pushAllCalled = 0
    await page.route('**/api/push-all-remotes', async route => {
      pushAllCalled += 1
      await route.fulfill({
        json: {
          success: false,
          results: [
            { name: 'origin', ok: true },
            { name: 'backup', ok: false, error: 'Could not read from remote repository' }
          ]
        }
      })
    })

    await gotoApp(page)
    await openManager(page)

    const pushAll = page.locator('.rm-footer__actions button', { hasText: '推送到全部远程' })
    await expect(pushAll).toBeVisible()
    await pushAll.click()

    expect(pushAllCalled).toBe(1)
    // 逐条结果:成功/失败各一条,失败项 title 带原因
    const results = page.locator('.rm-push-result')
    await expect(results).toHaveCount(2)
    await expect(results.nth(0)).toHaveClass(/is-ok/)
    await expect(results.nth(1)).toHaveClass(/is-fail/)
    await expect(results.nth(1)).toHaveAttribute('title', /Could not read from remote repository/)
    await expect(page.locator('.el-message--error', { hasText: '部分远程推送失败' })).toBeVisible()
  })
})
