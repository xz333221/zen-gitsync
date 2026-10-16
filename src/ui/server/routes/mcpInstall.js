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
// 「把 zen-gitsync 登记为别的工具的 MCP 服务」的 GUI 路由。
//
// 消费方是顶栏编辑器按钮的右键菜单（DirectorySelector.vue）：对支持 MCP 的工具
// （Claude Code / Codex / OpenCode / CodeBuddy / VS Code / Pi…）显示一项
// 「添加 zen-gitsync MCP」，点一下就走这里的 install。
//
// 为什么不在前端直接写配置文件：路径与格式的真相在 src/mcp/install.js（CLI 的
// `g mcp install` 与这里共用同一份），前端只传 target id。两边行为永远一致，
// 也不会出现"GUI 装上了、CLI 说没装"的分叉。
//
// 安全边界：写入范围被 TARGETS 的白名单钉死 —— target id 不在表里直接 400，
// 文件路径只能来自 target.file()，请求方无法指定任意路径。

import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import logger from '../utils/logger.js';
import { install, listTargets, uninstall } from '../../../mcp/install.js';

/** 安装结果 → 给人看的一句话。changed=false 说明配置里已经是同一条，没必要惊动用户。 */
function describeResult(label, result, removed) {
  if (result.skipped) return `${label}: ${result.reason}`;
  if (removed) return `${label}: 已移除（原文件已备份 .bak）`;
  if (!result.changed) return `${label}: 已存在，无需改动`;
  return `${label}: 已写入 ${result.file}${result.backup ? '（原文件已备份 .bak）' : ''}`;
}

export function registerMcpInstallRoutes({ app }) {
  // 各目标的登记状态（右键菜单打开时拉一次，用来显示「已添加 / 一键安装」）
  app.get('/api/mcp-install/targets', asyncRoute(async (req, res) => {
    const targets = await listTargets();
    res.json({ success: true, targets });
  }));

  // 一键登记。body: { target: '<TARGETS 里的 id>' }
  app.post('/api/mcp-install/install', asyncRoute(async (req, res) => {
    const target = String(req.body?.target || '').trim();
    if (!target) throw new HttpError(400, '缺少 target 参数');
    const result = await install(target);
    if (!result.ok) throw new HttpError(400, result.error || '登记失败');
    logger.info(`[mcp-install] ${target} → ${result.file} changed=${!!result.changed}`);
    const label = (await listTargets()).find(t => t.id === target)?.label || target;
    res.json({ success: true, ...result, message: describeResult(label, result, false) });
  }));

  // 移除登记（对称能力；菜单里暂不暴露，CLI `g mcp install --remove` 与将来的
  // 「已添加 → 再点一次移除」都用它）
  app.post('/api/mcp-install/remove', asyncRoute(async (req, res) => {
    const target = String(req.body?.target || '').trim();
    if (!target) throw new HttpError(400, '缺少 target 参数');
    const result = await uninstall(target);
    if (!result.ok) throw new HttpError(400, result.error || '移除失败');
    logger.info(`[mcp-install] remove ${target} → ${result.file}`);
    const label = (await listTargets()).find(t => t.id === target)?.label || target;
    res.json({ success: true, ...result, message: describeResult(label, result, true) });
  }));
}

export default { registerMcpInstallRoutes };
