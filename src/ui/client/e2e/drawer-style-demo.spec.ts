// Demo test: render static HTML with Playwright to show drawer style before/after
// Run: cd src/ui/client && npx playwright test e2e/drawer-style-demo.spec.ts

import { test, expect } from '@playwright/test'

const BEFORE = {
  groupGap: '12px',
  buttonGap: '8px',
  titleSize: '13px',
  buttonHeight: '40px',
  groupPadding: '12px',
  groupBorderRadius: '8px'
}

const AFTER = {
  groupGap: '20px',
  buttonGap: '6px',
  titleSize: '15px',
  buttonHeight: '48px',
  groupPadding: '16px',
  groupBorderRadius: '12px'
}

const baseCss = [
  'body { margin: 0; padding: 24px; background: #f5f7fa; font-family: sans-serif; }',
  '.drawer { width: 380px; background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }',
  '.drawer-header { font-size: 18px; font-weight: 600; margin-bottom: 20px; color: #303133; }',
  '.action-groups { display: flex; flex-direction: column; gap: var(--group-gap, 12px); }',
  '.action-group { background: #fafbfc; border-radius: var(--group-radius, 8px); padding: var(--group-padding, 12px); border: 1px solid #ebeef5; }',
  '.group-title { font-size: var(--title-size, 13px); font-weight: 600; color: #303133; margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #ebeef5; }',
  '.group-buttons { display: flex; flex-direction: column; gap: var(--button-gap, 8px); }',
  '.el-button { width: 100%; display: flex; align-items: center; justify-content: center; height: var(--button-height, 40px); border: 1px solid #dcdfe6; background: #fff; color: #303133; border-radius: 6px; font-size: 14px; cursor: pointer; }',
  '.el-button.primary { background: #409eff; color: #fff; border-color: #409eff; }',
  '.el-button.warning { background: #e6a23c; color: #fff; border-color: #e6a23c; }',
  '.el-button.info { background: #909399; color: #fff; border-color: #909399; }'
].join('\n')

// All UI labels are ASCII to avoid encoding issues with the babel parser
const labels = {
  drawerTitle: 'Git Operations',
  basic: 'Basic',
  combo: 'Combo',
  branch: 'Branch',
  stash: 'Stash',
  btnStage: 'Stage (6)',
  btnCommit: 'Commit',
  btnPush: 'Push',
  btnPull: 'Pull',
  btnStageCommit: 'Stage & Commit',
  btnPushAll: 'Push All',
  btnMerge: 'Merge Branch',
  btnStash: 'Stash Changes',
  btnStashList: 'Stash List',
  before: 'Before',
  after: 'After'
}

function makeDrawerHtml(style, title) {
  const cssVars = [
    '--group-gap: ' + style.groupGap,
    '--button-gap: ' + style.buttonGap,
    '--title-size: ' + style.titleSize,
    '--button-height: ' + style.buttonHeight,
    '--group-padding: ' + style.groupPadding,
    '--group-radius: ' + style.groupBorderRadius
  ].join('; ')

  return [
    '<div class="drawer" style="' + cssVars + '">',
    '  <div class="drawer-header">' + title + '</div>',
    '  <div class="action-groups">',
    '    <div class="action-group">',
    '      <div class="group-title">' + labels.basic + '</div>',
    '      <div class="group-buttons">',
    '        <button class="el-button primary">' + labels.btnStage + '</button>',
    '        <button class="el-button primary">' + labels.btnCommit + '</button>',
    '        <button class="el-button primary">' + labels.btnPush + '</button>',
    '        <button class="el-button primary">' + labels.btnPull + '</button>',
    '      </div>',
    '    </div>',
    '    <div class="action-group">',
    '      <div class="group-title">' + labels.combo + '</div>',
    '      <div class="group-buttons">',
    '        <button class="el-button primary">' + labels.btnStageCommit + '</button>',
    '        <button class="el-button primary">' + labels.btnPushAll + '</button>',
    '      </div>',
    '    </div>',
    '    <div class="action-group">',
    '      <div class="group-title">' + labels.branch + '</div>',
    '      <div class="group-buttons">',
    '        <button class="el-button primary">' + labels.btnMerge + '</button>',
    '      </div>',
    '    </div>',
    '    <div class="action-group">',
    '      <div class="group-title">' + labels.stash + '</div>',
    '      <div class="group-buttons">',
    '        <button class="el-button warning">' + labels.btnStash + '</button>',
    '        <button class="el-button info">' + labels.btnStashList + '</button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n')
}

test.describe('Git drawer style - before vs after', () => {
  test('before screenshot', async ({ page }) => {
    const html = '<style>' + baseCss + '</style>' + makeDrawerHtml(BEFORE, labels.drawerTitle)
    await page.setContent(html)
    await page.waitForLoadState('domcontentloaded')
    await page.screenshot({ path: 'test-results/drawer-before.png', fullPage: true })

    await expect(page.locator('.drawer')).toBeVisible()
    const titleFontSize = await page.locator('.group-title').first().evaluate(el =>
      window.getComputedStyle(el).fontSize
    )
    expect(titleFontSize).toBe('13px')
    console.log('[BEFORE] group-title font-size: ' + titleFontSize)
  })

  test('after screenshot', async ({ page }) => {
    const html = '<style>' + baseCss + '</style>' + makeDrawerHtml(AFTER, labels.drawerTitle)
    await page.setContent(html)
    await page.waitForLoadState('domcontentloaded')
    await page.screenshot({ path: 'test-results/drawer-after.png', fullPage: true })

    const titleFontSize = await page.locator('.group-title').first().evaluate(el =>
      window.getComputedStyle(el).fontSize
    )
    expect(titleFontSize).toBe('15px')
    console.log('[AFTER]  group-title font-size: ' + titleFontSize)
  })

  test('side by side compare', async ({ page }) => {
    const extraCss = [
      'body { display: flex; gap: 32px; padding: 32px; background: #f0f2f5; }',
      '.compare-block { display: flex; flex-direction: column; gap: 12px; }',
      '.compare-label { font-size: 14px; font-weight: 600; color: #606266; text-align: center; padding: 8px; background: #fff; border-radius: 6px; }',
      '.arrow { font-size: 32px; color: #67c23a; margin: auto 0; font-weight: bold; }'
    ].join('\n')

    const html = [
      '<style>' + baseCss + extraCss + '</style>',
      '<div class="compare-block">',
      '  <div class="compare-label">' + labels.before + '</div>',
      makeDrawerHtml(BEFORE, labels.drawerTitle),
      '</div>',
      '<div class="arrow">&rarr;</div>',
      '<div class="compare-block">',
      '  <div class="compare-label">' + labels.after + '</div>',
      makeDrawerHtml(AFTER, labels.drawerTitle),
      '</div>'
    ].join('\n')

    await page.setContent(html)
    await page.waitForLoadState('domcontentloaded')
    await page.screenshot({ path: 'test-results/drawer-compare.png', fullPage: true })
  })

  test('all style variables are applied correctly', async ({ page }) => {
    const html = '<style>' + baseCss + '</style>' + makeDrawerHtml(AFTER, labels.drawerTitle)
    await page.setContent(html)

    const groupsGap = await page.locator('.action-groups').evaluate(el => window.getComputedStyle(el).gap)
    const buttonsGap = await page.locator('.group-buttons').first().evaluate(el => window.getComputedStyle(el).gap)
    const titleSize = await page.locator('.group-title').first().evaluate(el => window.getComputedStyle(el).fontSize)
    const btnHeight = await page.locator('.el-button').first().evaluate(el => window.getComputedStyle(el).height)
    const groupPad = await page.locator('.action-group').first().evaluate(el => window.getComputedStyle(el).padding)
    const groupRadius = await page.locator('.action-group').first().evaluate(el => window.getComputedStyle(el).borderRadius)

    expect(groupsGap).toBe('20px')
    expect(buttonsGap).toBe('6px')
    expect(titleSize).toBe('15px')
    expect(btnHeight).toBe('48px')
    expect(groupPad).toBe('16px')
    expect(groupRadius).toBe('12px')

    console.log([
      '',
      '[Style check]',
      '  group gap:    ' + groupsGap + '   (want 20px)',
      '  button gap:   ' + buttonsGap + '   (want 6px)',
      '  title size:   ' + titleSize + '   (want 15px)',
      '  btn height:   ' + btnHeight + '   (want 48px)',
      '  group pad:    ' + groupPad + '   (want 16px)',
      '  group radius: ' + groupRadius + '   (want 12px)'
    ].join('\n'))
  })
})
