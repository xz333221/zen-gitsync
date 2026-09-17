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
// 工作台侧边栏 E2E:任务条目单行展示 / 描述兜底 / 空任务不落盘 / 分组收起。
//
// 为什么整个用例都在 stub 任务接口:
//   1. 任务列表是用户的真实工作数据,不能用它做断言(数量、标题随时会变);
//   2. 这几条规则全是纯客户端行为(渲染 + 切走时丢弃),stub 后反而更可控。
//   只 stub /api/workbench/tasks(含 /tasks/<id>、/tasks/reorder),其余接口(prompts /
//   current-project / jobs)走真实后端 —— 分组 key 依赖真实当前工作目录。
//   注:任务接口是有 socket 广播的,若正好有另一个会话在并发改任务,
//   tasks:reordered 广播可能覆盖本地列表(概率极低,遇到就重跑)。

import { test, expect } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

type Row = Record<string, any>

function makeTask(over: Partial<Row>): Row {
  return {
    id: 'x', title: '', desc: '', promptId: null, type: 'simple', simpleOverride: '',
    subtasks: [], attachments: [], sequential: true, ...over
  }
}

/** 装载任务接口 stub。rowsRef.rows 是被 stub 的"服务端"任务表,deleted/created 记录调用。 */
async function stubTasks(
  page: Page,
  rowsRef: { rows: Row[] },
  deleted: string[],
  created: Row[]
) {
  // 必须用正则:glob 的 `*` 不跨 `/`,`**/api/workbench/tasks*` 匹配不到 DELETE /tasks/<id>,
  // 那样删除请求会打穿到真实后端(测试看着"通过",其实断言是死断言)。
  await page.route(/\/api\/workbench\/tasks(?:$|[/?])/, async (route: Route) => {
    const req = route.request()
    const method = req.method()
    if (method === 'GET') {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, tasks: rowsRef.rows }) })
    }
    if (method === 'POST') {
      const body = req.postDataJSON()
      created.push(body)
      const task = makeTask({ ...body, id: `t-new-${created.length}` })
      rowsRef.rows = [...rowsRef.rows, task]
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, task }) })
    }
    if (method === 'DELETE') {
      const id = req.url().split('/').pop()!
      deleted.push(id)
      rowsRef.rows = rowsRef.rows.filter(r => r.id !== id)
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true }) })
  })
}

/** 进工作台前先读出真实当前工作目录:分组 key 是它,stub 的任务要挂在它名下才算"当前项目组" */
async function currentProjectPath(page: Page): Promise<string> {
  const label = await page.locator('header button[aria-label^="切换工作目录: "]').first().getAttribute('aria-label')
  return (label || '').replace(/^切换工作目录:\s*/, '')
}

async function openWorkbench(page: Page) {
  await page.goto('/')
  await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
  await page.locator('.activity-bar button[aria-label^="工作台"]').first().click()
  await expect(page.locator('.workbench-pane')).toBeVisible()
}

test.describe('工作台侧边栏', () => {
  test('任务行单行展示、无标题回退描述、空任务不落盘', async ({ page }) => {
    const rowsRef = { rows: [] as Row[] }
    const deleted: string[] = []
    const created: Row[] = []

    await page.goto('/')
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
    const curPath = await currentProjectPath(page)
    expect(curPath.length).toBeGreaterThan(3)

    rowsRef.rows = [
      makeTask({ id: 't-real', title: '真实任务', desc: '真实描述', projectPath: curPath }),
      makeTask({
        id: 't-desc',
        title: '',
        desc: '这是一段没有任何标题、只能靠描述兜底显示的说明文字，足够长以触发省略号截断行为',
        projectPath: curPath
      }),
      makeTask({ id: 't-ghost', title: '', desc: '', projectPath: curPath }) // 历史遗留空任务
    ]
    await stubTasks(page, rowsRef, deleted, created)

    await page.locator('.activity-bar button[aria-label^="工作台"]').first().click()
    await expect(page.locator('.workbench-pane')).toBeVisible()

    const rowsLoc = page.locator('.workbench-pane .wb-task-item')
    await expect(rowsLoc.first()).toBeVisible({ timeout: 15_000 })

    // 标题和描述都为空的空任务在首屏被清理,列表只剩两条
    await expect.poll(() => deleted.join(',')).toContain('t-ghost')
    await expect(rowsLoc).toHaveCount(2)

    // 每行只有一条 title,meta 行(子任务数 / 附件数 / 类型 chip)已移除
    await expect(rowsLoc.first().locator('.wb-task-item__title')).toHaveCount(1)
    await expect(page.locator('.workbench-pane .wb-task-item__meta')).toHaveCount(0)
    await expect(page.locator('.workbench-pane .wb-task-item__num')).toHaveCount(0)
    await expect(page.locator('.workbench-pane .wb-task-item__type-toggle')).toHaveCount(0)

    // 无标题时用描述兜底,且单行省略
    const descTitle = page.locator('.workbench-pane .wb-task-item[data-task-id="t-desc"] .wb-task-item__title')
    await expect(descTitle).toHaveText(/^这是一段没有任何标题/)
    const css = await descTitle.evaluate(el => {
      const cs = getComputedStyle(el)
      return { ellipsis: cs.textOverflow, nowrap: cs.whiteSpace }
    })
    expect(css.ellipsis).toBe('ellipsis')
    expect(css.nowrap).toBe('nowrap')

    // 点「新建任务」→ 空任务允许短暂存在(用户可能正在输入),切走即丢弃
    await page.locator('.workbench-pane .wb-new-btn').click()
    await expect(rowsLoc).toHaveCount(3, { timeout: 15_000 })
    expect(created.length).toBe(1)
    await expect(page.locator('.workbench-pane .wb-task-item[data-task-id="t-new-1"]')).toBeVisible()

    await page.locator('.workbench-pane .wb-task-item[data-task-id="t-real"]').click()
    await expect.poll(() => deleted.join(',')).toContain('t-new-1')
    await expect(rowsLoc).toHaveCount(2, { timeout: 15_000 })

    // 有内容的任务切换不受影响:不能被误删
    expect(deleted.filter(d => d === 't-real' || d === 't-desc').length).toBe(0)
  })

  test('唯一分组被自动收起时,组头仍渲染且可展开', async ({ page }) => {
    const rowsRef = { rows: [] as Row[] }
    const deleted: string[] = []
    const created: Row[] = []
    // 只有"别的项目"的任务 → 单组且非当前项目 → 自动收起
    rowsRef.rows = [makeTask({ id: 't-other', title: '别的项目的任务', projectPath: 'E:\\some-other-project' })]

    await page.goto('/')
    await expect(page.locator('.loading-container')).toHaveCount(0, { timeout: 60_000 })
    await stubTasks(page, rowsRef, deleted, created)
    await page.locator('.activity-bar button[aria-label^="工作台"]').first().click()
    await expect(page.locator('.workbench-pane')).toBeVisible()

    // 组头是唯一的展开入口:不渲染就会出现"一条任务都没有、也没东西可点开"的假空列表
    const head = page.locator('.workbench-pane .wb-task-group__head').first()
    await expect(head).toBeVisible({ timeout: 15_000 })
    await expect(head.locator('.wb-task-group__count')).toHaveText('1')
    expect(deleted).not.toContain('t-other')

    const rowsLoc = page.locator('.workbench-pane .wb-task-item')
    await expect(rowsLoc).toHaveCount(0)
    await head.click()
    await expect(rowsLoc).toHaveCount(1)
    await expect(rowsLoc.first().locator('.wb-task-item__title')).toHaveText('别的项目的任务')
  })
})
