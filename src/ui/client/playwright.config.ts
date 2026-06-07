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
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
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
  // 不自动启 webServer —— 因为需要 .port 已存在(后端先起)
  // 用户手动跑: node server.js && npx playwright test
  // 设为空数组让 Playwright 跳过 webServer 检查
  webServer: undefined
})

// 导出后端端口供测试用
export { backendPort, VITE_PORT }
