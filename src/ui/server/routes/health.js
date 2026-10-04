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
// 健康探针 API：供前端在「疑似服务端已退出」的确认窗口内轮询。
// 纯读、无副作用 —— 不复用 /api/instances 是因为它要扫注册表目录(pruneStale)，
// 每秒一次会把 fs.watch 广播和扫盘成本带进来(见 client/src/composables/useServerLifecycle.ts)。
//
// 路径故意不叫 /api/health：依赖里(某个代码索引中间件)已经注册了 /api/health 并返回
// 另一套结构，且注册在我们的路由之前，会把同名路由遮蔽掉，探针就读不到 pid 了。

/**
 * @param {object} opts
 * @param {import('express').Express} opts.app
 * @param {() => number} [opts.getPid] 注入仅为可测；默认当前进程
 * @param {() => number} [opts.getUptime] 注入仅为可测；默认当前进程
 */
export function registerHealthRoutes({
  app,
  getPid = () => process.pid,
  getUptime = () => process.uptime(),
}) {
  // 进程存活期间始终返回 200（优雅退出的 drain 期间也返回 200）：
  // 「永久关闭 vs 热重启」的区分交给前端结合 server_shutdown 广播 + pid 身份判断，
  // 这里返回 503 会让 drain 期间的探针全部失败、把慢重启误判成关闭。
  app.get('/api/instance-health', (req, res) => {
    res.json({
      success: true,
      pid: getPid(),
      uptime: Math.round(getUptime() * 1000),
    });
  });
}