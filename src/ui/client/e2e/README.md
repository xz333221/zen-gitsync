# E2E 测试 (Playwright)

端到端测试,模拟真实用户操作,验证 UI 交互。

## 准备工作

跑测试前需要启两个服务:

1. **后端** (默认端口 3000):
   ```bash
   cd <项目根>
   node server.js
   ```
   后端启动后会在项目根生成 `.port` 文件,Playwright 会读这个文件确定后端端口。

2. **Vite dev server** (端口 5544):
   ```bash
   cd src/ui/client
   npm run dev
   ```

## 跑测试

```bash
cd src/ui/client

# 跑所有测试
npm run e2e

# UI 模式(可视化,可单步调试)
npm run e2e:ui

# 有头模式(弹出真实浏览器看)
npm run e2e:headed

# 看上次失败测试的报告
npm run e2e:report
```

## 目录结构

- `playwright.config.ts` — Playwright 配置
- `e2e/*.spec.ts` — 测试用例
  - `commit-flow.spec.ts` — 提交主流程(按钮守卫/命令预览/成功/失败/请求体契约)
  - `app-smoke.spec.ts` — 应用冒烟(启动/导航/默认视图)
  - `selective-stage.spec.ts` — 选择性暂存
  - `directory-selector.spec.ts` — 目录选择器/Ctrl+点击新标签
  - `dialog-system.spec.ts` — 弹窗系统
  - `remote-management.spec.ts` — 远程仓库管理
  - `drawer-*.spec.ts` — Git 抽屉样式截图

## 写新测试前必读(踩坑记录)

1. **不要在测试里制造真实 commit**。`/api/reset-head` 只是 `git reset HEAD`,
   撤销不了提交对象。需要测提交链路时用 `page.route` 拦截 `/api/commit`,
   参考 `commit-flow.spec.ts` 的 `interceptCommit`。
2. **不要 stub `/api/status_porcelain` 伪造暂存状态**。应用状态是 HTTP 轮询 +
   socket.io 广播双通道,只 stub HTTP 一路会被广播刷回真实值,用例随机挂。
   要"有暂存文件"就造一个真实的 fixture 文件再调 `/api/add-files`,
   清理用 `/api/unstage-file`(精准,不碰用户暂存区),参考 `commit-flow.spec.ts`。
3. **本机(Windows+chromium)下用例数不要超过 3 个、同一页面别连续点多次提交**。
   超过后新 context 会间歇性卡死:不输出、不超时。裸 Playwright 脚本复现卡在
   `browser.close()`,是 chromium 资源释放问题,不是测试逻辑问题。
   排查这类卡死可以写裸脚本逐步打印耗时,一次定位。
   (2026-09-27 实测:全套 48 例连跑正常,该卡死比过去少见;仍建议**同一页面别连点多次提交**。)
4. **服务端日志已默认丢弃**(`stdout: 'ignore'`):后端每次 git 操作都打印大表格,
   管道缓冲区灌满会把后端憋死,表现为用例整体卡住。要看日志时加
   `E2E_SHOW_SERVER_LOG=1`(代价是又可能触发卡死,仅调试用)。
5. **提交信息断言用 `toContain`(描述文本),不要精确相等**。标准提交模式下
   最终 message = `${type}: ${description}`,输入带 "feat: " 前缀会拼成
   "feat: feat: xxx"。
6. **断言 Element Plus 的 toast 必须按文案过滤**
   (`page.locator('.el-message--success', { hasText: 'xxx' })`)。应用自身会弹
   「Git 状态已刷新」这类提示,直接断言类名会在两个 toast 同屏时被 strict mode
   判成多元素命中(见 commit-flow.spec.ts / remote-management.spec.ts)。
7. **`page.route` 的 glob `*` 不跨 `/`**。拦 `DELETE /api/workbench/tasks/<id>`
   这类带路径段的请求要用正则 `/\/api\/workbench\/tasks(?:$|[/?])/`,
   否则删除请求打穿到真实后端,而本地乐观更新的列表看起来"也对",
   断言会变成永不失败的死断言。
8. **只 stub HTTP 不足以接管数据时,先确认页面的权威数据源**。应用有多条数据通道
   (HTTP 轮询、socket.io、SSE `/api/workbench/events`);只 stub 其中一路时,
   另一路会把状态刷回真实值。判断"stub 到底有没有生效"要看请求是否被命中
   (`page.route` 里计数),而不是看断言结果。
9. **断言 UI 改版后的选择器要核对当前 DOM**。工作台的 `.wb-sidebar` /
   `.wb-task-item*` / `.wb-task-group__head` 已随 board 布局改版从 DOM 消失
   (旧的 `workbench-sidebar.spec.ts` 即因此失效并删除)。`.workbench-pane`、
   `.editor-pane` 这类**外壳**是 App.vue 里的 `v-show` 容器,断言它 visible
   并不能证明异步视图真的渲染成功 —— 要断言视图内部的类名。
10. **复用已在跑的 dev server 时,首跑可能有一次"假失败"**。`playwright.config.ts`
   里是 `reuseExistingServer: !CI`,会直接挂到你手动起的 5544/5545 上。若此前
   `node_modules` 里的依赖变过(升级/换包),Vite 会在测试中途才重新预构建并触发
   整页 reload,把**排在后面**的用例的异步 chunk 打断(症状:页面卡在
   ViewLoading 的"加载中...")。**重跑一遍即过**,不要去改代码。
11. **产物目录会被沙箱的批量删除护栏拦住**。Playwright 每次跑都会清
   `test-results/`(>50 个文件时触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`,
   且当前环境没有放行开关)→ 用 `--output=<临时目录>` 跑:
   ```bash
   node node_modules/@playwright/test/cli.js test --output=/tmp/pw-out
   ```

## 写新测试

参考 `e2e/directory-selector.spec.ts` 里的写法:

```ts
import { test, expect } from '@playwright/test'

test('测试名', async ({ page }) => {
  await page.goto('/')
  // ... 你的测试
})
```

## 常用 API

- `page.goto('/')` — 访问 baseURL
- `page.locator('.css-selector')` — 选元素
- `await locator.click()` — 点击
- `await locator.click({ modifiers: ['Control'] })` — Ctrl+点击(Mac 用 `Meta`)
- `await locator.fill('text')` — 输入框填值
- `await locator.getAttribute('title')` — 读属性
- `expect(locator).toBeVisible()` — 断言可见
- `expect(locator).toHaveText('xxx')` — 断言文本
- `page.on('request', ...)` — 监听网络请求
- `page.on('console', ...)` — 监听控制台

完整文档: https://playwright.dev/docs/intro
