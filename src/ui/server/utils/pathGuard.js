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
/**
 * 路径越界检查中间件 / 工具
 *
 * 用法：
 *   // 1. 中间件模式：自动从 req.query.path 提取并校验
 *   router.get('/api/foo', pathGuard('path'), handler)
 *
 *   // 2. 工具函数：在 handler 里手动校验
 *   const safePath = ensureWithinCwd(userPath, cwd)
 *
 * 防护：
 *   - 解析 `..`、相对路径
 *   - 拒绝以 `..` 开头或解析后是绝对路径的相对路径
 *   - Windows 大小写不敏感
 *   - 真实路径 (realpath) 防符号链接
 *
 * @typedef {Object} PathGuardOptions
 * @property {string} field - 从 req.query / req.body 取的字段名（默认 'path'）
 * @property {boolean} [allowMissing] - 字段缺失时是否通过（默认 false）
 * @property {boolean} [realpath] - 是否用 fs.realpath 进一步防符号链接（默认 false）
 */

import fs from 'fs/promises'
import path from 'path'

const isWindows = process.platform === 'win32'

/**
 * 把 user 输入路径解析成"在 cwd 内的绝对路径"，越界时返回 null
 *
 * @param {string} input - 用户提供的路径（相对 / 绝对 / 含 .. / 符号链接）
 * @param {string} cwd - 允许的根目录（当前项目目录）
 * @param {{ realpath?: boolean }} [opts]
 * @returns {Promise<{ safePath: string, realPath: string | null } | null>}
 *   - null 表示越界
 *   - safePath: 用于后续 path.resolve 等操作的绝对路径
 *   - realPath: realpath 结果（如果 opts.realpath=true 且文件存在）
 */
export async function ensureWithinCwd(input, cwd, opts = {}) {
  if (typeof input !== 'string' || !input) return null
  if (typeof cwd !== 'string' || !cwd) return null

  let resolved
  try {
    resolved = path.resolve(cwd, input)
  } catch {
    return null
  }

  // path.relative 返回以 .. 开头的字符串代表越界（其它平台绝对路径返回绝对路径本身）
  const rel = path.relative(cwd, resolved)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    // 在 cwd 内（相等或子路径）
  } else {
    return null
  }

  // Windows 大小写不敏感：把 cwd 和 resolved 都转小写再比一次，确保 \ 不会绕过
  if (isWindows) {
    const lowerCwd = cwd.toLowerCase()
    const lowerResolved = resolved.toLowerCase()
    if (!lowerResolved.startsWith(lowerCwd)) {
      return null
    }
  }

  let realPath = null
  if (opts.realpath) {
    try {
      realPath = await fs.realpath(resolved)
      // realpath 后再校验一次（符号链接可能指向 cwd 之外）
      const relReal = path.relative(cwd, realPath)
      const isOutside = relReal === '..' || relReal.startsWith('..' + path.sep) || path.isAbsolute(relReal)
      if (isOutside) return null
      if (isWindows && !realPath.toLowerCase().startsWith(cwd.toLowerCase())) return null
    } catch {
      // 文件不存在 / 无权限：保持 null，让调用者决定
    }
  }

  return { safePath: resolved, realPath }
}

/**
 * Express 中间件工厂
 *
 * @param {string} cwd - 当前项目根
 * @param {string | string[]} [fields] - 要校验的字段名（默认 'path'，支持数组多字段）
 * @param {{ realpath?: boolean }} [opts]
 */
export function pathGuard(cwd, fields = 'path', opts = {}) {
  const fieldList = Array.isArray(fields) ? fields : [fields]
  return async (req, res, next) => {
    try {
      for (const field of fieldList) {
        const raw = req.query?.[field] ?? req.body?.[field]
        if (raw === undefined || raw === null || raw === '') {
          if (opts.allowMissing) continue
          return res.status(400).json({ success: false, error: `缺少 ${field} 参数` })
        }
        const result = await ensureWithinCwd(String(raw), cwd, opts)
        if (!result) {
          return res.status(403).json({ success: false, error: `禁止访问工作目录以外的文件: ${raw}` })
        }
        // 把校验后的安全路径挂到 res.locals，handler 拿 res.locals.safePath 用
        res.locals.safePath = result.safePath
        res.locals.safeRealPath = result.realPath
      }
      next()
    } catch (e) {
      res.status(500).json({ success: false, error: e.message })
    }
  }
}

/**
 * 同步版本：只做路径解析校验，不做 realpath。用于不需要 fs 的纯路径场景
 * @returns {string|null} 安全路径或 null
 */
export function ensureWithinCwdSync(input, cwd) {
  if (typeof input !== 'string' || !input) return null
  if (typeof cwd !== 'string' || !cwd) return null

  let resolved
  try {
    resolved = path.resolve(cwd, input)
  } catch {
    return null
  }

  const rel = path.relative(cwd, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null

  if (isWindows) {
    const lowerCwd = cwd.toLowerCase()
    const lowerResolved = resolved.toLowerCase()
    if (!lowerResolved.startsWith(lowerCwd)) return null
  }

  return resolved
}
