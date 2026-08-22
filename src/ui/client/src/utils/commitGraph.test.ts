import { describe, it, expect } from 'vitest'
import { computeCommitGraph, parseBranchDecorations, computeBranchSets, GRAPH_ROW_HEIGHT, GRAPH_PAD_X, GRAPH_LANE_WIDTH, laneX } from './commitGraph'

/**
 * 用例构造约定: 提交按展示顺序(新→旧)给出, parents 指向列表中更靠后的 hash。
 * 场景覆盖: 线性历史 / 分叉+合并 / 分支头(无父) / 多分支头 / 列宽计算。
 */

describe('computeCommitGraph - 线性历史', () => {
  it('全部落在第 0 列, 直线相连, 无曲线', () => {
    const { rows, maxLanes } = computeCommitGraph([
      { hash: 'c3', parents: ['c2'] },
      { hash: 'c2', parents: ['c1'] },
      { hash: 'c1', parents: [] },
    ])
    expect(maxLanes).toBe(1)
    expect(rows).toHaveLength(3)

    // 第一个提交是分支头
    expect(rows[0].isHead).toBe(true)
    expect(rows[0].hasTopLine).toBe(false)
    expect(rows[0].commitLane).toBe(0)
    expect(rows[0].bottomEdges).toMatchObject([{ toLane: 0, color: rows[0].color, kind: 'straight' }])

    // 中间提交上下贯通
    expect(rows[1].isHead).toBe(false)
    expect(rows[1].hasTopLine).toBe(true)
    expect(rows[1].commitLane).toBe(0)

    // 根提交无出边
    expect(rows[2].bottomEdges).toEqual([])
    expect(rows[2].isMerge).toBe(false)
  })
})

describe('computeCommitGraph - 分叉与合并', () => {
  // m (merge, parents: b,f) ← b ← a(主干)
  //                     ↑ f(feature, parent: a)
  // 展示顺序: m, f, b, a  (topo 序: 子在前)
  it('merge 提交产生分叉曲线, 并且颜色可区分', () => {
    const { rows, maxLanes } = computeCommitGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])

    const [m, f, b, a] = rows
    expect(m.isMerge).toBe(true)
    expect(m.commitLane).toBe(0)
    // 第一父直线延续到 0 列, 第二父开辟新列
    expect(m.bottomEdges[0]).toMatchObject({ toLane: 0, kind: 'straight' })
    expect(m.bottomEdges[1].kind).toBe('curve')
    const featureLane = m.bottomEdges[1].toLane
    expect(featureLane).not.toBe(0)

    // feature 提交落在新列上
    expect(f.commitLane).toBe(featureLane)
    expect(f.color).toBe(m.bottomEdges[1].color)
    expect(f.color).not.toBe(b.color)

    // f 和 b 都以 a 为父: 后到者(这里是 b 处理时 a 已被 f 的列等待, 或反之)产生并入曲线
    // b 行应有一条贯穿线(feature 列在等待 a)
    expect(b.passes.some(p => p.lane === f.commitLane)).toBe(true)

    // a 被两列等待: 其中一列收拢进节点(topCurves 非空)
    expect(a.topCurves.length + (a.hasTopLine ? 1 : 0)).toBeGreaterThanOrEqual(1)
    expect(maxLanes).toBe(2)
  })

  it('合并后分支列被回收复用, 图不会无限变宽', () => {
    // 两轮 feature 分支: 每轮 merge 后列数应回落
    const { maxLanes } = computeCommitGraph([
      { hash: 'm2', parents: ['b2', 'f2'] },
      { hash: 'f2', parents: ['m1'] },
      { hash: 'b2', parents: ['m1'] },
      { hash: 'm1', parents: ['b1', 'f1'] },
      { hash: 'f1', parents: ['a'] },
      { hash: 'b1', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    expect(maxLanes).toBeLessThanOrEqual(2)
  })
})

describe('computeCommitGraph - 多分支头', () => {
  it('两个不相干的分支头各占一列, 头部无顶线', () => {
    const { rows, maxLanes } = computeCommitGraph([
      { hash: 'x2', parents: ['x1'] },
      { hash: 'y1', parents: [] }, // 孤儿分支头
      { hash: 'x1', parents: [] },
    ])
    expect(rows[0].isHead).toBe(true)
    expect(rows[1].isHead).toBe(true)
    expect(rows[1].commitLane).not.toBe(rows[0].commitLane)
    expect(rows[1].color).not.toBe(rows[0].color)
    // y1 是无父分支头: 无出边
    expect(rows[1].bottomEdges).toEqual([])
    expect(maxLanes).toBe(2)
  })
})

describe('computeCommitGraph - 渲染常量与列宽', () => {
  it('laneX 按 PAD + lane*LANE_W 递增, 宽度覆盖所有列', () => {
    expect(laneX(0)).toBe(GRAPH_PAD_X)
    expect(laneX(1)).toBe(GRAPH_PAD_X + GRAPH_LANE_WIDTH)
    const { width, maxLanes } = computeCommitGraph([
      { hash: 'm', parents: ['a', 'b', 'c'] }, // octopus merge, 3 列
      { hash: 'c', parents: ['r'] },
      { hash: 'b', parents: ['r'] },
      { hash: 'a', parents: ['r'] },
      { hash: 'r', parents: [] },
    ])
    expect(maxLanes).toBe(3)
    expect(width).toBe(GRAPH_PAD_X * 2 + (maxLanes - 1) * GRAPH_LANE_WIDTH)
    expect(GRAPH_ROW_HEIGHT).toBeGreaterThan(0)
  })

  it('空列表返回空结果', () => {
    const { rows, maxLanes, width } = computeCommitGraph([])
    expect(rows).toEqual([])
    expect(maxLanes).toBe(0)
    expect(width).toBe(0)
  })
})

describe('parseBranchDecorations - 装饰串解析', () => {
  it('提取分支名, 跳过 tag 和裸 HEAD', () => {
    expect(parseBranchDecorations('HEAD -> main, tag: v2.15.30, origin/main'))
      .toEqual(['main', 'origin/main'])
    expect(parseBranchDecorations('tag: v1.0')).toEqual([])
    expect(parseBranchDecorations('HEAD')).toEqual([])
    expect(parseBranchDecorations('')).toEqual([])
    expect(parseBranchDecorations(undefined)).toEqual([])
    expect(parseBranchDecorations('feature-x')).toEqual(['feature-x'])
  })
})

describe('computeBranchSets - 分支包含传播', () => {
  // m (merge: b,f) ← b ← a;  f 是 feature 头
  it('子提交的分支沿拓扑序传播给父提交', () => {
    const sets = computeBranchSets([
      { hash: 'm', parents: ['b', 'f'], branch: 'HEAD -> main, origin/main' },
      { hash: 'f', parents: ['a'], branch: 'feature' },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    expect(sets.get('m')!.sort()).toEqual(['main', 'origin/main'])
    // f 已被 merge 进 main, 所以 main/origin/main 也包含它(与 git branch --contains 语义一致)
    expect(sets.get('f')!.sort()).toEqual(['feature', 'main', 'origin/main'])
    // b 被 main 包含(子 m 传播), 不含 feature
    expect(sets.get('b')!.sort()).toEqual(['main', 'origin/main'])
    // a 是共同祖先: main + feature 都包含它
    expect(sets.get('a')!.sort()).toEqual(['feature', 'main', 'origin/main'])
  })

  it('布局行和线都带上了分支标注', () => {
    const { rows } = computeCommitGraph([
      { hash: 'm', parents: ['b', 'f'], branch: 'HEAD -> main' },
      { hash: 'f', parents: ['a'], branch: 'feature' },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ])
    const [m, f, b, a] = rows
    expect(m.branches).toEqual(['main'])
    // f 被 feature 和 main 共同包含
    expect(f.branches.sort()).toEqual(['feature', 'main'])
    // m 到 f 的分叉边标注包含 feature
    expect(m.bottomEdges[1].branches).toContain('feature')
    // b 行的贯穿线(feature 列)标注包含 feature
    expect(b.passes[0].branches).toContain('feature')
    // b 的第一父 a 已被 feature 列等待 → b 并入该列, 边指向 a(被 feature+main 包含)
    const collapse = b.bottomEdges.find(e => e.kind === 'curve')
    expect(collapse).toBeTruthy()
    expect(collapse!.branches).toContain('feature')
    expect(collapse!.branches).toContain('main')
    // a 本身被两个分支包含
    expect(a.branches.sort()).toEqual(['feature', 'main'])
  })
})
