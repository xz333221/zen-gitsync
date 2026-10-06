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
// 实例注册表 API 路由：列表、跳转所需元数据，以及关闭已注册实例。
//
// 「关闭当前实例」在这里有一个平台陷阱，改这两条路由前务必先读：
//   Windows 上 process.kill(自身 pid, 'SIGTERM') 被 libuv 转成 TerminateProcess，
//   是**当场终止本进程**，JS 层的 SIGTERM 监听器根本不跑（实测 node 22/win32：
//   子进程只留下 exit code 1，连 process.on('SIGTERM') 都没触发）。所以关自己
//   绝不能走 killProcess —— 那会让 res.json 发不出去、客户端只看到一个断连。
//   两条路由统一的做法：self 分支跳过 kill，res.json 之后再
//   setImmediate(() => process.emit('SIGTERM'))，触发 server/index.js 里那个
//   graceful shutdown(drain 子进程 + unregister + exit)。

import { asyncRoute, HttpError } from '../utils/asyncRoute.js'

export function registerInstancesRoutes({
  app,
  registry,
  getCurrentInstanceId,
  killProcess = process.kill.bind(process),
}) {
  // 获取所有活跃实例（自动 prune 失效条目）
  app.get('/api/instances', asyncRoute(async (req, res) => {
    const instances = await registry.list({ pruneStale: true });
    const currentInstanceId = typeof getCurrentInstanceId === 'function'
      ? getCurrentInstanceId()
      : null;
    res.json({
      success: true,
      instances,
      currentInstanceId
    });
  }));

  // 关闭注册表中仍存活的实例(含当前实例,见下方 selfClose 分支)。前端不能传
  // signal 或任意命令。当前实例的关闭走和 SIGINT 一样的 graceful shutdown 链路
  // (server/index.js 的 SIGTERM handler):drain 子进程 + unregister + exit,
  // 响应先于 SIGTERM 触发发出,所以客户端能拿到 success。
  app.post('/api/instances/:pid/close', asyncRoute(async (req, res) => {
    const pidText = String(req.params?.pid || '');
    if (!/^\d+$/.test(pidText)) {
      throw new HttpError(400, '实例 PID 无效');
    }

    const pid = Number(pidText);
    const currentInstanceId = typeof getCurrentInstanceId === 'function'
      ? getCurrentInstanceId()
      : null;
    const isSelfClose = pid === currentInstanceId;

    const instances = await registry.list({ pruneStale: true });
    const target = instances.find((instance) => instance.pid === pid);
    if (!target) {
      throw new HttpError(404, '实例不存在或已经关闭');
    }

    if (!isSelfClose) {
      try {
        killProcess(pid, 'SIGTERM');
      } catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'ENOENT') {
          await registry.unregister(pid);
          throw new HttpError(404, '实例已经关闭');
        }
        throw new HttpError(500, `关闭实例失败: ${error?.message || error}`);
      }
    }

    // Windows 的 process.kill 会直接终止目标，来不及执行目标自身的 unregister；
    // 由发起关闭的一侧立即从注册表摘除，watch 会广播最新列表。
    await registry.unregister(pid);
    res.json({
      success: true,
      closedPid: pid,
      message: `已关闭实例 ${target.projectName || pid}`,
      // 标记是否为当前实例。前端靠它决定要不要调 window.close() 关 tab。
      selfClose: isSelfClose,
    });
    if (isSelfClose) {
      // 同步把 SIGTERM 事件 emit 给本进程的 listener(handler 内部 async,且
      // 最后 setTimeout 100ms 才 exit);setImmediate 把 emit 推到下个 tick,
      // 确保上面的 res.json 已同步写到 socket buffer,客户端能收到响应。
      setImmediate(() => process.emit('SIGTERM'));
    }
  }));

  // 批量关闭注册表中**所有**实例(含当前实例)。逐个走 kill + unregister，失败不影响
  // 其他项；当前实例见文件头注释 —— 不 kill，交给响应之后的自身 SIGTERM。
  // 返回体的 selfClose 告诉前端「当前实例也在这批里」，前端据此走关 tab / 兜底遮罩。
  app.post('/api/instances/close-all', asyncRoute(async (req, res) => {
    const currentInstanceId = typeof getCurrentInstanceId === 'function'
      ? getCurrentInstanceId()
      : null;
    const isSelfClose = currentInstanceId != null;

    const instances = await registry.list({ pruneStale: true });

    const results = await Promise.all(instances.map(async (target) => {
      if (target.pid === currentInstanceId) {
        // 当前实例只记账：真正关闭由下面的 emit('SIGTERM') 触发，这里 kill 会
        // 当场杀死本进程(Windows)导致响应发不出去。
        return {
          pid: target.pid,
          projectName: target.projectName,
          success: true,
          self: true,
        };
      }
      try {
        killProcess(target.pid, 'SIGTERM');
      } catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'ENOENT') {
          await registry.unregister(target.pid);
          return {
            pid: target.pid,
            projectName: target.projectName,
            success: false,
            error: '实例已经关闭',
          };
        }
        return {
          pid: target.pid,
          projectName: target.projectName,
          success: false,
          error: `关闭失败: ${error?.message || error}`,
        };
      }
      // Windows 的 process.kill 直接终止目标，由发起侧立即摘除。
      await registry.unregister(target.pid);
      return {
        pid: target.pid,
        projectName: target.projectName,
        success: true,
      };
    }));

    const closed = results.filter((r) => r.success).length;
    const failed = results.length - closed;
    res.json({
      success: failed === 0,
      closed,
      failed,
      total: results.length,
      selfClose: isSelfClose,
      results,
    });
    if (isSelfClose) {
      // 同 :pid/close 的 self 分支：等 res.json 落到 socket buffer 再触发自身
      // graceful shutdown。当前实例的注册表条目由 shutdown 流程负责摘除。
      setImmediate(() => process.emit('SIGTERM'));
    }
  }));
}
