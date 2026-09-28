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
 * 文件列表（列表视图）行模型 + 虚拟滚动用的固定行高。
 *
 * 为什么单独抽一层：列表视图原来是 5 个 FileGroup 各自全量 v-for。Obsidian 资料库
 * 那类仓库会有 5000+ 未跟踪文件，实测（verify/file-list-perf.mjs，真实 Chromium）
 * 5073 条时首帧 ~11.5s、DOM 节点 13.1 万、刷新一次（fileList 换引用）重渲染 ~2.8s，
 * 表现就是"打开/刷新时卡一下"。
 *
 * 现在改成：把「未被折叠的分组」摊平成一维行数组（分组标题也是一行），
 * 交给 VirtualFileList 只渲染视口内的行。行高必须是常量，否则偏移量算不准，
 * 所以这里集中定义行高，样式侧（VirtualFileList / FileRow）按同样的数值写死。
 *
 * 新增分组或调整顺序 → 只改 GROUP_ORDER；改行高 → 同时改这里的常量和对应 CSS。
 */

export type FileGroupKey = 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'intent-to-add'

export interface ListFileItem {
  path: string
  type: string
}

export interface ListFileRow {
  kind: 'file'
  key: string
  groupKey: FileGroupKey
  file: ListFileItem
}

export interface ListHeaderRow {
  kind: 'header'
  key: string
  groupKey: FileGroupKey
  title: string
  count: number
  collapsed: boolean
}

export type ListRow = ListFileRow | ListHeaderRow

/** 文件行占位高 = 28px 行高 + 1px 行间距（见 FileRow.vue .file-item / .vfl__row--file） */
export const FILE_ROW_H = 29
/** 分组标题行占位高 = 6px 组间距 + 36px 标题条（见 VirtualFileList.vue .vfl__header） */
export const HEADER_ROW_H = 42

export function rowHeight(row: ListRow): number {
  return row.kind === 'header' ? HEADER_ROW_H : FILE_ROW_H
}

// 分组顺序与匹配规则，与原先模板里 5 个 <FileGroup> 一一对应（顺序不能改：
// 冲突最优先，其次已暂存 / 未暂存 / 已声明添加 / 未跟踪）
const GROUP_ORDER: { key: FileGroupKey; match: (f: ListFileItem) => boolean }[] = [
  { key: 'conflicted', match: (f) => f.type === 'conflicted' },
  { key: 'staged', match: (f) => f.type === 'added' },
  { key: 'unstaged', match: (f) => f.type === 'modified' || f.type === 'deleted' },
  { key: 'intent-to-add', match: (f) => f.type === 'intent-to-add' },
  { key: 'untracked', match: (f) => f.type === 'untracked' },
]

/**
 * 摊平成行数组。空分组不产生标题行（与原来 FileGroup 的 shouldShow 一致），
 * 折叠的分组只留标题行。
 */
export function buildListRows(
  files: readonly ListFileItem[],
  collapsed: Record<FileGroupKey, boolean>,
  titles: Record<FileGroupKey, string>,
): ListRow[] {
  const rows: ListRow[] = []
  for (const group of GROUP_ORDER) {
    const matched = files.filter(group.match)
    if (!matched.length) continue

    const isCollapsed = !!collapsed[group.key]
    rows.push({
      kind: 'header',
      key: `h:${group.key}`,
      groupKey: group.key,
      title: titles[group.key],
      count: matched.length,
      collapsed: isCollapsed,
    })
    if (isCollapsed) continue

    for (const file of matched) {
      rows.push({ kind: 'file', key: `f:${group.key}:${file.path}`, groupKey: group.key, file })
    }
  }
  return rows
}

/** 偏移表 / 二分定位是通用逻辑，见 utils/virtualRows.ts（列表与树状视图共用） */
