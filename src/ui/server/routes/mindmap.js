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
// 思维导图后端：管理 .mindmap.json 文件。
// 与 fs.js 的 /api/editor/* 不同，这里允许在用户选择的任意本地目录读写
// (思维导图作为独立文档库，不强制放在项目目录内)，但仍做基础路径校验：
//   1. 必须是绝对路径
//   2. 禁止控制字符 / NUL
//   3. 禁止根目录本身 (C:\ / /) 与系统关键目录 (Windows / System32)
//   4. 扩展名固定为 .mindmap.json，避免误读/误写其他 json
//
// 文件内容是 flow-mindmap 组件 exportData() 返回的 JSON 字符串，
// 直接以 utf-8 原样落盘，前端用 importData() 还原。

import { asyncRoute, HttpError } from '../utils/asyncRoute.js'
import logger from '../utils/logger.js'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const MINDMAP_EXT = '.mindmap.json'

// 控制字符（含 NUL）一概拒绝
const FORBIDDEN_CHARS = /[\x00-\x1f]/

// 系统关键目录黑名单（小写比较，覆盖 drive root 与 Windows 系统目录）
// 注意：这里只是兜底防呆，不是完整的安全方案 —— 用户仍可在任意普通目录读写。
const SYSTEM_DIRS = new Set(
  [
    'c:\\',
    'c:/',
    'd:\\',
    'd:/',
    '/',
    'c:\\windows',
    'c:/windows',
    'c:\\program files',
    'c:/program files',
    'c:\\program files (x86)',
    'c:/program files (x86)',
    'c:\\users',
    'c:/users'
  ]
)

function validatePath(input) {
  if (!input || typeof input !== 'string') {
    throw new HttpError(400, '路径必须是非空字符串')
  }
  const trimmed = input.trim()
  if (!trimmed) throw new HttpError(400, '路径不能为空')
  if (FORBIDDEN_CHARS.test(trimmed)) throw new HttpError(400, '路径包含非法控制字符')
  if (trimmed.length > 4096) throw new HttpError(400, '路径过长')

  // 解析为绝对路径（相对当前 cwd 的会被补全，但前端一般直接传绝对路径）
  const resolved = path.resolve(trimmed)

  // 禁止根目录 / 系统关键目录
  const lower = resolved.toLowerCase()
  if (SYSTEM_DIRS.has(lower)) {
    throw new HttpError(400, '禁止在系统关键目录操作')
  }
  // Windows 上禁止盘符根 (C:\ C:/)，Unix 上禁止 /
  const winDriveRoot = /^[a-z]:[\\/]+$/i.test(lower)
  const unixRoot = lower === '/'
  if (winDriveRoot || unixRoot) {
    throw new HttpError(400, '禁止在磁盘根目录操作')
  }

  return resolved
}

// 确保文件路径扩展名为 .mindmap.json，避免误写其他文件
function ensureMindmapExt(resolvedPath) {
  if (!resolvedPath.toLowerCase().endsWith(MINDMAP_EXT)) {
    throw new HttpError(400, `仅支持 ${MINDMAP_EXT} 扩展名`)
  }
  return resolvedPath
}

// 判断 resolved 是否在 dir (已 resolved) 内（含自身）
function isInside(childResolved, dirResolved) {
  if (childResolved === dirResolved) return true
  const rel = path.relative(dirResolved, childResolved)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function registerMindmapRoutes({ app }) {
  // ── 列出目录下的思维导图文件 ──────────────────────────────────────
  app.get(
    '/api/mindmap/list',
    asyncRoute(async (req, res) => {
      const dirRaw = req.query.dir || req.query.path
      if (!dirRaw) throw new HttpError(400, '缺少 dir 参数')
      const dir = validatePath(dirRaw)

      let stat
      try {
        stat = await fs.stat(dir)
      } catch (e) {
        throw new HttpError(404, `目录不存在: ${dir}`)
      }
      if (!stat.isDirectory()) throw new HttpError(400, '目标不是目录')

      const entries = await fs.readdir(dir, { withFileTypes: true })
      const files = []
      for (const e of entries) {
        // 只收 .mindmap.json 文件，跳过目录/隐藏文件
        if (!e.isFile()) continue
        if (e.name.startsWith('.')) continue
        if (!e.name.toLowerCase().endsWith(MINDMAP_EXT)) continue
        const fullPath = path.join(dir, e.name)
        try {
          const st = await fs.stat(fullPath)
          files.push({
            name: e.name,
            path: fullPath,
            size: st.size,
            mtime: st.mtimeMs,
            // 展示用名（去掉扩展名）
            title: e.name.slice(0, -MINDMAP_EXT.length)
          })
        } catch {
          // stat 失败的条目跳过，不阻塞整个列表
        }
      }
      // 按修改时间倒序（最新在上）
      files.sort((a, b) => b.mtime - a.mtime)
      res.json({ success: true, dir, files })
    })
  )

  // ── 读取单个思维导图 ──────────────────────────────────────────────
  app.get(
    '/api/mindmap/read',
    asyncRoute(async (req, res) => {
      const pathRaw = req.query.path
      if (!pathRaw) throw new HttpError(400, '缺少 path 参数')
      const resolved = ensureMindmapExt(validatePath(pathRaw))

      let stat
      try {
        stat = await fs.stat(resolved)
      } catch (e) {
        throw new HttpError(404, `文件不存在: ${resolved}`)
      }
      if (!stat.isFile()) throw new HttpError(400, '目标不是文件')
      // 限制 10 MB，避免读巨型文件卡死
      if (stat.size > 10 * 1024 * 1024) {
        throw new HttpError(413, '文件过大 (> 10 MB)')
      }
      const content = await fs.readFile(resolved, 'utf-8')
      res.json({
        success: true,
        path: resolved,
        content,
        mtime: stat.mtimeMs,
        title: path.basename(resolved).slice(0, -MINDMAP_EXT.length)
      })
    })
  )

  // ── 保存（覆盖写） ──────────────────────────────────────────────
  // body: { path, content }
  app.put(
    '/api/mindmap/save',
    asyncRoute(async (req, res) => {
      const { path: pathRaw, content } = req.body || {}
      if (!pathRaw) throw new HttpError(400, '缺少 path 参数')
      if (content === undefined || content === null) {
        throw new HttpError(400, '缺少 content 参数')
      }
      if (typeof content !== 'string') {
        throw new HttpError(400, 'content 必须是字符串')
      }
      const resolved = ensureMindmapExt(validatePath(pathRaw))

      // 确保父目录存在（用户可能在选择目录后又删了它）
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, content, 'utf-8')
      const st = await fs.stat(resolved)
      logger.info(`[mindmap] 保存 ${resolved} (${content.length} bytes)`)
      res.json({
        success: true,
        path: resolved,
        mtime: st.mtimeMs,
        size: st.size
      })
    })
  )

  // ── 新建空白思维导图 ──────────────────────────────────────────────
  // body: { dir, name }
  // 返回新文件的完整路径 + 初始 content
  app.post(
    '/api/mindmap/create',
    asyncRoute(async (req, res) => {
      const { dir: dirRaw, name } = req.body || {}
      if (!dirRaw) throw new HttpError(400, '缺少 dir 参数')
      if (!name || typeof name !== 'string') {
        throw new HttpError(400, '缺少 name 参数')
      }
      // name 不允许含路径分隔符，避免注入
      if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) {
        throw new HttpError(400, '名称包含非法字符')
      }
      const dir = validatePath(dirRaw)

      // 确保 dir 存在
      try {
        const st = await fs.stat(dir)
        if (!st.isDirectory()) throw new HttpError(400, 'dir 不是目录')
      } catch (e) {
        if (e instanceof HttpError) throw e
        throw new HttpError(404, `目录不存在: ${dir}`)
      }

      // 拼接文件名：用户输入 + .mindmap.json
      const fileName = name + MINDMAP_EXT
      const fullPath = path.join(dir, fileName)
      const resolved = ensureMindmapExt(validatePath(fullPath))

      // 拒绝覆盖已存在文件
      try {
        await fs.access(resolved)
        throw new HttpError(409, `文件已存在: ${fileName}`)
      } catch (e) {
        if (e instanceof HttpError) throw e
        // 不存在，继续
      }

      // 初始内容：一个只有根节点的最小思维导图 JSON
      const initialData = {
        id: 'root',
        text: name || '中心主题',
        children: []
      }
      const initialContent = JSON.stringify(initialData, null, 2)
      await fs.writeFile(resolved, initialContent, 'utf-8')
      const st = await fs.stat(resolved)
      logger.info(`[mindmap] 新建 ${resolved}`)
      res.json({
        success: true,
        path: resolved,
        content: initialContent,
        mtime: st.mtimeMs,
        title: name
      })
    })
  )

  // ── 删除 ──────────────────────────────────────────────────────
  // body: { path }
  app.delete(
    '/api/mindmap/delete',
    asyncRoute(async (req, res) => {
      const { path: pathRaw } = req.body || {}
      if (!pathRaw) throw new HttpError(400, '缺少 path 参数')
      const resolved = ensureMindmapExt(validatePath(pathRaw))

      try {
        await fs.access(resolved)
      } catch {
        // 已不存在视为成功，幂等
        return res.json({ success: true, path: resolved, alreadyGone: true })
      }
      await fs.unlink(resolved)
      logger.info(`[mindmap] 删除 ${resolved}`)
      res.json({ success: true, path: resolved })
    })
  )

  // ── 重命名 ──────────────────────────────────────────────────────
  // body: { path, newName }
  app.post(
    '/api/mindmap/rename',
    asyncRoute(async (req, res) => {
      const { path: pathRaw, newName } = req.body || {}
      if (!pathRaw) throw new HttpError(400, '缺少 path 参数')
      if (!newName || typeof newName !== 'string') {
        throw new HttpError(400, '缺少 newName 参数')
      }
      if (/[\\/:*?"<>|\x00-\x1f]/.test(newName)) {
        throw new HttpError(400, '名称包含非法字符')
      }
      const resolved = ensureMindmapExt(validatePath(pathRaw))
      const dir = path.dirname(resolved)
      const newPath = ensureMindmapExt(validatePath(path.join(dir, newName + MINDMAP_EXT)))

      if (newPath.toLowerCase() === resolved.toLowerCase()) {
        // 大小写重命名（Windows 文件系统不区分大小写），需要中间名
        const tmp = path.join(dir, `.__tmp_rename_${Date.now()}${MINDMAP_EXT}`)
        await fs.rename(resolved, tmp)
        await fs.rename(tmp, newPath)
      } else {
        try {
          await fs.access(newPath)
          throw new HttpError(409, '目标文件已存在')
        } catch (e) {
          if (e instanceof HttpError) throw e
        }
        await fs.rename(resolved, newPath)
      }
      logger.info(`[mindmap] 重命名 ${resolved} -> ${newPath}`)
      res.json({ success: true, path: newPath })
    })
  )
}
