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
