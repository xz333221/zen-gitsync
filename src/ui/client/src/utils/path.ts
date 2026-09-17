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
 * 背景:Windows 上后端 process.cwd() 会保留启动时输入的盘符大小写,
 * 同一目录在历史数据里可能同时存在 `e:\workspace\x` 与 `E:\workspace\x`
 * 两种写法;文件系统不区分大小写,但字符串比较会把它们当成两个项目,
 * 导致工作台侧边栏出现重复分组。这里统一把盘符转大写。
 *
 * 另外常用目录允许用户手输,同一目录还会有 `D:/ws/proj` 与 `D:\ws\proj`
 * 两种斜杠写法,同样会被字符串比较拆成两个项目(实测项目列表里
 * article-generator 出现了两次)。所以 Windows 形式统一归成反斜杠。
 *
 * 只处理 Windows 形式(带盘符);POSIX 路径原样返回,免得把 `/home/me`
 * 改写成 `\home\me`。
 *
 * ⚠️ 这个函数与后端 src/ui/server/routes/workbench/projectRegistry.js 的
 * 同名函数必须**逐字一致** —— 两侧分组 key 不同,同一目录就会分裂成两个项目。
 */
export function canonicalProjectPath(p?: string | null): string {
  const s = (p || '').trim()
  if (!/^[a-zA-Z]:/.test(s)) return s
  return s.replace(/^([a-z])(?=:)/, (m) => m.toUpperCase()).replace(/\//g, '\\')
}
