<!--
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
  -->
<script setup lang="ts">
import { computed } from "vue";
import { $t } from "@/lang/static";
import {
  GRAPH_ROW_HEIGHT,
  laneX,
  type GraphRowLayout,
} from "@utils/commitGraph";

const props = defineProps<{
  layout: GraphRowLayout;
  width: number;
}>();

// 视图坐标系高度(仅用于线条层 viewBox, 实际渲染高度 = 单元格 100%)
const VH = GRAPH_ROW_HEIGHT;
const cy = VH / 2;
// 线条向上下各多画 1px(配合 overflow:visible), 消除行边框造成的 1px 断缝
const TOP = -1;
const BOTTOM = VH + 1;

const nodeX = computed(() => laneX(props.layout.commitLane));

// ── 悬停提示文案 ─────────────────────────────────────────
const noBranchText = $t("@A1833:暂不属于任何分支");

function branchText(branches: string[]): string {
  return branches.length > 0 ? branches.join(", ") : noBranchText;
}

/** 节点提示: 短哈希 + 所属分支 */
const nodeTitle = computed(
  () => `${props.layout.hash.slice(0, 7)} · ${branchText(props.layout.branches)}`
);

/** 垂直贯穿线: x 固定, TOP → BOTTOM */
const passLines = computed(() =>
  props.layout.passes.map((p) => ({
    x: laneX(p.lane),
    color: p.color,
    title: branchText(p.branches),
  }))
);

/** 顶部收拢曲线: (x1,TOP) → 节点 */
const topCurvePaths = computed(() =>
  props.layout.topCurves.map((c) => {
    const x1 = laneX(c.fromLane);
    const x2 = nodeX.value;
    return {
      d: `M ${x1} ${TOP} C ${x1} ${cy / 2}, ${x2} ${cy / 2}, ${x2} ${cy}`,
      color: c.color,
      title: branchText(c.branches),
    };
  })
);

/** 底部出边: 节点 → (x2,BOTTOM), 同列直线 / 跨列贝塞尔 */
const bottomEdgePaths = computed(() =>
  props.layout.bottomEdges.map((e) => {
    const x1 = nodeX.value;
    const x2 = laneX(e.toLane);
    const d =
      e.kind === "straight" || x1 === x2
        ? `M ${x1} ${cy} L ${x2} ${BOTTOM}`
        : `M ${x1} ${cy} C ${x1} ${cy + (BOTTOM - cy) / 2}, ${x2} ${BOTTOM - (BOTTOM - cy) / 2}, ${x2} ${BOTTOM}`;
    return { d, color: e.color, title: branchText(e.branches) };
  })
);
</script>

<template>
  <div class="graph-wrap">
    <!-- 线条层: viewBox + preserveAspectRatio="none" 纵向拉伸填满单元格, 任意行高不断线 -->
    <svg
      class="graph-layer graph-lines"
      :viewBox="`0 0 ${width} ${VH}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <!-- 贯穿线(悬停显示分支名, 加粗透明描边扩大热区) -->
      <line
        v-for="(l, i) in passLines"
        :key="'p' + i"
        :x1="l.x"
        :y1="TOP"
        :x2="l.x"
        :y2="BOTTOM"
        :stroke="l.color"
        stroke-width="2"
      >
        <title>{{ l.title }}</title>
      </line>
      <line
        v-for="(l, i) in passLines"
        :key="'ph' + i"
        :x1="l.x"
        :y1="TOP"
        :x2="l.x"
        :y2="BOTTOM"
        stroke="transparent"
        stroke-width="8"
      >
        <title>{{ l.title }}</title>
      </line>
      <!-- 顶部收拢曲线 -->
      <path
        v-for="(p, i) in topCurvePaths"
        :key="'t' + i"
        :d="p.d"
        :stroke="p.color"
        stroke-width="2"
        fill="none"
      >
        <title>{{ p.title }}</title>
      </path>
      <path
        v-for="(p, i) in topCurvePaths"
        :key="'th' + i"
        :d="p.d"
        stroke="transparent"
        stroke-width="8"
        fill="none"
      >
        <title>{{ p.title }}</title>
      </path>
      <!-- 顶部垂线入节点 -->
      <line
        v-if="layout.hasTopLine"
        :x1="nodeX"
        :y1="TOP"
        :x2="nodeX"
        :y2="cy"
        :stroke="layout.color"
        stroke-width="2"
      >
        <title>{{ branchText(layout.branches) }}</title>
      </line>
      <!-- 底部出边 -->
      <path
        v-for="(p, i) in bottomEdgePaths"
        :key="'b' + i"
        :d="p.d"
        :stroke="p.color"
        stroke-width="2"
        fill="none"
      >
        <title>{{ p.title }}</title>
      </path>
      <path
        v-for="(p, i) in bottomEdgePaths"
        :key="'bh' + i"
        :d="p.d"
        stroke="transparent"
        stroke-width="8"
        fill="none"
      >
        <title>{{ p.title }}</title>
      </path>
    </svg>
    <!-- 节点层: 不用 viewBox, cy=50% + 固定半径, 任意行高都是正圆 -->
    <svg class="graph-layer graph-nodes" aria-hidden="true">
      <g>
        <title>{{ nodeTitle }}</title>
        <!-- merge 提交空心圆环, 普通提交实心 -->
        <circle
          v-if="layout.isMerge"
          :cx="nodeX"
          cy="50%"
          r="4.5"
          fill="var(--bg-panel, #fff)"
          :stroke="layout.color"
          stroke-width="2"
        />
        <circle v-else :cx="nodeX" cy="50%" r="4" :fill="layout.color" />
        <!-- 分支头加一圈描边, 更醒目 -->
        <circle
          v-if="layout.isHead"
          :cx="nodeX"
          cy="50%"
          r="7"
          fill="none"
          :stroke="layout.color"
          stroke-width="1.5"
          opacity="0.55"
        />
        <!-- 扩大节点悬停热区 -->
        <circle :cx="nodeX" cy="50%" r="9" fill="transparent" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
/* 绝对定位铺满整个 td(td 上 position:relative), 高度 = 实际行高, 与内容无关 */
.graph-wrap {
  position: absolute;
  inset: 0;
}

.graph-layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

/* 线条画出 viewBox 边界一点点, 跨行连续 */
.graph-lines {
  overflow: visible;
}
</style>
