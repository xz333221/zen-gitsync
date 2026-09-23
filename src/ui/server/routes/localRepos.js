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
// 本机 Git 仓库清单（远程仓库列表的「已克隆」徽标用）。
//
//   GET  /api/local-repos        取快照 —— 不阻塞：首次运行没有缓存时立刻回
//                                { scanning: true, repos: {} }，调用方过几秒再问
//   POST /api/local-repos/scan   强制重扫（"我刚才在别处克隆了个仓库"）
//
// 为什么 GET 不 await 扫描：全盘扫一次十几秒（见 utils/localRepoScan.js 的文件头），
// 把它挂在 HTTP 请求上会让仓库列表首屏跟着卡十几秒。宁可先给一份可能过期的，
// 也不要让用户对着转圈等。
//
// 安全口径：**不接受任何客户端传入的路径**。扫描根固定是"本机存在的盘符"，
// 跳过名单是模块里的常量 —— 没有任何参数能把它变成"遍历你指定的目录"。
// 所以它不需要像 /api/recent_directories/git-state 那样做白名单校验。
import { asyncRoute } from '../utils/asyncRoute.js'
import logger from '../utils/logger.js'
import { getLocalRepos, refreshLocalRepos } from '../utils/localRepoScan.js'

/**
 * 注册本机仓库清单路由。
 *
 * *Impl 参数是给单测留的注入口（与 registerRemoteReposRoutes 同一套做法）：
 * 默认实现会真去遍历磁盘，单测换成假实现就不必扫一遍真实文件系统。
 */
export function registerLocalReposRoutes({
  app,
  getLocalReposImpl = getLocalRepos,
  refreshReposImpl = refreshLocalRepos,
}) {
  app.get('/api/local-repos', asyncRoute(async (req, res) => {
    const snapshot = await getLocalReposImpl()
    res.json({ success: true, ...snapshot })
  }))

  app.post('/api/local-repos/scan', asyncRoute(async (req, res) => {
    // 刻意不 await 扫描本身（要十几秒）：这里只负责"开始"，结果由前端轮询 GET 拿。
    // refreshLocalRepos 会把状态同步置成 scanning，随后回来的 GET 就能看到。
    //
    // 必须显式 .catch：这是"发射后不管"的 promise，一旦 reject 就是**进程级**
    // unhandled rejection（Node 15+ 默认直接崩服务）。默认实现内部 try/catch 过、
    // 不会 reject，但注入口的存在意味着将来可能换实现，别把崩溃留成隐患。
    void Promise.resolve(refreshReposImpl()).catch((error) => {
      logger.warn('[local-repos] 手动重扫失败:', error?.message || error)
    })
    res.json({ success: true, started: true })
  }))
}
