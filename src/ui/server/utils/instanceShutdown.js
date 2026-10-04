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
// 服务端优雅退出前的客户端广播：让每个 UI 标签页立即知道「宿主进程要走了」，
// 而不必等 15s 轮询失败或 socket 断开才发现。客户端收到后仍会走确认窗口
// (见 client/src/composables/useServerLifecycle.ts)，避免把 dev 热重启当成永久关闭。
//
// 抽成独立函数是为了可单测：shutdown 闭包嵌在 server/index.js 的
// registerCurrentInstance() 里，不值得为测试把它导出去。

/**
 * 广播 server_shutdown。任何异常都吞掉：shutdown 路径上不能因为通知失败
 * 而影响 drain / unregister / exit 主流程。
 *
 * @param {{ emit?: (event: string, payload: object) => void } | null | undefined} io
 * @param {{ pid: number, signal: string }} payload
 */
export function notifyShutdown(io, { pid, signal }) {
  try {
    io?.emit('server_shutdown', { pid, signal });
  } catch (_) {
    // 忽略：广播失败不影响关闭流程
  }
}