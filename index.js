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
import config from './src/config.js'
import startUIServer from './src/ui/server/index.js'

// 导出配置
export { config as default }

// 导出启动服务器函数
export async function startServer(noOpen = false) {
  // 当通过 npm script 启动服务器时，应该保存端口信息
  return startUIServer(noOpen, true) // 传递 savePort=true
}
