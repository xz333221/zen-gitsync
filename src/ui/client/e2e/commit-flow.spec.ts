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
// E2E: 提交主流程(填提交信息 → 点提交 → 结果反馈)
//
// 五条设计约束,都是踩过坑后定的:
//
//   1. 不落真实 commit。
//      /api/commit 用 route 拦截,断言请求体后返回模拟结果。
//      /api/reset-head 只做 `git reset HEAD`(取消暂存),撤销不了已经产生的
//      提交对象,所以一旦真的提交成功,用户仓库历史里就多一条脏 commit。
//      git 自身的 commit 行为不属于本应用职责,UI 链路照样完整跑通。
//
//   2. 不 stub /api/status_porcelain 来伪造"有暂存文件"。
//      应用的状态是双通道的:HTTP 轮询 + socket.io 广播。只 stub HTTP 这一路,
//      广播会把状态刷回真实值,两边打架导致用例随机失败。
//      这里改为造一个真实的 fixture 文件并 git add,让两条通道天然一致。
//      fixture 只影响它自己,清理时用 /api/unstage-file 精准取消暂存,
//      不碰用户本来就存在的暂存区。
//
//   3. 每个用例最多点一次提交,且成功/失败拆成两个用例。
//      本机(Windows + chromium)上跑完 3 个用例后再开新 context 会卡死:
//      后续用例既不输出也不超时;用裸 Playwright 脚本复现时卡在 browser.close(),
//      判断是 chromium 资源释放问题,与本 spec 逻辑无关。同一页面连续多次提交
//      同样会触发。所以按"一用例一提交"切分,把用例数压在 4 个以内。
//
//   4. 多行提交只验证命令预览,不再真的点一次提交 —— 这样能省掉一次提交,
//      同时照样断言到最终 message 的拼接结果。
//
//   5. 提交信息不写 type 前缀(如 "feat: xxx")。
//      标准提交模式下最终 message = `${type}: ${description}`,再带前缀就变成
//      "feat: feat: xxx"。断言统一用 toContain(描述文本),两种模式都成立。
//
// 前置: 后端 + vite dev 已运行(参见 README.md)

import fs from 'fs'
import path from 'path'
import { test, expect, request, type Page, type Route, type APIRequestContext } from '@playwright/test'

const BACKEND = 'http://127.0.0.1:5544'

// 落在仓库根的临时文件,名字带 e2e 前缀方便识别残留
const FIXTURE_REL = '.e2e-commit-fixture.txt'

function newApi(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: BACKEND })
}

async function getRepoRoot(api: APIRequestContext): Promise<string> {
  const data = await (await api.get('/api/current_directory')).json()
  return data.directory as string
}

/** 读配置。返回体可能是裸 config,也可能是 { config: {...} } 包装,两种都兼容。 */
async function readConfig(api: APIRequestContext): Promise<Record<string, unknown>> {
  const raw = await (await api.get('/api/config/getConfig')).json()
  return ((raw.config ?? raw) ?? {}) as Record<string, unknown>
}

/**
 * 造一个真实文件并加入暂存区,让 UI 拿到"有已暂存文件"的状态。
 * 这是提交按钮从禁用变可用的前提。
 */
async function stageFixture(api: APIRequestContext) {
  const root = await getRepoRoot(api)
  fs.writeFileSync(path.join(root, FIXTURE_REL), `e2e commit fixture ${Date.now()}\n`, 'utf8')

  const r = await api.post('/api/add-files', { data: { filePaths: [FIXTURE_REL] } })
  const data = await r.json()
  if (!data.success) {
    throw new Error(`暂存 fixture 失败: ${data.error || r.status()}`)
  }
}

/**
 * 清理:精准取消 fixture 的暂存并删除文件,不影响用户自己的暂存区。
 * 只在 fixture 确实还在暂存区时才 unstage —— 否则 `git reset HEAD -- <file>`
 * 会因为文件不在索引里而报错,后端日志刷一堆噪音。
 */
async function cleanupFixture(api: APIRequestContext) {
  try {
    const status = await (await api.get('/api/status_porcelain')).json()
    const stillStaged = String(status.status || '')
      .split('\n')
      .filter(Boolean)
      .some(line => /^[AMDR]/.test(line) && line.includes(FIXTURE_REL))

    if (stillStaged) {
      await api.post('/api/unstage-file', { data: { filePath: FIXTURE_REL } })
    }
  } catch {
    /* 状态读不到就跳过 unstage,下面照常删文件 */
  }

  try {
    fs.rmSync(path.join(await getRepoRoot(api), FIXTURE_REL), { force: true })
  } catch {
    /* 删不掉就算了,下次会覆盖重建 */
  }
}

/**
 * 拦截 /api/commit:记录请求体并返回模拟结果,不产生真实提交。
 * 返回的 calls 数组供调用方断言请求体。
 */
async function interceptCommit(
  page: Page,
  result: { success: true } | { success: false; error: string }
) {
  const calls: Record<string, unknown>[] = []
  await page.route('**/api/commit', (route: Route) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(route.request().postData() || '{}')
    } catch {
      /* 请求体为空时保持空对象,交给断言去暴露 */
    }
    calls.push(body)
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result),
    })
  })
  return calls
}

/**
 * 填写提交信息,自动适配两种提交模式。
 *
 * configStore.isStandardCommit 默认 true,但会被用户配置文件覆盖。两种模式
 * 渲染的是完全不同的表单(标准模式=类型+作用域+简短描述,普通模式=一个多行
 * 文本框),写死任一选择器都会在另一种配置下直接挂掉。
 */
async function fillCommitMessage(page: Page, text: string): Promise<'standard' | 'plain'> {
  const description = page.locator('.description-input input').first()
  if ((await description.count()) > 0) {
    await description.fill(text)
    // el-autocomplete 会弹出建议面板挡住提交按钮
    await page.keyboard.press('Escape')
    return 'standard'
  }
  await page.locator('.commit-message-input textarea').first().fill(text)
  return 'plain'
}

async function readCommitMessage(page: Page): Promise<string> {
  const description = page.locator('.description-input input').first()
  if ((await description.count()) > 0) {
    return (await description.inputValue()) ?? ''
  }
  return (await page.locator('.commit-message-input textarea').first().inputValue()) ?? ''
}

async function gotoApp(page: Page) {
  await page.goto('/', { timeout: 60_000 })
  await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
  // Git 用户信息未配置时 GitActionButtons 根本不渲染,提交按钮就不存在
  await expect(page.locator('.commit-button')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  const api = await newApi()
  try {
    const info = await (await api.get('/api/user-info')).json()
    if (!info.name || !info.email) {
      throw new Error('Git 用户信息未配置,提交区域不会渲染')
    }
  } finally {
    await api.dispose()
  }
})

test.afterEach(async () => {
  const api = await newApi()
  try {
    await cleanupFixture(api)
  } finally {
    await api.dispose()
  }
})

test.describe('提交主流程', () => {
  test('按钮守卫与命令预览(不点提交)', async ({ page }) => {
    const api = await newApi()
    await stageFixture(api)
    await api.dispose()

    await gotoApp(page)
    const commitBtn = page.locator('.commit-button')
    const preview = page.locator('.git-command-preview .code-command')

    // 先清空再断言:用户可能开了 autoSetDefaultMessage,输入框会被自动填充
    await fillCommitMessage(page, '')
    await expect(commitBtn).toBeDisabled()
    // 按钮禁用时命令预览不展示
    await expect(preview).toHaveCount(0)

    await fillCommitMessage(page, '提交主流程 E2E')
    await expect(commitBtn).toBeEnabled()

    await expect(preview).toBeVisible()
    await expect(preview).toContainText('git commit -m')
    await expect(preview).toContainText('提交主流程 E2E')

    // 清空后重新禁用
    await fillCommitMessage(page, '')
    await expect(commitBtn).toBeDisabled()

    // 多行提交:预览里的命令就是最终会发出的 message,据此断言换行被保留。
    // 放在这里是因为它不需要点提交,省掉一个浏览器会话。
    const mode = await fillCommitMessage(page, '多行提交')
    if (mode === 'standard') {
      // 标准模式的多行来源在正文里,先展开"正文及页脚"
      await page.locator('.advanced-options-toggle').click()
      await page.locator('.body-input textarea').first().fill('这是正文内容')
    } else {
      await page.locator('.commit-message-input textarea').first().fill('第一行\n\n这是正文')
    }

    await expect(preview).toBeVisible()
    await expect(preview).toContainText('多行提交')
    expect((await preview.textContent()) || '').toContain('\n')
  })

  test('提交成功:请求体正确、提示成功、清空输入', async ({ page }) => {
    const api = await newApi()
    await stageFixture(api)
    const cfg = await readConfig(api)
    await api.dispose()

    const commitCalls = await interceptCommit(page, { success: true })
    await gotoApp(page)

    await fillCommitMessage(page, '请求契约校验')
    await page.locator('.commit-button').click()

    await expect.poll(() => commitCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

    const body = commitCalls[0]
    // 不能断言精确相等:标准提交模式下最终 message = `${type}: ${description}`,
    // 填"feat: xxx"会拼成"feat: feat: xxx"。只断言描述文本被带上了。
    expect(String(body.message)).toContain('请求契约校验')
    expect(body.hasNewlines).toBe(false)
    // noVerify 反映用户的 skipHooks 设置,可能是 true 也可能是 false,
    // 断言"等于配置值"而不是写死,两种配置下都成立
    expect(body.noVerify).toBe(Boolean(cfg.skipHooks))

    await expect(page.locator('.el-message--success')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.el-message--success')).toContainText('提交成功')

    // clearCommitFields 清空输入;但开了"自动填充默认提交信息"时,清空后会被
    // 立刻回填成 defaultCommitMessage,所以期望值取决于该开关
    const expected = cfg.autoSetDefaultMessage ? String(cfg.defaultCommitMessage || '') : ''
    await expect.poll(() => readCommitMessage(page), { timeout: 15_000 }).toBe(expected)
  })

  test('提交失败:提示原因、保留用户输入、恢复按钮', async ({ page }) => {
    const api = await newApi()
    await stageFixture(api)
    await api.dispose()

    await interceptCommit(page, { success: false, error: '模拟提交失败' })
    await gotoApp(page)

    await fillCommitMessage(page, '失败路径保留输入')
    await page.locator('.commit-button').click()

    await expect(page.locator('.el-message--error')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.el-message--error')).toContainText('模拟提交失败')

    // 失败时不能清空输入,否则用户白敲一遍
    expect(await readCommitMessage(page)).toContain('失败路径保留输入')
    // 按钮要恢复可用,不能卡在 busy 态
    await expect(page.locator('.commit-button')).toBeEnabled()
  })
})

test.describe('API: /api/commit 契约', () => {
  test('提交信息为空时被拒绝,且不产生新提交', async () => {
    const api = await newApi()

    const headBefore = await (await api.get('/api/log?page=1')).json()

    const r = await api.post('/api/commit', {
      data: { message: '', hasNewlines: false, noVerify: true },
    })
    const data = await r.json()
    expect(data.success).toBe(false)

    // HEAD 没动,确认没有产生新提交
    const headAfter = await (await api.get('/api/log?page=1')).json()
    expect(JSON.stringify(headAfter)).toBe(JSON.stringify(headBefore))
    await api.dispose()
  })
})
