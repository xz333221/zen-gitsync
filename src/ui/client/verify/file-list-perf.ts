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
 * 文件列表渲染性能探针（dev-only）。
 *
 * 背景：Obsidian 资料库那类仓库会出现「未跟踪文件 5000+」。改造前列表视图是 5 个
 * FileGroup 全量 v-for，树状视图是 FileTreeView → TreeNodeItem 递归全量渲染，
 * 实测 5073 条：列表首帧 11.5s / DOM 13.1 万 / 刷新重渲染 2.8s；树状首帧 9.5s /
 * 11.6 万节点（2026-09-28）。表现就是"打开或刷新时卡一下"。
 *
 * 两个视图现在都是固定行高虚拟滚动（VirtualFileList / VirtualFileTree +
 * utils/fileListRows.ts / utils/fileTreeRows.ts）。这个探针把**真实组件**挂到
 * 真实浏览器里，量：① 挂载/首帧 ② 数据刷新后的重渲染 ③ DOM 节点数、真正渲染的行数
 * ④ 滚到底/滚到中间是否命中目标行 ⑤ 交互（点文件行、点目录展开折叠、点标题行折叠分组）。
 *
 * 用法（前端 dev server 起来后）：
 *   node verify/file-list-perf.mjs          # list + tree 各一次
 *   VITE_PORT=5544 N=8000 node verify/file-list-perf.mjs
 * 页面参数：?mode=list|tree&n=5073
 */
import { computed, createApp, defineComponent, h, nextTick, ref } from 'vue'
import i18n from '@/locales'
import '@/main.css'
import '@/styles/common.scss'
import 'element-plus/dist/index.css'
import 'virtual:svg-icons-register'
import VirtualFileList from '@/components/VirtualFileList.vue'
import VirtualFileTree from '@/components/VirtualFileTree.vue'
import { buildListRows, type FileGroupKey } from '@/utils/fileListRows'
import { buildTreeRows } from '@/utils/fileTreeRows'
import { buildFileTree, toggleNodeExpanded, type TreeNode } from '@/utils/fileTree'

declare global {
  interface Window {
    __PERF__?: Record<string, unknown>
  }
}

const params = new URLSearchParams(location.search)
const MODE = params.get('mode') || 'list'
const N = Number(params.get('n') || 5073)

// 贴近真实素材：超长中文目录 + 大量 .md（截图里的 Obsidian 资料库形态）
const DIR = 'Resources 资源（兴趣参考素材，随时取用）/源一/架构课/AI平台篇/扣子&Dify'
const NAMES = [
  '课程介绍', '认识Agent平台', 'Coze基本介绍', '优化用户体验', '插件',
  '工作流', '条件选择器节点', '意图识别', '知识库', '多智能体协作',
]

function makeFiles(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    path: `${DIR}/${NAMES[i % NAMES.length]}${i}.md`,
    type: 'untracked',
  }))
}

const getFileName = (p: string) => p.split('/').pop() || p
const getFileDirectory = (p: string) => p.split('/').slice(0, -1).join('/')

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

function raf2(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

/** 行上会渲染出来的文字（文件行 = 文件名，节点行 = 节点名） */
function rowLabel(row: { kind: string; file?: { path: string }; node?: TreeNode }): string {
  if (row.kind === 'file' && row.file) return getFileName(row.file.path)
  if (row.kind === 'node' && row.node) return row.node.name
  return ''
}

async function main() {
  const host = document.getElementById('app')!
  const filesRef = ref(makeFiles(N))
  const treeRef = ref<TreeNode[]>(buildFileTree(filesRef.value))
  const collapsedRef = ref<Record<FileGroupKey, boolean>>({ ...NO_COLLAPSE })
  const events = { fileClick: [] as string[], toggleNode: [] as string[], toggleCollapse: [] as string[] }

  let buildTreeMs: number | null = null

  // 行数组放在组件外，方便探针自己算「预期最后一行 / 中间行」来做断言
  const listRows = computed(() => buildListRows(filesRef.value, collapsedRef.value, TITLES))
  const treeRows = computed(() =>
    buildTreeRows(
      [{ key: 'untracked', title: TITLES.untracked, count: filesRef.value.length, tree: treeRef.value }],
      collapsedRef.value,
    ),
  )
  const rowsRef = computed(() => (MODE === 'tree' ? treeRows.value : listRows.value))

  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(
            'div',
            { class: 'file-list-container', style: 'height:100vh;overflow-y:auto;box-sizing:border-box' },
            [
              MODE === 'tree'
                ? h(VirtualFileTree as any, {
                    rows: treeRows.value,
                    selectedFile: '',
                    showActionButtons: true,
                    isFileLocked: () => false,
                    isLocking: () => false,
                    onToggleCollapse: (key: FileGroupKey) => {
                      events.toggleCollapse.push(key)
                      collapsedRef.value = { ...collapsedRef.value, [key]: !collapsedRef.value[key] }
                    },
                    onToggleNode: (node: TreeNode) => {
                      events.toggleNode.push(node.path)
                      toggleNodeExpanded(node)
                    },
                    onFileSelect: (f: { path: string }) => events.fileClick.push(f.path),
                  })
                : h(VirtualFileList as any, {
                    rows: listRows.value,
                    isFileLocked: () => false,
                    isLocking: () => false,
                    getFileName,
                    getFileDirectory,
                    isSelectionMode: false,
                    isFileSelected: () => false,
                    onToggleCollapse: (key: FileGroupKey) => {
                      events.toggleCollapse.push(key)
                      collapsedRef.value = { ...collapsedRef.value, [key]: !collapsedRef.value[key] }
                    },
                    onFileClick: (f: { path: string }) => events.fileClick.push(f.path),
                  }),
            ],
          )
      },
    }),
  )
  app.use(i18n)

  // ── ① 挂载（同步 JS）+ 首帧（含样式计算/布局/绘制）──
  const t0 = performance.now()
  app.mount(host)
  const mountMs = performance.now() - t0
  await nextTick()
  await raf2()
  const firstPaintMs = performance.now() - t0

  const container = host.querySelector('.file-list-container') as HTMLElement
  const stats = {
    mode: MODE,
    n: N,
    buildTreeMs,
    mountMs: Math.round(mountMs),
    firstPaintMs: Math.round(firstPaintMs),
    domNodes: document.querySelectorAll('*').length,
    renderedItems: host.querySelectorAll('.file-item, .tree-node').length,
    totalRows: rowsRef.value.length,
    scrollHeight: container?.scrollHeight ?? 0,
    viewportHeight: container?.clientHeight ?? 0,
  }

  // ── ② 模拟一次状态刷新：整份 fileList 换引用（与 gitStore 刷新行为一致）──
  await raf2()
  const p0 = performance.now()
  filesRef.value = makeFiles(N)
  if (MODE === 'tree') {
    const bt = performance.now()
    treeRef.value = buildFileTree(filesRef.value)
    buildTreeMs = Math.round((performance.now() - bt) * 100) / 100
  }
  await nextTick()
  await raf2()
  const patchMs = performance.now() - p0

  const renderedLabels = () =>
    Array.from(host.querySelectorAll('.file-name, .node-name')).map((el) => (el.textContent || '').trim())

  // ── ③ 滚到底：最后一行必须渲染出来（偏移算得准）──
  const lastLabel = rowLabel(rowsRef.value[rowsRef.value.length - 1] as any)
  container.scrollTop = container.scrollHeight
  await nextTick()
  await raf2()
  const scrolledToBottom = renderedLabels().includes(lastLabel)

  // ── ④ 滚到中间：中间那行也在（不只看首尾）──
  const midLabel = rowLabel(rowsRef.value[Math.floor(rowsRef.value.length / 2)] as any)
  container.scrollTop = Math.floor(container.scrollHeight / 2)
  await nextTick()
  await raf2()
  const midRowOk = renderedLabels().includes(midLabel)
  const domNodesAfterScroll = document.querySelectorAll('*').length

  // ── ⑤ 交互回归 ──
  container.scrollTop = 0
  await nextTick()
  await raf2()

  let fileClickOk = false
  let collapseOk = false
  let collapsedSpacerHeight = ''
  let nodeToggleOk = false
  let nodeToggleDetail = ''

  if (MODE === 'list') {
    const row = host.querySelector('.file-item') as HTMLElement | null
    row?.click()
    await nextTick()
    fileClickOk = events.fileClick.length === 1

    const header = host.querySelector('.vfl__header') as HTMLElement | null
    header?.click()
    await nextTick()
    await raf2()
    collapsedSpacerHeight = (host.querySelector('.vfl__spacer') as HTMLElement | null)?.style.height || ''
    collapseOk =
      events.toggleCollapse[0] === 'untracked' &&
      collapsedSpacerHeight === '42px' &&
      host.querySelectorAll('.file-item').length === 0

    // 还原成「未折叠 + 滚到顶」，让 runner 截到正常列表
    header?.click()
    container.scrollTop = 0
    await nextTick()
    await raf2()
  } else {
    // ⚠️ 顺序有讲究：点文件行必须放在「点目录折叠」之前 —— 首个目录是整棵树的根，
    // 折叠它会让 5079 行塌到 2 行，之后 DOM 里再也找不到 .tree-node.is-file，
    // 点击空转会被误判成「点文件没回调」。
    const fileNode = host.querySelector('.tree-node.is-file') as HTMLElement | null
    fileNode?.click()
    await nextTick()
    fileClickOk = events.fileClick.length === 1 && !!fileNode

    // 点目录 → 展开/折叠：行数组必须跟着重算（行数变少、spacer 变矮）
    const dirRow = host.querySelector('.tree-node.is-directory') as HTMLElement | null
    const spacerBefore = parseFloat((host.querySelector('.vft__spacer') as HTMLElement | null)?.style.height || '0')
    const rowsBefore = rowsRef.value.length
    dirRow?.click()
    await nextTick()
    await raf2()
    const spacerAfter = parseFloat((host.querySelector('.vft__spacer') as HTMLElement | null)?.style.height || '0')
    nodeToggleOk = events.toggleNode.length === 1 && rowsRef.value.length < rowsBefore && spacerAfter < spacerBefore
    nodeToggleDetail = `${events.toggleNode[0] ?? '-'} 行 ${rowsBefore}→${rowsRef.value.length}，spacer ${spacerBefore}→${spacerAfter}`

    // 再点一次把它展开回来：顺带验证折叠后仍能恢复（折叠态下标题行以外只剩根目录行）
    // 重新 query 一次：虚拟列表 patch 后不保证沿用同一个 DOM 元素
    const dirRowAgain = host.querySelector('.tree-node.is-directory') as HTMLElement | null
    dirRowAgain?.click()
    await nextTick()
    await raf2()
    nodeToggleDetail += `；再展开 ${rowsRef.value.length} 行`

    const treeHeader = host.querySelector('.vft__header') as HTMLElement | null
    treeHeader?.click()
    await nextTick()
    await raf2()
    collapsedSpacerHeight = (host.querySelector('.vft__spacer') as HTMLElement | null)?.style.height || ''
    collapseOk =
      events.toggleCollapse[0] === 'untracked' &&
      collapsedSpacerHeight === '42px' &&
      host.querySelectorAll('.tree-node').length === 0

    // 还原：重建整棵树（全展开）+ 展开分组，方便截图
    treeRef.value = buildFileTree(filesRef.value)
    collapsedRef.value = { ...NO_COLLAPSE }
    container.scrollTop = 0
    await nextTick()
    await raf2()
  }

  window.__PERF__ = {
    ...stats,
    // stats 是在刷新前拍的快照，buildTreeMs 那时还是 null —— 这里用真实值覆盖
    buildTreeMs,
    patchMs: Math.round(patchMs),
    patchDomNodes: document.querySelectorAll('*').length,
    renderedItemsAfterPatch: host.querySelectorAll('.file-item, .tree-node').length,
    scrolledToBottom,
    lastRowProbe: lastLabel,
    midRowOk,
    midRowProbe: midLabel,
    domNodesAfterScroll,
    fileClickOk,
    collapseOk,
    collapsedSpacerHeight,
    nodeToggleOk,
    nodeToggleDetail,
    phase: 'patched',
    done: true,
  }
}

main().catch((err) => {
  window.__PERF__ = { error: String(err?.stack || err), done: true }
})
