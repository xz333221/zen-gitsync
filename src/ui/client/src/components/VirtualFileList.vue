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
<!--
  列表视图的虚拟滚动（替代原来的 5 个 FileGroup 全量 v-for）。
  只渲染视口 ± overscan 内的行；行高固定（见 utils/fileListRows.ts），
  用"绝对定位 + 前缀和偏移表"算位置，所以 5000 行与 50 行的渲染量一样。

  滚动容器是**外层**（GitStatus 的 .file-list-container，overflow-y:auto）——
  与改造前保持一致，本组件只负责撑出总高度并渲染窗口内的行。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import FileRow from './FileRow.vue'
import {
  buildRowOffsets,
  findRowAtOffset,
  type FileGroupKey,
  type ListFileItem,
  type ListRow,
} from '@/utils/fileListRows'

interface Props {
  rows: ListRow[]
  isFileLocked: (filePath: string) => boolean
  isLocking: (filePath: string) => boolean
  getFileName: (filePath: string) => string
  getFileDirectory: (filePath: string) => string
  isSelectionMode?: boolean
  isFileSelected?: (filePath: string) => boolean
  /** 视口外上下各多渲染的像素数：越小越省，越大滚动时越不容易露白 */
  overscan?: number
}

const props = withDefaults(defineProps<Props>(), {
  isSelectionMode: false,
  overscan: 400,
})

const emit = defineEmits<{
  toggleCollapse: [groupKey: FileGroupKey]
  fileClick: [file: ListFileItem]
  toggleFileLock: [filePath: string]
  stageFile: [filePath: string]
  unstageFile: [filePath: string]
  revertFileChanges: [filePath: string]
  manageLockedFiles: []
  toggleFileSelection: [filePath: string]
}>()

const root = ref<HTMLElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(0)

// 前缀和：offsets[i] = 第 i 行的 top，offsets[rows.length] = 总高
const offsets = computed(() => buildRowOffsets(props.rows))
const totalHeight = computed(() => offsets.value[offsets.value.length - 1] || 0)

// 只算视口内的行：5000 行通常命中 30~50 行
const visibleRows = computed(() => {
  const list = props.rows
  if (!list.length) return [] as { row: ListRow; index: number; top: number }[]

  const offs = offsets.value
  const start = findRowAtOffset(offs, Math.max(0, scrollTop.value - props.overscan))
  const end = Math.min(list.length - 1, findRowAtOffset(offs, scrollTop.value + viewportHeight.value + props.overscan))

  const out: { row: ListRow; index: number; top: number }[] = []
  for (let i = start; i <= end; i++) out.push({ row: list[i], index: i, top: offs[i] })
  return out
})

/** 往上找最近的滚动祖先（GitStatus 里就是 .file-list-container） */
function resolveScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

function syncMetrics() {
  const el = scroller.value
  if (!el) return
  viewportHeight.value = el.clientHeight
  scrollTop.value = el.scrollTop
}

function handleScroll() {
  const el = scroller.value
  if (el) scrollTop.value = el.scrollTop
}

let ro: ResizeObserver | null = null
let rafId = 0

function scheduleSync() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    syncMetrics()
  })
}

onMounted(() => {
  // 滚动事件挂在外层滚动容器上（本组件自身不滚动）
  scroller.value = resolveScrollParent(root.value)
  scroller.value?.addEventListener('scroll', handleScroll, { passive: true })
  // 同步量一次视口高度：此刻还没绘制，能把首帧就填满视口的行渲染出来，
  // 否则要等下一帧才补齐（首帧只渲染 overscan 那几行，下方会闪一下空白）。
  syncMetrics()
  // 滚动祖先高度变化（窗口缩放/面板拖宽）后需要重算视口高度
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    ro = new ResizeObserver(scheduleSync)
    ro.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  scroller.value?.removeEventListener('scroll', handleScroll)
  ro?.disconnect()
  ro = null
  if (rafId) cancelAnimationFrame(rafId)
})

// 行集合变化（状态刷新 / 折叠切换）后总高会变，浏览器把 scrollTop 夹回有效范围时
// 不一定触发 scroll 事件，这里主动同步一次，避免窗口停在旧位置。
watch(
  () => props.rows,
  () => {
    nextTick(syncMetrics)
  },
)
</script>

<template>
  <div ref="root" class="vfl">
    <div class="vfl__spacer" :style="{ height: `${totalHeight}px` }">
      <div
        v-for="item in visibleRows"
        :key="item.row.key"
        class="vfl__row"
        :class="item.row.kind === 'header' ? 'vfl__row--header' : 'vfl__row--file'"
        :style="{ transform: `translateY(${item.top}px)` }"
      >
        <!-- 分组标题行 -->
        <div
          v-if="item.row.kind === 'header'"
          class="vfl__header"
          role="button"
          :aria-expanded="!item.row.collapsed"
          @click="emit('toggleCollapse', item.row.groupKey)"
        >
          <el-icon class="collapse-icon" :class="{ collapsed: item.row.collapsed }">
            <ArrowDown />
          </el-icon>
          <span class="vfl__header-title">{{ item.row.title }}</span>
          <span class="file-count">({{ item.row.count }})</span>
        </div>

        <!-- 文件行 -->
        <FileRow
          v-else
          :file="item.row.file"
          :is-file-locked="isFileLocked"
          :is-locking="isLocking"
          :get-file-name="getFileName"
          :get-file-directory="getFileDirectory"
          :is-selection-mode="isSelectionMode"
          :is-file-selected="isFileSelected"
          @file-click="(f: ListFileItem) => emit('fileClick', f)"
          @toggle-file-lock="(p: string) => emit('toggleFileLock', p)"
          @stage-file="(p: string) => emit('stageFile', p)"
          @unstage-file="(p: string) => emit('unstageFile', p)"
          @revert-file-changes="(p: string) => emit('revertFileChanges', p)"
          @manage-locked-files="emit('manageLockedFiles')"
          @toggle-file-selection="(p: string) => emit('toggleFileSelection', p)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行高/偏移全部由固定行高推导，常量见 utils/fileListRows.ts，改一边必须改另一边 */
.vfl {
  width: 100%;
  /* 水平留白（原 FileGroup .file-list 的 padding），纵向不参与行高计算 */
  padding: 0 var(--spacing-sm);
  box-sizing: border-box;
}

.vfl__spacer {
  position: relative;
  width: 100%;
}

.vfl__row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}

/* 29px = 28px 行高（FileRow .file-item）+ 1px 行间距 */
.vfl__row--file {
  height: 29px;
  box-sizing: border-box;
  padding-bottom: 1px;
}

/* 42px = 6px 组间距 + 36px 标题条 */
.vfl__row--header {
  height: 42px;
  box-sizing: border-box;
  padding-top: 6px;
}

.vfl__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  height: 36px;
  box-sizing: border-box;
  padding: 0 var(--spacing-lg);
  cursor: pointer;
  font-weight: var(--font-weight-semibold);
  background: var(--bg-container);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-base);
  transition: var(--transition-all);
}

.vfl__header:hover {
  box-shadow: var(--shadow-hover);
}

.vfl__header-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vfl__header .file-count {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  font-weight: var(--font-weight-medium);
  background: var(--bg-panel);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  margin-left: auto;
}

.collapse-icon {
  transition: var(--transition-transform);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}
</style>
