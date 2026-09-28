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
 * 背景：Obsidian 资料库那类仓库会出现「未跟踪文件 5000+」。改造前列表视图 / 树状视图
 * 都是全量 v-for，实测 5073 条：列表首帧 ~11.5s、DOM 13.1 万节点、刷新一次重渲染 ~2.8s；
 * 树状首帧 ~10.5s、11.6 万节点。表现就是"打开或刷新时卡一下"（2026-09-28）。
 *
 * 列表视图已改为固定行高虚拟滚动（VirtualFileList + utils/fileListRows.ts），
 * 这个探针把**真实组件**用 N 条合成数据挂到真实浏览器里，量：
 *   ① 首次挂载 / 首帧（含样式计算与布局）
 *   ② 数据刷新后的重渲染（模拟 gitStore 换引用）
 *   ③ DOM 节点数、真正渲染出来的行数
 *   ④ 滚到底部后最后一行是否渲染出来（虚拟滚动的功能断言）
 *
 * 用法（前端 dev server 起来后）：
 *   node verify/file-list-perf.mjs              # list + tree，各跑一次
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
import FileTreeView from '@/components/FileTreeView.vue'
import { buildListRows, FILE_ROW_H, HEADER_ROW_H, type FileGroupKey, type ListRow } from '@/utils/fileListRows'
import { buildFileTree, type FileItem } from '@/utils/fileTree'

declare global {
  interface Window {
    __PERF__?: Record<string, unknown>
    __PROBE_EVENTS__?: { fileClick: string[]; toggleCollapse: string[] }
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

function makeFiles(n: number): FileItem[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `${DIR}/${NAMES[i % NAMES.length]}${i}.md`,
    type: 'untracked',
  }))
}

const getFileName = (p: string) => p.split('/').pop() || p
const getFileDirectory = (p: string) => p.split('/').slice(0, -1).join('/')

const COLLAPSED: Record<FileGroupKey, boolean> = {
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

async function main() {
  const host = document.getElementById('app')!
  const filesRef = ref<FileItem[]>(makeFiles(N))
  const treeRef = ref(buildFileTree(filesRef.value))
  // 折叠状态做成可变的，用于验证「点标题行 → 分组折叠 → 行数塌回标题行」
  const collapsedRef = ref<Record<FileGroupKey, boolean>>({ ...COLLAPSED })
  window.__PROBE_EVENTS__ = { fileClick: [], toggleCollapse: [] }

  let buildTreeMs: number | null = null
  if (MODE === 'tree') {
    const t = performance.now()
    buildFileTree(filesRef.value)
    buildTreeMs = performance.now() - t
  }

  const app = createApp(
    defineComponent({
      setup() {
        // 与 GitStatus 一样用 computed 缓存摊平结果：render 里现算会让滚动重渲染变 O(n)
        const listRows = computed<ListRow[]>(() => buildListRows(filesRef.value, collapsedRef.value, TITLES))
        return () =>
          h(
            'div',
            { class: 'file-list-container', style: 'height:100vh;overflow-y:auto;box-sizing:border-box' },
            [
              MODE === 'tree'
                ? h(FileTreeView as any, {
                    treeData: treeRef.value,
                    selectedFile: '',
                    showActionButtons: true,
                    isFileLocked: () => false,
                    isLocking: () => false,
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
                      window.__PROBE_EVENTS__!.toggleCollapse.push(key)
                      collapsedRef.value = { ...collapsedRef.value, [key]: !collapsedRef.value[key] }
                    },
                    onFileClick: (f: FileItem) => {
                      window.__PROBE_EVENTS__!.fileClick.push(f.path)
                    },
                  }),
            ],
          )
      },
    }),
  )
  app.use(i18n)

  // ── ① 首次挂载（同步 JS）+ 首帧（含样式计算/布局/绘制）──
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
    scrollHeight: container?.scrollHeight ?? 0,
    viewportHeight: container?.clientHeight ?? 0,
  }

  window.__PERF__ = { ...stats, patchMs: null, phase: 'mounted' }

  // ── ② 模拟一次状态刷新：整份 fileList 换引用（与 gitStore 刷新行为一致）──
  await raf2()
  const p0 = performance.now()
  filesRef.value = makeFiles(N)
  if (MODE === 'tree') treeRef.value = buildFileTree(filesRef.value)
  await nextTick()
  await raf2()
  const patchMs = performance.now() - p0

  // ── ③ 滚到底：虚拟滚动必须能把最后一行渲染出来 ──
  const lastIndex = N - 1
  const lastName = `${NAMES[lastIndex % NAMES.length]}${lastIndex}.md`
  let scrolledToBottom = false
  if (container && MODE === 'list') {
    container.scrollTop = container.scrollHeight
    await nextTick()
    await raf2()
    scrolledToBottom = Array.from(host.querySelectorAll('.file-name')).some((el) =>
      (el.textContent || '').includes(lastName),
    )
  }

  // ── ④ 滚到中间：验证偏移表在中间段也算得准（不只看首尾），且 DOM 不随滚动增长 ──
  let midRowOk = false
  let domNodesAfterScroll = 0
  const midIndex = Math.floor(N / 2)
  const midName = `${NAMES[midIndex % NAMES.length]}${midIndex}.md`
  if (container && MODE === 'list') {
    container.scrollTop = midIndex * FILE_ROW_H
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await nextTick()
    await raf2()
    midRowOk = Array.from(host.querySelectorAll('.file-name')).some((el) =>
      (el.textContent || '').includes(midName),
    )
    domNodesAfterScroll = document.querySelectorAll('*').length
  }

  // ── ⑤ 交互回归：点文件行回调带 path；点标题行折叠分组、行塌回只剩标题行 ──
  let fileClickOk = false
  let collapseOk = false
  let collapsedSpacerHeight = ''
  if (MODE === 'list') {
    container.scrollTop = 0
    await nextTick()
    await raf2()

    const row = host.querySelector('.file-item') as HTMLElement | null
    row?.click()
    await nextTick()
    fileClickOk = (window.__PROBE_EVENTS__?.fileClick.length ?? 0) === 1

    const header = host.querySelector('.vfl__header') as HTMLElement | null
    header?.click()
    await nextTick()
    await raf2()
    const spacer = host.querySelector('.vfl__spacer') as HTMLElement | null
    collapsedSpacerHeight = spacer?.style.height || ''
    collapseOk =
      window.__PROBE_EVENTS__?.toggleCollapse[0] === 'untracked' &&
      collapsedSpacerHeight === `${HEADER_ROW_H}px` &&
      host.querySelectorAll('.file-item').length === 0

    // 还原成"未折叠 + 滚到顶"，让 runner 截到的图是正常列表状态
    header?.click()
    container.scrollTop = 0
    await nextTick()
    await raf2()
  }

  window.__PERF__ = {
    ...stats,
    patchMs: Math.round(patchMs),
    patchDomNodes: document.querySelectorAll('*').length,
    renderedItemsAfterPatch: host.querySelectorAll('.file-item, .tree-node').length,
    scrolledToBottom,
    lastRowProbe: lastName,
    midRowOk,
    midRowProbe: midName,
    domNodesAfterScroll,
    fileClickOk,
    collapseOk,
    collapsedSpacerHeight,
    phase: 'patched',
    done: true,
  }
}

main().catch((err) => {
  window.__PERF__ = { error: String(err?.stack || err), done: true }
})
