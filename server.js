#!/usr/bin/env node
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
// GUI 后端独立启动入口(供 `npm run start:server` / `dev:server` 使用)。
// 仅启 Express + Socket.IO,不接管 CLI argv。`--no-open` 抑制自动打开浏览器。
//
import { perfMark, perfNow } from './src/ui/server/utils/perfMark.js'

const noOpen = process.argv.slice(2).includes('--no-open')

// 耗时锚点:此打点之后,后续各 perfMark 的 (+delta) 列才是"该段花了多少"。
// perfMark 门控在 ZEN_PERF=1(dev:server 已设),生产 `g ui` 不输出。
perfMark('server.js 入口 (perfMark 加载完)')

// 静态 import 改为动态 import:把 index.js 的 ESM 图加载(20+ 路由模块顶层 import)
// 挪到此处单独计时,定位"node 起进程 → 代码加载完"这一段的开销。
const tImport = perfNow()
const { default: startUIServer } = await import('./src/ui/server/index.js')
perfMark(`import index.js ESM 图加载 (${(perfNow() - tImport).toFixed(0)}ms)`)

const tStart = perfNow()
await startUIServer(noOpen, true)
perfMark(`startUIServer() 返回 (${(perfNow() - tStart).toFixed(0)}ms, 注: 服务器为异步 listen,真正就绪看 listening 打点)`)
