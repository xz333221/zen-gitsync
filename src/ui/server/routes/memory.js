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
// 记忆库的浏览 / 删除接口（设置 → 记忆库面板用）。
//
// 口径（与其它 workbench 路由一致，详见 routes/workbench/index.js 头部三条）：
//   - 非 SSE 路由统一 asyncRoute 包装，**handler 内不写 try/catch**
//   - 定制状态码用 `throw new HttpError(4xx, msg)`
//   - 危险操作（删）要求调用方显式传 `confirm: true`
//
// ⚠️ **本文件不导出"任意路径"接口。** 前端只传 `{scope, file}`，
// 绝对路径由 src/memory/library.js 从 scope 重新拼（见那个文件头注释）。
// 这是结构性防越界：不合法参数压根不参与路径拼接，
// 也就没有"前端传个 path 就删到别处"的可能。**别为了"省一次校验"改成传路径。**

import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import {
  listScopes,
  listEntries,
  readEntry,
  deleteEntry,
  isValidScope,
  isValidFile,
  memoryDirExists,
  SCOPE_GLOBAL,
  SCOPE_GLOBAL_INDEX,
} from '../../../memory/library.js';

/** 批量删除的单次上限：再多就该分批，别让一个请求把整个库清空 */
const BATCH_MAX = 200;

function requireScope(scope) {
  if (!isValidScope(scope)) throw new HttpError(400, 'scope 不合法');
  return scope;
}

function requireFile(file) {
  if (!isValidFile(file)) throw new HttpError(400, 'file 不合法');
  return file;
}

export function registerMemoryRoutes({ app }) {
  // ── 有哪些可看的范围（全局两篇 + 每个项目）──────────────────────────
  app.get('/api/memory/scopes', asyncRoute(async (_req, res) => {
    const available = await memoryDirExists();
    if (!available) {
      // 没就绪是**合法状态**（用户还没开过工作台），给空列表而不是 500：
      // 面板据此显示"尚未初始化"，而不是一个看不懂的报错
      res.json({ success: true, available: false, scopes: [] });
      return;
    }
    res.json({ success: true, available: true, scopes: await listScopes() });
  }));

  // ── 某个范围下有哪些条目 ────────────────────────────────────────────
  app.get('/api/memory/entries', asyncRoute(async (req, res) => {
    const scope = requireScope(String(req.query.scope || ''));
    res.json({ success: true, scope, entries: await listEntries(scope) });
  }));

  // ── 读单条正文（展开看内容时按需拉）─────────────────────────────────
  app.get('/api/memory/entry', asyncRoute(async (req, res) => {
    const scope = requireScope(String(req.query.scope || ''));
    const file = requireFile(String(req.query.file || ''));
    const r = await readEntry(scope, file);
    if (r.error === 'invalid') throw new HttpError(400, 'scope 或 file 不合法');
    if (r.tooLarge) throw new HttpError(413, `内容过大（${Math.round(r.size / 1024)} KB），不予展示`);
    if (r.missing) throw new HttpError(404, '条目不存在');
    res.json({ success: true, scope, file, content: r.content, size: r.size, mtime: r.mtime });
  }));

  // ── 删一条（连带清掉 INDEX.md 里那行索引）───────────────────────────
  app.delete('/api/memory/entry', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, '需要 confirm: true');
    const scope = requireScope(String(req.body?.scope || ''));
    const file = requireFile(String(req.body?.file || ''));
    // 全局两篇是索引/规范本身，删了整套记忆就失去记账口径 —— 不给删
    if (scope === SCOPE_GLOBAL || scope === SCOPE_GLOBAL_INDEX) {
      throw new HttpError(400, '全局索引与规范文件不可删除');
    }
    const r = await deleteEntry(scope, file);
    res.json({ success: true, ...r });
  }));

  // ── 批量删 ──────────────────────────────────────────────────────────
  app.post('/api/memory/batch-delete', asyncRoute(async (req, res) => {
    if (req.body?.confirm !== true) throw new HttpError(400, '需要 confirm: true');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw new HttpError(400, '没有选中任何条目');
    if (items.length > BATCH_MAX) throw new HttpError(400, `一次最多删 ${BATCH_MAX} 条`);

    let removed = 0;
    let indexLinesRemoved = 0;
    const failed = [];
    for (const it of items) {
      const scope = String(it?.scope || '');
      const file = String(it?.file || '');
      if (!isValidScope(scope) || !isValidFile(file)) { failed.push({ scope, file, reason: 'invalid' }); continue; }
      if (scope === SCOPE_GLOBAL || scope === SCOPE_GLOBAL_INDEX) {
        failed.push({ scope, file, reason: 'protected' });
        continue;
      }
      try {
        const r = await deleteEntry(scope, file);
        if (r.removed) removed += 1;
        if (r.indexLineRemoved) indexLinesRemoved += 1;
      } catch (err) {
        // 单条失败**不中断整批** —— 否则前几条已删、后几条报错，用户重试会重复删
        failed.push({ scope, file, reason: err?.message || 'delete failed' });
      }
    }
    res.json({ success: true, removed, indexLinesRemoved, failed });
  }));
}
