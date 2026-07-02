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
// Playwright e2e 配置
// 跑测试前需要: 1) 后端启动 (node server.js), 2) vite dev 启动 (npm run dev)
//
// 推荐用法:
//   cd src/ui/client
//   npm run dev   # 启 vite 在 5544
//   npx playwright test

import { defineConfig, devices } from '@playwright/test'

// 读后端端口
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const portFile = path.resolve(__dirname, '../../../.port')
let backendPort = 3000
try {
  if (fs.existsSync(portFile)) {
    backendPort = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) || 3000
  }
} catch {}

const VITE_PORT = 5544

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    // 必须 IPv4:本机 localhost 优先解析 [::1],但 vite strictPort 绑 127.0.0.1,
    // localhost 直连会超时。详见 .claude/rules/hmr-debug-check.md 规则 0。
    baseURL: `http://127.0.0.1:${VITE_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // 收集控制台错误,断言时方便定位
    // 注意: Element Plus 已知有 [Vue warn] Proxy(Object) 这种,默认不当作 fail
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ],
  // 自动启 dev server(本地复用、CI 强制启):
  // 顺序敏感——backend 先必须写 .port=5545,vite 后读它配 proxy(vite.config.ts:26-42)。
  // backend 用裸 node(不走 nodemon,避免文件改动触发重启杀掉测试进程)。
  webServer: [
    {
      // 必须传 PORT=5545:src/ui/server/index.js:517-523 端口策略默认随机,只有
      // 环境变量 PORT 才锁死端口。Windows cmd 不支持 PORT=5545 语法,用 cross-env。
      command: 'npx cross-env PORT=5545 node server.js --no-open',
      cwd: '../../..',
      port: 5545,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev:vue',
      cwd: '../..',
      port: 5544,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})

// 导出后端端口供测试用
export { backendPort, VITE_PORT }
