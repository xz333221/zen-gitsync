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
// 实例注册表 API 路由：列表、跳转所需元数据，以及关闭其他已注册实例。

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

  // 只允许关闭注册表中仍存活的“其他实例”。前端不能传 signal 或任意命令。
  app.post('/api/instances/:pid/close', asyncRoute(async (req, res) => {
    const pidText = String(req.params?.pid || '');
    if (!/^\d+$/.test(pidText)) {
      throw new HttpError(400, '实例 PID 无效');
    }

    const pid = Number(pidText);
    const currentInstanceId = typeof getCurrentInstanceId === 'function'
      ? getCurrentInstanceId()
      : null;
    if (pid === currentInstanceId) {
      throw new HttpError(400, '不能从当前页面关闭当前实例');
    }

    const instances = await registry.list({ pruneStale: true });
    const target = instances.find((instance) => instance.pid === pid);
    if (!target) {
      throw new HttpError(404, '实例不存在或已经关闭');
    }

    try {
      killProcess(pid, 'SIGTERM');
    } catch (error) {
      if (error?.code === 'ESRCH' || error?.code === 'ENOENT') {
        await registry.unregister(pid);
        throw new HttpError(404, '实例已经关闭');
      }
      throw new HttpError(500, `关闭实例失败: ${error?.message || error}`);
    }

    // Windows 的 process.kill 会直接终止目标，来不及执行目标自身的 unregister；
    // 由发起关闭的一侧立即从注册表摘除，watch 会广播最新列表。
    await registry.unregister(pid);
    res.json({
      success: true,
      closedPid: pid,
      message: `已关闭实例 ${target.projectName || pid}`,
    });
  }));

  // 批量关闭注册表中所有非当前实例。逐个走 kill + unregister，失败不影响其他项。
  app.post('/api/instances/close-all', asyncRoute(async (req, res) => {
    const currentInstanceId = typeof getCurrentInstanceId === 'function'
      ? getCurrentInstanceId()
      : null;

    const instances = await registry.list({ pruneStale: true });
    const targets = instances.filter((instance) => instance.pid !== currentInstanceId);

    const results = await Promise.all(targets.map(async (target) => {
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
      results,
    });
  }));
}
