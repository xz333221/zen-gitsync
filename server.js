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
import startUIServer from './src/ui/server/index.js'

const noOpen = process.argv.slice(2).includes('--no-open')

startUIServer(noOpen, true)
