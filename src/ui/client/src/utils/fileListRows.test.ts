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
// 列表视图行模型 + 虚拟滚动偏移表回归。
// 关键不变量：行高常量与样式（FileRow.vue 28px+1px / VirtualFileList.vue 42px）一致，
// 摊平顺序与原来的 5 个 FileGroup 一致，折叠只砍文件行、保留标题行。
import { describe, test, expect } from 'vitest'
import {
  buildListRows,
  FILE_ROW_H,
  HEADER_ROW_H,
  rowHeight,
  type FileGroupKey,
  type ListFileItem,
} from './fileListRows'
import { buildOffsets, findRowAtOffset } from './virtualRows'

const buildRowOffsets = (rows: ReturnType<typeof buildListRows>) => buildOffsets(rows, rowHeight)

const NO_COLLAPSE: Record<FileGroupKey, boolean> = {
  conflicted: false,
  staged: false,
  unstaged: false,
  'intent-to-add': false,
  untracked: false,
}
const TITLES: Record<FileGroupKey, string> = {
  conflicted: '冲突文件',
  staged: '已暂存的更改',
  unstaged: '未暂存的更改',
  'intent-to-add': '已声明添加（待暂存）',
  untracked: '未跟踪的文件',
}

function f(path: string, type: string): ListFileItem {
  return { path, type }
}

describe('fileListRows', () => {
  test('空分组不产生标题行；分组顺序固定（冲突 → 已暂存 → 未暂存 → 待暂存 → 未跟踪）', () => {
    const files = [
      f('u.md', 'untracked'),
      f('c.md', 'conflicted'),
      f('m.md', 'modified'),
      f('a.md', 'added'),
      f('n.md', 'intent-to-add'),
    ]
    const rows = buildListRows(files, NO_COLLAPSE, TITLES)

    expect(rows.map((r) => (r.kind === 'header' ? `H:${r.groupKey}` : r.file.path))).toEqual([
      'H:conflicted',
      'c.md',
      'H:staged',
      'a.md',
      'H:unstaged',
      'm.md',
      'H:intent-to-add',
      'n.md',
      'H:untracked',
      'u.md',
    ])
  })

  test('untracked 组的 deleted 文件归到未暂存（与模板里 modified || deleted 一致）', () => {
    const rows = buildListRows([f('d.md', 'deleted')], NO_COLLAPSE, TITLES)
    expect(rows[0]).toMatchObject({ kind: 'header', groupKey: 'unstaged', count: 1 })
    expect(rows[1]).toMatchObject({ kind: 'file', groupKey: 'unstaged' })
  })

  test('无文件时不产生任何行（原来是 v-if="fileList.length"）', () => {
    expect(buildListRows([], NO_COLLAPSE, TITLES)).toEqual([])
  })

  test('折叠的分组只保留标题行，标题行带 collapsed 与数量', () => {
    const files = [f('u1.md', 'untracked'), f('u2.md', 'untracked'), f('m.md', 'modified')]
    const rows = buildListRows(files, { ...NO_COLLAPSE, untracked: true }, TITLES)

    expect(rows.map((r) => (r.kind === 'header' ? `H:${r.groupKey}` : r.file.path))).toEqual([
      'H:unstaged',
      'm.md',
      'H:untracked',
    ])
    expect(rows[2]).toMatchObject({ collapsed: true, count: 2, title: '未跟踪的文件' })
  })

  test('5000 条时只占一个标题行 + N 个文件行，总高按固定行高线性增长', () => {
    const files = Array.from({ length: 5073 }, (_, i) => f(`长目录/${i}.md`, 'untracked'))
    const rows = buildListRows(files, NO_COLLAPSE, TITLES)
    expect(rows.length).toBe(5074)
    expect(rows[0].kind).toBe('header')

    const offsets = buildRowOffsets(rows)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(HEADER_ROW_H)
    expect(offsets[2]).toBe(HEADER_ROW_H + FILE_ROW_H)
    expect(offsets[rows.length]).toBe(HEADER_ROW_H + 5073 * FILE_ROW_H)
  })

  test('findRowAtOffset：命中行首/行内/越界都收敛到合法下标', () => {
    const files = Array.from({ length: 10 }, (_, i) => f(`${i}.md`, 'untracked'))
    const rows = buildListRows(files, NO_COLLAPSE, TITLES)
    const offsets = buildRowOffsets(rows)
    const lastIndex = rows.length - 1

    expect(findRowAtOffset(offsets, -100)).toBe(0)
    expect(findRowAtOffset(offsets, 0)).toBe(0)
    // 第二行（第一行是标题）行内
    expect(findRowAtOffset(offsets, HEADER_ROW_H + 1)).toBe(1)
    expect(findRowAtOffset(offsets, offsets[2])).toBe(2)
    // 超出总高收敛到最后一行
    expect(findRowAtOffset(offsets, offsets[rows.length] + 9999)).toBe(lastIndex)
  })

  test('二分查找与线性扫描结果一致（随机抽查）', () => {
    const files = Array.from({ length: 300 }, (_, i) => f(`${i}.md`, 'untracked'))
    const rows = buildListRows(files, NO_COLLAPSE, TITLES)
    const offsets = buildRowOffsets(rows)

    for (const y of [0, 1, 28, 29, 30, 41, 42, 43, 500, 5000, 8711]) {
      let expected = 0
      for (let i = 0; i < rows.length; i++) if (offsets[i] <= y) expected = i
      expect(findRowAtOffset(offsets, y)).toBe(expected)
    }
  })
})
