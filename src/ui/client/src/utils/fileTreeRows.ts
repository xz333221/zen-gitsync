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
 * 树状视图行模型：把「分组标题 + 各分组里可见的树节点」摊平成一维行数组。
 *
 * 原来树状视图是 FileTreeView → TreeNodeItem 递归渲染，且 buildFileTree 默认
 * `expanded: true`，所以 5073 个文件 = 5078 行全量进 DOM：实测首帧 9.5s、
 * 11.6 万节点（同 utils/fileListRows.ts 顶部的背景）。摊平后交给
 * VirtualFileTree 只渲染视口内的行。
 *
 * ⚠️ 两个关键点：
 * 1. 只把 **可见节点**（其所有祖先都 expanded）放进行数组 —— 折叠目录的子节点不进数组；
 * 2. 行里的 `node` 是**剥掉 children 的浅拷贝**（另外用 `source` 记住真节点）：
 *    TreeNodeItem 只要看到 `children` 就会自己递归渲染，不剥掉等于白虚拟化；
 *    而展开/折叠要改的是真节点，所以 `source` 必须留着。
 */
import type { TreeNode } from './fileTree'
import { HEADER_ROW_H, type FileGroupKey } from './fileListRows'

/** 节点行高 = TreeNodeItem 的 .tree-node（min-height 32px + 1px border-bottom） */
export const TREE_NODE_ROW_H = 33
/** 分组标题行高（与列表视图的 pill 标题行同款：6px 组间距 + 36px 标题条） */
export const TREE_HEADER_ROW_H = HEADER_ROW_H

export interface TreeHeaderRow {
  kind: 'tree-header'
  key: string
  groupKey: FileGroupKey
  title: string
  count: number
  collapsed: boolean
}

export interface TreeFlatNode {
  kind: 'node'
  key: string
  groupKey: FileGroupKey
  level: number
  /** 给 TreeNodeItem 渲染用的浅拷贝（无 children） */
  node: TreeNode
  /** 真节点：展开/折叠、取 type 用这个 */
  source: TreeNode
}

export type TreeListRow = TreeHeaderRow | TreeFlatNode

export function treeRowHeight(row: TreeListRow): number {
  return row.kind === 'tree-header' ? TREE_HEADER_ROW_H : TREE_NODE_ROW_H
}

export interface TreeGroupInput {
  key: FileGroupKey
  title: string
  /** 该分组文件总数（标题行上的角标用，可能和可见节点数不同：目录也算节点） */
  count: number
  tree: readonly TreeNode[]
}

/** 递归摊平：目录折叠时不进子层，因此数组里天然只有可见节点 */
function flatten(nodes: readonly TreeNode[], groupKey: FileGroupKey, level: number, out: TreeListRow[]): void {
  for (const node of nodes) {
    out.push({
      kind: 'node',
      key: `n:${groupKey}:${node.path}`,
      groupKey,
      level,
      node: { ...node, children: undefined },
      source: node,
    })
    if (node.isDirectory && node.expanded && node.children?.length) {
      flatten(node.children, groupKey, level + 1, out)
    }
  }
}

export function buildTreeRows(
  groups: readonly TreeGroupInput[],
  collapsed: Record<FileGroupKey, boolean>,
): TreeListRow[] {
  const rows: TreeListRow[] = []
  for (const group of groups) {
    // 容错：分组树在刷新途中可能短暂为 undefined（状态刚清空/构建失败）
    if (!group.tree?.length) continue

    const isCollapsed = !!collapsed[group.key]
    rows.push({
      kind: 'tree-header',
      key: `th:${group.key}`,
      groupKey: group.key,
      title: group.title,
      count: group.count,
      collapsed: isCollapsed,
    })
    if (isCollapsed) continue

    flatten(group.tree, group.key, 0, rows)
  }
  return rows
}
