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
 * 路径处理工具函数
 */

/**
 * 从完整路径中提取文件夹名称
 * @param path 完整路径
 * @returns 文件夹名称，如果路径为空则返回默认值
 */
export function getFolderNameFromPath(path: string): string {
  if (!path) return 'Zen GitSync'

  // 处理Windows和Unix路径
  const parts = path.replace(/\\/g, '/').split('/')

  // 过滤空字符串并返回最后一个部分
  const filtered = parts.filter(p => p)

  return filtered.length > 0 ? filtered[filtered.length - 1] : 'Zen GitSync'
}

/**
 * 规范化项目路径,用于分组 key / 相等性比较。
 *
 * 背景:Windows 文件系统不区分大小写,字符串比较区分,而同一目录在数据里
 * 会出现好几种写法,每一种都曾造成"同一项目被拆成两个":
 *   - 盘符大小写:后端 process.cwd() 保留启动时输入的盘符大小写,
 *     `e:\workspace\x` 与 `E:\workspace\x` 并存 → 侧边栏重复分组。
 *   - 目录段大小写:常用目录存的是用户手输的原始串(不落盘规范化),
 *     `c:\users\xuze3` 与任务带出的 `C:\Users\xuze3` 并存 → 左栏两条同名项目
 *     (2026-09-18 实测)。
 *   - 斜杠方向:常用目录允许手输,`D:/ws/proj` 与 `D:\ws\proj` 并存
 *     → article-generator 曾出现两次。
 *
 * 所以 Windows 形式统一成「小写 + 反斜杠」。小写化刻意做进 key 本身、
 * 而不是留给每处比较自己归一:key 会被拿去查统计表、比选中项、比派发目标,
 * 漏一处就重新裂开。规则收在这一处,调用方拿到的 key 天然可跨写法比较。
 *
 * 只处理 Windows 形式(带盘符);POSIX 路径原样返回 —— Windows 才不区分大小写,
 * 把 `/home/me` 小写化会真的把两个不同目录并成一个,那是数据错误不是修重复。
 *
 * ⚠️ 这个函数与后端 src/ui/server/routes/workbench/projectRegistry.js 的
 * 同名函数必须**逐字一致** —— 两侧分组 key 不同,同一目录就会分裂成两个项目。
 */
export function canonicalProjectPath(p?: string | null): string {
  const s = (p || '').trim()
  if (!/^[a-zA-Z]:/.test(s)) return s
  return s.replace(/\//g, '\\').toLowerCase()
}
