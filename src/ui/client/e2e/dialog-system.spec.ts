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
// 统一弹窗体系 E2E:页面级弹窗必须走 CommonDialog 外壳。
// CommonDialog 在 .el-dialog 上打 data-dialog-shell="common" 标记,
// 并统一使用 --dialog-radius / --dialog-shadow / --dialog-overlay token。
// 这组用例是"弹窗外壳不再分裂回多套实现"的回归护栏:
// 新增弹窗如果绕过 CommonDialog,标记缺失 → 用例失败。

import { test, expect } from '@playwright/test'

const SHELL = '.el-dialog[data-dialog-shell="common"]'

/** 打开用户设置弹窗(顶栏齿轮按钮) */
async function openUserSettings(page: import('@playwright/test').Page) {
  await page.locator('header button[aria-label*="设置"]').first().click()
  return page.locator(SHELL).first()
}

/**
 * 主题是持久化设置(点一次写回 /api/config/save-ui-settings),
 * 所以不能假定开局是浅色 —— 先读状态,不一致才改,保证用例幂等;
 * 结束时用它恢复浅色,避免污染其它 spec。
 *
 * 2026-10-06：顶栏的 `.theme-toggle-btn` 按用户要求先不显示了（那个位置让给了
 * 命令历史 + Git 操作），这里改走它背后**同一条持久化链路**：主题由
 * `configStore.saveGeneralSettings()` 发到 `/api/config/save-general-settings`
 * （注意不是 save-ui-settings —— 本文件原来那句注释写错了），改完 reload 让 App
 * 按新配置重新应用。比去操作「设置 → 主题」那个 el-select 稳得多（少两次点击、
 * 少两个按文案找的元素，也不会被设置弹窗的遮罩影响后续断言）。
 */
async function ensureTheme(
  page: import('@playwright/test').Page,
  theme: 'dark' | 'light'
) {
  const html = page.locator('html')
  const isDark = await html.evaluate((el) => el.getAttribute('data-theme') === 'dark')
  if ((theme === 'dark') !== isDark) {
    await page.evaluate(async (t) => {
      await fetch('/api/config/save-general-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: t }),
      })
    }, theme)
    await page.reload()
    // 重新等一次 initCompleted（与 beforeEach 同一判据），否则主题可能还没应用
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
  }
  if (theme === 'dark') {
    await expect(html).toHaveAttribute('data-theme', 'dark')
  } else {
    await expect(html).not.toHaveAttribute('data-theme', 'dark')
  }
}

test.describe('统一弹窗体系 (CommonDialog)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // 等待 initCompleted:App.vue 的 .loading-container 在初始化完成后消失
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
  })

  test('1. 设置弹窗:外壳标记 + token 圆角 + 统一遮罩 + 可关闭', async ({ page }) => {
    const dialog = await openUserSettings(page)
    await expect(dialog).toBeVisible()

    // 圆角必须来自 --dialog-radius(12px),不允许各弹窗自定义
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('12px')

    // 遮罩统一走 --dialog-overlay(带透明度)。注意:EP 会在 body 常驻一个隐藏的
    // .el-overlay,不能用 `.el-overlay:first`,要从弹窗自身向上取它所在的 overlay。
    const overlayBg = await dialog.evaluate((el) => {
      const overlay = el.closest('.el-overlay') as HTMLElement | null
      return overlay ? getComputedStyle(overlay).backgroundColor : ''
    })
    expect(overlayBg.startsWith('rgba(')).toBe(true)

    // 右上角关闭按钮存在且能关闭
    await dialog.locator('.el-dialog__headerbtn').click()
    await expect(dialog).toBeHidden()
  })

  test('2. 远程管理弹窗:存量 CommonDialog 点位保持统一外壳', async ({ page }) => {
    await page.locator('.remote-wrapper button.icon-button').first().click()
    const dialog = page.locator(`${SHELL}.remote-manager-dialog`)
    await expect(dialog).toBeVisible()
    expect(await dialog.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('12px')
  })

  test('3. 深色主题下弹窗仍为深色底(不因去 !important 而漏白)', async ({ page }) => {
    await ensureTheme(page, 'dark')
    const dialog = await openUserSettings(page)
    try {
      await expect(dialog).toBeVisible()
      // --bg-container-dark = #1c2130
      expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(28, 33, 48)')
      // body 区域同样保持深色(header/footer 是透明或深色,body 曾是最易漏白的一层)
      const bodyBg = await dialog
        .locator('.el-dialog__body')
        .evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(bodyBg).toBe('rgb(28, 33, 48)')
    } finally {
      // 主题是持久化设置,恢复浅色避免影响其它 spec。
      // 必须先关弹窗:遮罩会挡住顶栏的主题按钮,直接点会因"元素被遮挡"超时。
      await dialog.locator('.el-dialog__headerbtn').click().catch(() => {})
      await ensureTheme(page, 'light')
    }
  })

  test('4. 跨弹窗一致性:不同弹窗共用同一套外壳 token', async ({ page }) => {
    const settings = await openUserSettings(page)
    await expect(settings).toBeVisible()
    const settingsStyle = await settings.evaluate((el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderRadius, shadow: s.boxShadow }
    })
    await settings.locator('.el-dialog__headerbtn').click()
    await expect(settings).toBeHidden()

    await page.locator('.remote-wrapper button.icon-button').first().click()
    const remote = page.locator(`${SHELL}.remote-manager-dialog`)
    await expect(remote).toBeVisible()
    const remoteStyle = await remote.evaluate((el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderRadius, shadow: s.boxShadow }
    })

    expect(remoteStyle.radius).toBe(settingsStyle.radius)
    expect(remoteStyle.shadow).toBe(settingsStyle.shadow)
  })
})