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
// package.json `main` 入口。供「以库方式 import zen-gitsync」的消费者使用:
//   import config from 'zen-gitsync'        // 配置对象
//   import { startServer } from 'zen-gitsync'  // 启动 GUI 后端
// CLI/GUI 的常规入口仍是 `bin.g = ./src/gitCommit.js`,不要从这里跑。
//
import config from './src/config.js'
import startUIServer from './src/ui/server/index.js'

export { config as default }

/**
 * 启动 GUI 后端(Express + Socket.IO)。
 * @param {boolean} [noOpen=false] true = 不自动打开浏览器
 * @returns {Promise<void>}
 */
export function startServer(noOpen = false) {
  // savePort=true: 当通过 npm script 启动时,把真实端口写到 .port 文件,
  // 以便 dev-ping / vite.config / 同进程 IPC 读取。
  return startUIServer(noOpen, true)
}
