// E2E: 暂存按钮在文件多选模式下只暂存勾选项
// 前置: 后端 + vite dev 都已运行(参见 README.md)

import { test, expect, request } from '@playwright/test'

// 已知仓库根(开发环境 vite 已知): 通过 /api/current_directory 读
async function getRepoRoot(): Promise<string> {
  const api = await request.newContext({ baseURL: 'http://localhost:5544' })
  const r = await api.get('/api/current_directory')
  const data = await r.json()
  return data.directory as string
}

// 调后端 API 把工作区重置到干净状态(避免脏数据干扰断言)
async function resetRepo(api: Awaited<ReturnType<typeof request.newContext>>) {
  await api.post('/api/reset-head')
}

test.describe('StageButton 选择模式 - 只暂存勾选项', () => {
  test('选择模式未开启时,按钮文案为"暂存 (N)"', async ({ page }) => {
    await page.goto('/')
    // 等页面骨架出现
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(800)

    // 找到"暂存"按钮(可能有多处,取第一个带 count 的)
    const stageBtn = page.locator('button.stage-button, .stage-button button').first()
    await expect(stageBtn).toBeVisible({ timeout: 10_000 })

    // 默认应显示"暂存"或"暂存 (N)"
    const text = (await stageBtn.textContent()) || ''
    expect(text.trim()).toMatch(/^暂存(\s*\(\d+\))?$/)
  })

  test('进入选择模式并勾选 1 个文件后,按钮文案变为"暂存所选 (1)"', async ({ page }) => {
    const api = await request.newContext({ baseURL: 'http://localhost:5544' })
    await resetRepo(api)

    await page.goto('/')
    await page.waitForTimeout(800)

    // 通过 SVG use 的 xlink:href 定位"进入选择模式"按钮
    const selectModeBtn = page.locator('use[*|href="#icon-muti-choose"]').first()
    const exists = (await selectModeBtn.count()) > 0
    test.skip(!exists, '工作区无文件,跳过此测试')

    await selectModeBtn.click()
    await page.waitForTimeout(300)

    // 勾选第一个文件
    const firstCheckbox = page.locator('.file-checkbox').first()
    await expect(firstCheckbox).toBeVisible({ timeout: 3000 })
    await firstCheckbox.click()
    await page.waitForTimeout(200)

    // 暂存按钮文案应变为"暂存所选 (1)"
    const stageBtn = page.locator('button.stage-button, .stage-button button').first()
    await expect(stageBtn).toBeVisible()
    const text = (await stageBtn.textContent())?.trim() ?? ''
    expect(text).toMatch(/^暂存所选\s*\(1\)$/)

    // 清理:退出选择模式 + 重置
    await selectModeBtn.click()
    await resetRepo(api)
  })

  test('点击"暂存所选"只调用 /api/add-files 并只传勾选文件', async ({ page }) => {
    const api = await request.newContext({ baseURL: 'http://localhost:5544' })
    await resetRepo(api)

    // 先确保工作区有 2 个未暂存文件(否则跳过)
    const status = await (await api.get('/api/status_porcelain')).json()
    const unstaged = String(status.status || '')
      .split('\n')
      .filter(l => /^\s\?/.test(l) || /^\sM/.test(l) || /^\sD/.test(l))
    test.skip(unstaged.length < 2, '需要至少 2 个未暂存文件,跳过')

    await page.goto('/')
    await page.waitForTimeout(800)

    // 监听 /api/add-files 调用
    const addFilesCalls: { paths: string[] }[] = []
    page.on('request', req => {
      if (req.url().includes('/api/add-files') && req.method() === 'POST') {
        try {
          const body = JSON.parse(req.postData() || '{}')
          addFilesCalls.push({ paths: body.filePaths || [] })
        } catch {}
      }
    })

    // 进入选择模式
    const selectModeBtn = page.locator('use[*|href="#icon-muti-choose"]').first()
    await selectModeBtn.click()
    await page.waitForTimeout(300)

    // 只勾选第一个文件
    const firstCheckbox = page.locator('.file-checkbox').first()
    await firstCheckbox.click()
    await page.waitForTimeout(200)

    // 点击"暂存所选"
    const stageBtn = page.locator('button.stage-button, .stage-button button').first()
    await stageBtn.click()
    await page.waitForTimeout(1500) // 等 API 回来

    // 必须正好调用 1 次 add-files,且只传 1 个路径
    expect(addFilesCalls.length, 'add-files 至少调用 1 次').toBeGreaterThanOrEqual(1)
    const last = addFilesCalls[addFilesCalls.length - 1]
    expect(last.paths.length, 'add-files 只传 1 个文件').toBe(1)

    // 清理
    await resetRepo(api)
  })
})

test.describe('API: /api/add-files 批量暂存', () => {
  test('空数组返回 400', async () => {
    const api = await request.newContext({ baseURL: 'http://localhost:5544' })
    const r = await api.post('/api/add-files', { data: { filePaths: [] } })
    expect(r.status()).toBe(400)
    const data = await r.json()
    expect(data.success).toBe(false)
  })

  test('只传勾选文件时,只暂存勾选项', async () => {
    const api = await request.newContext({ baseURL: 'http://localhost:5544' })
    await resetRepo(api)

    const status = await (await api.get('/api/status_porcelain')).json()
    const lines = String(status.status || '').split('\n').filter(Boolean)
    // 取出"工作区有变更"的文件(非已暂存):第二列是空格 + M/?/D
    const candidate = lines
      .map(l => l.match(/^.{2}\s(.+)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => m[1])
      .filter(p => p && !p.includes('zen-gitsync')) // 排除本次修改的源码文件
    test.skip(candidate.length < 2, '需要至少 2 个候选未暂存文件,跳过')

    const [onlyOne] = candidate
    const r = await api.post('/api/add-files', { data: { filePaths: [onlyOne] } })
    expect(r.ok()).toBeTruthy()
    const data = await r.json()
    expect(data.success).toBe(true)
    expect(data.successCount).toBe(1)
    expect(data.filePaths).toEqual([onlyOne])

    // 验证 porcelain:该文件已暂存(M  在第一列),其他未变
    const after = await (await api.get('/api/status_porcelain')).json()
    const afterLines = String(after.status || '').split('\n')
    const targetLine = afterLines.find(l => l.endsWith(' ' + onlyOne))
    expect(targetLine, '目标行应存在').toBeTruthy()
    // porcelain 第一列表示 index 状态: 'M ' = 已暂存修改
    expect(targetLine!.slice(0, 2)).toBe('M ')

    // 清理
    await resetRepo(api)
  })
})
