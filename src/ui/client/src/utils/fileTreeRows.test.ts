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
// 树状视图行模型回归：
// - 只摊平"可见节点"（祖先都展开的），折叠目录的子节点不进数组
// - 行里的 node 必须是剥掉 children 的浅拷贝（否则 TreeNodeItem 会自己递归 → 白虚拟化）
// - source 必须是真节点（展开/折叠改它）
import { describe, test, expect } from 'vitest'
import { buildFileTree, type TreeNode } from './fileTree'
import { buildTreeRows, treeRowHeight, TREE_HEADER_ROW_H, TREE_NODE_ROW_H, type TreeGroupInput } from './fileTreeRows'
import type { FileGroupKey } from './fileListRows'

const NO_COLLAPSE: Record<FileGroupKey, boolean> = {
  conflicted: false,
  staged: false,
  unstaged: false,
  'intent-to-add': false,
  untracked: false,
}

function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce((n, node) => n + (node.isDirectory ? countFiles(node.children ?? []) : 1), 0)
}

function group(tree: TreeNode[], key: FileGroupKey = 'untracked'): TreeGroupInput {
  // count 是「文件数」（GitStatus 传的就是分组里的文件条数），不是顶层节点数
  return { key, title: '未跟踪的文件', count: countFiles(tree), tree }
}

/** a/b/c.md + a/d.md + e.md */
function sampleTree(): TreeNode[] {
  return buildFileTree([
    { path: 'a/b/c.md', type: 'untracked' },
    { path: 'a/d.md', type: 'untracked' },
    { path: 'e.md', type: 'untracked' },
  ])
}

describe('fileTreeRows', () => {
  test('目录默认展开时：标题行 + 所有可见节点，层级递增', () => {
    const rows = buildTreeRows([group(sampleTree())], NO_COLLAPSE)

    expect(rows[0]).toMatchObject({ kind: 'tree-header', groupKey: 'untracked', collapsed: false })
    expect(rows.slice(1).map((r) => (r.kind === 'node' ? `${r.level}:${r.source.path}` : 'X'))).toEqual([
      '0:a',
      '1:a/b',
      '2:a/b/c.md',
      '1:a/d.md',
      '0:e.md',
    ])
    expect(rows.slice(1).every((r) => r.kind === 'node' && r.node.children === undefined)).toBe(true)
  })

  test('折叠某个目录后：该目录的子孙都不进数组，但真节点仍然存在', () => {
    const tree = sampleTree()
    const a = tree.find((n) => n.path === 'a')!
    a.expanded = false

    const rows = buildTreeRows([group(tree)], NO_COLLAPSE)
    expect(rows.slice(1).map((r) => (r.kind === 'node' ? r.source.path : 'X'))).toEqual(['a', 'e.md'])
    // 真节点的 children 没被动过（只是没进数组）
    expect(a.children?.length).toBe(2)
  })

  test('行里的 node 是浅拷贝，source 是同一个真节点引用（修改展开态才能生效）', () => {
    const tree = sampleTree()
    const rows = buildTreeRows([group(tree)], NO_COLLAPSE)
    const row = rows[1]
    expect(row.kind).toBe('node')
    if (row.kind !== 'node') return

    expect(row.source).toBe(tree[0])
    expect(row.node).not.toBe(tree[0])
    // 拷贝保留了渲染要用的字段
    expect(row.node.isDirectory).toBe(true)
    expect(row.node.expanded).toBe(true)
  })

  test('折叠整个分组 → 只剩标题行（count 仍是文件数）', () => {
    const rows = buildTreeRows([group(sampleTree())], { ...NO_COLLAPSE, untracked: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tree-header', collapsed: true, count: 3 })
  })

  test('空分组不产生标题行；多分组保持传入顺序', () => {
    const rows = buildTreeRows([
      { key: 'conflicted', title: '冲突文件', count: 0, tree: [] },
      group(sampleTree()),
      { key: 'staged', title: '已暂存的更改', count: 0, tree: [] },
    ], NO_COLLAPSE)

    expect(rows.filter((r) => r.kind === 'tree-header')).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'tree-header', groupKey: 'untracked' })
  })

  test('行高常量：标题 42 / 节点 33（与 CSS 必须一致）', () => {
    expect(TREE_HEADER_ROW_H).toBe(42)
    expect(TREE_NODE_ROW_H).toBe(33)
    expect(treeRowHeight({ kind: 'tree-header' } as any)).toBe(42)
    expect(treeRowHeight({ kind: 'node' } as any)).toBe(33)
  })

  test('5000 个文件的树：摊平结果 = 1 标题 + 所有节点，且每个节点的 key 唯一', () => {
    const files = Array.from({ length: 5073 }, (_, i) => ({
      path: `Resources 资源/课程-${i % 7}/第${i % 13}章/file-${i}.md`,
      type: 'untracked',
    }))
    const tree = buildFileTree(files)
    const rows = buildTreeRows([group(tree)], NO_COLLAPSE)

    const nodeRows = rows.filter((r) => r.kind === 'node')
    expect(nodeRows.length).toBeGreaterThanOrEqual(5073)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})
