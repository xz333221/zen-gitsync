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
 */
export function canonicalProjectPath(p?: string | null): string {
  const s = (p || '').trim()
  return s.replace(/^([a-z])(?=:)/, (m) => m.toUpperCase())
}
