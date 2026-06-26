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
// 实例注册表 API 路由
// 当前只暴露只读列表；停止/启停他人实例属于 out-of-scope（v1 只做跳转导航）

import { asyncRoute } from '../utils/asyncRoute.js'

export function registerInstancesRoutes({ app, registry, getCurrentInstanceId }) {
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
}
