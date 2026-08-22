/*
 ~ Copyright 2026 xz333221
 ~
 ~ Licensed under the Apache License, Version 2.0 (the "License");
 ~ you may not use this file except in compliance with the License.
 ~ You may obtain a copy of the License at
 ~
 ~     http://www.apache.org/licenses/LICENSE-2.0
 ~
 ~ Unless required by applicable law or agreed to in writing, software
 ~ distributed under the License is distributed on an "AS IS" BASIS,
 ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 ~ See the License for the specific language governing permissions and
 ~ limitations under the License.
 */

/**
 * Commit DAG 轨道布局算法（类 vscode-git-graph 的列分配策略）。
 *
 * 输入: 按展示顺序(新→旧)的提交列表, 每项含 hash + parents(父提交 hash 数组)。
 * 输出: 每一行的轨道布局(节点所在列、贯穿线、合并/分叉曲线), 供 SVG 按行渲染。
 *
 * 核心思路:
 * - 维护 lanes 数组, lanes[i] = { hash, colorIdx } 表示"第 i 列正在等待 hash 出现"。
 * - 自上而下逐行处理:
 *   1. 若当前 commit 被某列等待 → 节点落在该列(继承颜色); 否则是分支头, 分配新列+新颜色。
 *   2. 处理完后该列的"等待"被消费, 换成等待第一个父提交(保持原列原颜色, 即直线延续);
 *      若第一个父提交已被其他列等待 → 本列并入该列(画合并曲线)。
 *   3. 其余父提交(merge 的第二/三父): 若已有列在等待 → 画曲线并入; 否则分配新列(新颜色, 分叉曲线)。
 */

// 渲染常量(组件与列宽计算共用)
export const GRAPH_ROW_HEIGHT = 30;
export const GRAPH_LANE_WIDTH = 14;
export const GRAPH_PAD_X = 10;

// 分支调色板(亮/暗主题都可读)
export const GRAPH_COLORS = [
  "#f14e32", // git 红
  "#1e88e5", // 蓝
  "#43a047", // 绿
  "#fb8c00", // 橙
  "#8e24aa", // 紫
  "#00acc1", // 青
  "#d81b60", // 品红
  "#7cb342", // 黄绿
  "#5e35b1", // 深紫
  "#00897b", // 蓝绿
];

export interface GraphCommitInput {
  hash: string;
  parents?: string[];
  /** %D 装饰串, 如 "HEAD -> main, tag: v1.0, origin/main" */
  branch?: string;
}

export interface GraphPassLine {
  lane: number;
  color: string;
  /** 该轨道(线)此刻通向的提交所属的分支名列表 */
  branches: string[];
}

export interface GraphTopCurve {
  fromLane: number;
  color: string;
  branches: string[];
}

export interface GraphBottomEdge {
  toLane: number;
  color: string;
  /** straight = 同列直线; curve = 跨列贝塞尔曲线(合并/分叉) */
  kind: "straight" | "curve";
  /** 边的目标提交(父)所属的分支名列表 */
  branches: string[];
}

export interface GraphRowLayout {
  hash: string;
  /** 节点所在列 */
  commitLane: number;
  /** 节点颜色 */
  color: string;
  /** 是否 merge 提交(>=2 个父) */
  isMerge: boolean;
  /** 是否分支头(没有被任何列等待, 顶部没有连线) */
  isHead: boolean;
  /** 是否有从顶部垂直进入节点的线 */
  hasTopLine: boolean;
  /** 贯穿整行的垂直线(其他列) */
  passes: GraphPassLine[];
  /** 从顶部其他列弯曲进入节点的线(同一 commit 被多列等待时收拢) */
  topCurves: GraphTopCurve[];
  /** 从节点出发向下的边 */
  bottomEdges: GraphBottomEdge[];
  /** 包含该提交的分支名列表(由分支头装饰 + 子提交沿拓扑序向上传播算出) */
  branches: string[];
}

export interface CommitGraphResult {
  rows: GraphRowLayout[];
  /** 最大并发列数 */
  maxLanes: number;
  /** 图列总宽度(px) */
  width: number;
}

interface LaneState {
  hash: string;
  colorIdx: number;
}

export function laneX(lane: number): number {
  return GRAPH_PAD_X + lane * GRAPH_LANE_WIDTH;
}

export function graphColor(colorIdx: number): string {
  return GRAPH_COLORS[colorIdx % GRAPH_COLORS.length];
}

/**
 * 解析 %D 装饰串里的分支名(跳过 tag 和裸 HEAD)。
 * "HEAD -> main, tag: v1.0, origin/main" → ["main", "origin/main"]
 */
export function parseBranchDecorations(decoration?: string): string[] {
  if (!decoration) return [];
  const names: string[] = [];
  for (const part of decoration.split(",")) {
    const p = part.trim();
    if (!p || p === "HEAD") continue;
    if (p.startsWith("tag:")) continue;
    const arrow = p.match(/^HEAD\s*->\s*(.+)$/);
    names.push((arrow ? arrow[1] : p).trim());
  }
  return names;
}

/**
 * 计算每个提交被哪些分支包含。
 * 输入按展示顺序(新→旧, topo 序: 子提交先于父提交), 一趟扫描:
 * 每个提交的集合 = 它作为分支头的分支 ∪ 所有子提交传播上来的集合,
 * 然后把自己的集合并到每个父提交的累加器里。
 * 注意: 筛选/分页截断时只能算出不完整(偏小)的集合。
 */
export function computeBranchSets(commits: GraphCommitInput[]): Map<string, string[]> {
  const acc = new Map<string, Set<string>>();
  const result = new Map<string, string[]>();
  for (const c of commits) {
    const set = acc.get(c.hash) ?? new Set<string>();
    for (const b of parseBranchDecorations(c.branch)) set.add(b);
    result.set(c.hash, Array.from(set));
    for (const p of c.parents ?? []) {
      const parentSet = acc.get(p) ?? new Set<string>();
      for (const b of set) parentSet.add(b);
      acc.set(p, parentSet);
    }
  }
  return result;
}

export function computeCommitGraph(commits: GraphCommitInput[]): CommitGraphResult {
  const lanes: (LaneState | null)[] = [];
  const rows: GraphRowLayout[] = [];
  let colorCounter = 0;
  let maxLanes = 0;

  // 当前列表中存在的 hash 集合。
  // 筛选/分页导致父提交不在列表里时, 不为它分配轨道——否则筛选视图下
  // 每个"看不见的父"都会留下一条悬空轨道, 图会无限变宽。
  const hashSet = new Set(commits.map((c) => c.hash));

  const findLane = (hash: string): number =>
    lanes.findIndex((l) => l !== null && l.hash === hash);

  const allocLane = (): number => {
    const free = lanes.findIndex((l) => l === null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const before: (LaneState | null)[] = lanes.slice();

    let lane = findLane(commit.hash);
    let colorIdx: number;
    let isHead = false;

    if (lane !== -1) {
      colorIdx = lanes[lane]!.colorIdx;
    } else {
      // 分支头: 没有被任何列等待
      isHead = true;
      lane = allocLane();
      colorIdx = colorCounter++;
    }

    // 消费当前列的等待
    lanes[lane] = null;

    // 同一 commit 被多列等待时(如 fast-forward 后两个 ref 指向同一点), 其余列收拢进节点
    const topCurves: GraphTopCurve[] = [];
    const collapsedLanes = new Set<number>();
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (l !== null && l.hash === commit.hash) {
        topCurves.push({ fromLane: i, color: graphColor(l.colorIdx), branches: [], _hash: commit.hash } as GraphTopCurve);
        lanes[i] = null;
        collapsedLanes.add(i);
      }
    }

    const bottomEdges: GraphBottomEdge[] = [];
    const nodeColor = graphColor(colorIdx);

    if (parents.length > 0) {
      const firstParent = parents[0];
      const existing = findLane(firstParent);
      if (existing !== -1) {
        // 第一个父已被其他列等待 → 本列并入该列(合并曲线)
        bottomEdges.push({ toLane: existing, color: nodeColor, kind: existing === lane ? "straight" : "curve", branches: [], _hash: firstParent } as GraphBottomEdge);
        if (existing === lane) {
          lanes[lane] = { hash: firstParent, colorIdx };
        }
      } else if (hashSet.has(firstParent)) {
        // 直线延续: 本列继续等待第一个父
        lanes[lane] = { hash: firstParent, colorIdx };
        bottomEdges.push({ toLane: lane, color: nodeColor, kind: "straight", branches: [], _hash: firstParent } as GraphBottomEdge);
      }
      // else: 父提交不在当前列表(筛选/分页截断) → 本列到此为止, 不留悬空轨道

      // merge 的其余父提交
      for (const p of parents.slice(1)) {
        const ex = findLane(p);
        if (ex !== -1) {
          bottomEdges.push({ toLane: ex, color: nodeColor, kind: ex === lane ? "straight" : "curve", branches: [], _hash: p } as GraphBottomEdge);
        } else if (hashSet.has(p)) {
          const nl = allocLane();
          const newColorIdx = colorCounter++;
          lanes[nl] = { hash: p, colorIdx: newColorIdx };
          bottomEdges.push({ toLane: nl, color: graphColor(newColorIdx), kind: nl === lane ? "straight" : "curve", branches: [], _hash: p } as GraphBottomEdge);
        }
        // else: 父提交不在列表 → 不画边
      }
    }

    const after: (LaneState | null)[] = lanes.slice();
    maxLanes = Math.max(maxLanes, lanes.length);

    // 贯穿线: 处理前后都存活、且与本行节点/收拢无关的列
    const passes: GraphPassLine[] = [];
    for (let i = 0; i < before.length; i++) {
      const b = before[i];
      if (b === null) continue;
      if (i === lane || collapsedLanes.has(i)) continue;
      if (i < after.length && after[i] !== null && after[i]!.hash === b.hash) {
        passes.push({ lane: i, color: graphColor(b.colorIdx), branches: [], _hash: b.hash } as GraphPassLine);
      }
    }

    rows.push({
      hash: commit.hash,
      commitLane: lane,
      color: nodeColor,
      isMerge: parents.length > 1,
      isHead,
      hasTopLine: !isHead,
      passes,
      topCurves,
      bottomEdges,
      branches: [],
    });
  }

  // ── 分支归属标注(第二趟): 提交/线/边挂上分支名, 供悬停提示 ──
  const branchSets = computeBranchSets(commits);
  const branchesOf = (hash: string): string[] => branchSets.get(hash) ?? [];
  for (const row of rows) {
    row.branches = branchesOf(row.hash);
    for (const p of row.passes) {
      p.branches = branchesOf((p as any)._hash);
      delete (p as any)._hash;
    }
    for (const t of row.topCurves) {
      t.branches = branchesOf((t as any)._hash);
      delete (t as any)._hash;
    }
    for (const e of row.bottomEdges) {
      e.branches = branchesOf((e as any)._hash);
      delete (e as any)._hash;
    }
  }

  const width = maxLanes > 0 ? GRAPH_PAD_X * 2 + (maxLanes - 1) * GRAPH_LANE_WIDTH : 0;
  return { rows, maxLanes, width };
}
