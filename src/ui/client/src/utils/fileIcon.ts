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
import { resolveMaterialIcon, toSpriteId } from './materialFileIcons'

export interface FileIconInfo {
  /** sprite id 完整字符串（含 mit- 前缀），如 'mit-folder-git'，可配合 <use :xlink:href> 使用 */
  spriteId: string
  /** 原始 key（不含前缀），调试用 */
  key: string
}

/**
 * 获取节点对应的 Material Icon Theme 图标信息
 * @param name 节点名称
 * @param isDirectory 是否为目录
 * @param expanded 目录是否处于展开状态
 */
export function getNodeIcon(name: string, isDirectory: boolean, expanded = false): FileIconInfo {
  const key = resolveMaterialIcon(name, isDirectory, expanded)
  return {
    spriteId: toSpriteId(key),
    key,
  }
}

/* ── 旧 API 兼容（仅供尚未迁移到 inline SVG 的位置使用） ──────────── */

// 历史说明：早期版本使用 file-icons-js 通过 CSS 字体伪元素渲染文件图标。
// 现已迁移到 Material Icon Theme SVG sprite（见 ./materialFileIcons.ts）。
// 以下两个函数仍导出，是因为 FileGroup / FileDiffViewer / SourceMapView / EditorView
// 的 inline 树仍以 `<use :xlink:href="#${...}">` 形式消费返回值。
// 它们的"返回值类型"从 CSS class 名（`icon-xxx`）变成了完整的 sprite id（含 `mit-` 前缀）。
export function getFileIconClass(fileName: string): string {
  return toSpriteId(resolveMaterialIcon(fileName, false, false))
}

export function getFolderIconClass(folderName: string): string {
  return toSpriteId(resolveMaterialIcon(folderName, true, false))
}
