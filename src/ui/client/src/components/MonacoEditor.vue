<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import 'monaco-editor/min/vs/editor/editor.main.css'

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const props = withDefaults(
  defineProps<{
    modelValue: string
    language?: string
    filePath?: string
    theme?: string
    readOnly?: boolean
    minHeight?: string
    revealLine?: number | null
    highlightRange?: { startLine: number; endLine: number } | null
    dimHighlightRanges?: Array<{ startLine: number; endLine: number }> | null
    highlightKind?: 'current' | 'incoming' | 'merged' | ''
    gutterPlacement?: 'glyph' | 'line'
    gutterItems?: Array<{ blockId: number; line: number; kind: 'current' | 'incoming' }>
    rightActions?: Array<{ blockId: number; line: number; kind: 'current' | 'incoming' }>
    appliedBlocks?: Array<{ blockId: number; choice: 'current' | 'incoming' | 'both' }>
    syncGroup?: string | null
    syncScrollTop?: number | null
  }>(),
  {
    language: 'plaintext',
    filePath: '',
    theme: 'auto',
    readOnly: false,
    minHeight: '360px',
    revealLine: null,
    highlightRange: null,
    dimHighlightRanges: null,
    highlightKind: '',
    gutterPlacement: 'glyph',
    gutterItems: () => [],
    rightActions: () => [],
    appliedBlocks: () => [],
    syncGroup: null,
    syncScrollTop: null
  }
)

const emit = defineEmits<{
  'update:modelValue': [v: string]
  'gutter-click': [blockId: number, action?: 'accept' | 'discard']
  'scroll-change': [scrollTop: number]
}>()

const containerRef = ref<HTMLDivElement | null>(null)

let monaco: any = null
let editor: any = null
let model: any = null
let themeObserver: MutationObserver | null = null
let monacoLoaderPromise: Promise<any> | null = null
let suppressEmit = false
let decorationIds: string[] = []
let dimDecorationIds: string[] = []
let gutterDecorationIds: string[] = []
let mouseDownDisposable: any = null
let rightActionsContainer: HTMLDivElement | null = null
let rightActionNodes = new Map<number, HTMLDivElement>()
let scrollDisposable: any = null
let layoutDisposable: any = null

function applyGutterMarginOption() {
  if (!editor) return
  const items = props.gutterItems || []
  const useGlyph = props.gutterPlacement === 'glyph' && items.length > 0
  try {
    editor.updateOptions({ glyphMargin: useGlyph })
  } catch {}
}

function ensureRightActionsContainer() {
  if (!editor) return
  if (rightActionsContainer) return
  const root = editor.getDomNode?.() as HTMLElement | null
  if (!root) return

  rightActionsContainer = document.createElement('div')
  rightActionsContainer.className = 'merge-right-actions'
  root.appendChild(rightActionsContainer)
}

function clearRightActions() {
  if (!rightActionsContainer) return
  rightActionsContainer.innerHTML = ''
  rightActionNodes.clear()
}

function layoutRightActions() {
  if (!editor || !monaco) return
  if (!rightActionsContainer) return

  const actions = props.rightActions || []
  if (!actions.length) return

  const info = editor.getLayoutInfo?.()
  const contentLeft = info?.contentLeft ?? 0
  const contentWidth = info?.contentWidth ?? 0
  // WebStorm风格：两个按钮并排，总宽度44px（每个22px）
  const targetLeft = Math.max(0, contentLeft + contentWidth - 44)

  for (const a of actions) {
    const wrapper = rightActionNodes.get(a.blockId)
    if (!wrapper) continue
    const col = model?.getLineMaxColumn?.(a.line) ?? 1
    const pos = editor.getScrolledVisiblePosition?.({ lineNumber: a.line, column: col })
    if (!pos) {
      wrapper.style.display = 'none'
      continue
    }
    wrapper.style.display = ''
    wrapper.style.top = `${pos.top}px`
    wrapper.style.left = `${targetLeft}px`
    wrapper.style.height = `${pos.height}px`
  }
}

function isBlockApplied(blockId: number, kind: 'current' | 'incoming'): boolean {
  const applied = props.appliedBlocks || []
  const block = applied.find(b => b.blockId === blockId)
  if (!block) return false
  if (kind === 'current') {
    return block.choice === 'current' || block.choice === 'both'
  }
  return block.choice === 'incoming' || block.choice === 'both'
}

function isBlockDiscarded(blockId: number, kind: 'current' | 'incoming'): boolean {
  const applied = props.appliedBlocks || []
  const block = applied.find(b => b.blockId === blockId)
  if (!block) return false
  // 当选择了相反的一方时，当前这一方被视为"丢弃"
  if (kind === 'current') {
    return block.choice === 'incoming'
  }
  return block.choice === 'current'
}

function applyRightActions() {
  if (!editor) return
  ensureRightActionsContainer()
  if (!rightActionsContainer) return

  const actions = (props.rightActions || []).filter((a) => a && a.line && a.line > 0)
  if (!actions.length) {
    clearRightActions()
    return
  }

  // 重建（数量很少，简单可靠）
  clearRightActions()
  for (const a of actions) {
    const isApplied = isBlockApplied(a.blockId, a.kind)
    const isDiscarded = isBlockDiscarded(a.blockId, a.kind)
    
    // WebStorm风格：创建按钮包装器，包含两个按钮
    const wrapper = document.createElement('div')
    wrapper.className = 'merge-right-action-wrapper'
    
    // 左侧面板（current）：显示 →（接受）和 ✕（丢弃）
    // 右侧面板（incoming）：显示 ✕（丢弃）和 ←（接受）
    // 注意：这里的"左/右"是从用户视角看的按钮排列顺序
    
    if (a.kind === 'current') {
      // 左侧面板：箭头按钮（接受当前）在左，关闭按钮（丢弃当前）在右
      const arrowBtn = document.createElement('div')
      arrowBtn.className = `merge-right-action merge-right-action-current${isApplied ? ' is-applied' : ''}`
      arrowBtn.textContent = isApplied ? '✓' : '→'
      arrowBtn.title = isApplied ? '已采用当前更改' : '采用当前更改'
      arrowBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      arrowBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        emit('gutter-click', a.blockId, 'accept')
      })
      
      const closeBtn = document.createElement('div')
      closeBtn.className = `merge-right-action merge-right-action-close${isDiscarded ? ' is-discarded' : ''}`
      closeBtn.textContent = '✕'
      closeBtn.title = isDiscarded ? '已丢弃当前更改' : '丢弃当前更改'
      closeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 丢弃当前 = 采用传入
        emit('gutter-click', a.blockId, 'discard')
      })
      
      wrapper.appendChild(arrowBtn)
      wrapper.appendChild(closeBtn)
    } else {
      // 右侧面板（incoming）：关闭按钮（丢弃传入）在左，箭头按钮（接受传入）在右
      const closeBtn = document.createElement('div')
      closeBtn.className = `merge-right-action merge-right-action-close${isDiscarded ? ' is-discarded' : ''}`
      closeBtn.textContent = '✕'
      closeBtn.title = isDiscarded ? '已丢弃传入更改' : '丢弃传入更改'
      closeBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 丢弃传入 = 采用当前
        emit('gutter-click', a.blockId, 'discard')
      })
      
      const arrowBtn = document.createElement('div')
      arrowBtn.className = `merge-right-action merge-right-action-incoming${isApplied ? ' is-applied' : ''}`
      arrowBtn.textContent = isApplied ? '✓' : '←'
      arrowBtn.title = isApplied ? '已采用传入更改' : '采用传入更改'
      arrowBtn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      arrowBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        emit('gutter-click', a.blockId, 'accept')
      })
      
      wrapper.appendChild(closeBtn)
      wrapper.appendChild(arrowBtn)
    }
    
    rightActionsContainer!.appendChild(wrapper)
    rightActionNodes.set(a.blockId, wrapper)
  }

  layoutRightActions()
}

async function ensureMonacoLoaded() {
  if (monaco) return monaco
  if (monacoLoaderPromise) return monacoLoaderPromise

  monacoLoaderPromise = (async () => {
    const w = self as any
    if (!w.MonacoEnvironment) {
      w.MonacoEnvironment = {
        getWorker(_workerId: string, label: string) {
          if (label === 'json') return new JsonWorker()
          if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
          if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
          if (label === 'typescript' || label === 'javascript') return new TsWorker()
          return new EditorWorker()
        }
      }
    }

    const m = await import('monaco-editor')
    monaco = m
    return monaco
  })()

  return monacoLoaderPromise
}

function detectLanguageFromPath(p: string) {
  const filePath = (p || '').toLowerCase()
  const m = filePath.match(/\.([a-z0-9]+)$/)
  const ext = m ? m[1] : ''

  if (ext === 'ts' || ext === 'tsx') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'cjs' || ext === 'mjs') return 'javascript'
  if (ext === 'json') return 'json'
  if (ext === 'html' || ext === 'htm' || ext === 'vue') return 'html'
  if (ext === 'css') return 'css'
  if (ext === 'scss') return 'scss'
  if (ext === 'less') return 'less'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'yml' || ext === 'yaml') return 'yaml'
  if (ext === 'xml') return 'xml'
  if (ext === 'sh') return 'shell'
  if (ext === 'ps1') return 'powershell'
  if (ext === 'go') return 'go'
  if (ext === 'rs') return 'rust'
  if (ext === 'py') return 'python'
  if (ext === 'java') return 'java'
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'hpp' || ext === 'h') return 'cpp'
  if (ext === 'cs') return 'csharp'

  return 'plaintext'
}

function getResolvedLanguage() {
  if (props.language === 'auto') {
    return detectLanguageFromPath(props.filePath || '')
  }
  return props.language || 'plaintext'
}

function getResolvedTheme() {
  if (props.theme && props.theme !== 'auto') return props.theme
  const dt = document.documentElement.getAttribute('data-theme')
  return dt === 'dark' ? 'vs-dark' : 'vs'
}

function applyTheme() {
  if (!monaco) return
  monaco.editor.setTheme(getResolvedTheme())
}

function ensureModel() {
  if (!monaco) return
  const lang = getResolvedLanguage()
  if (!model) {
    model = monaco.editor.createModel(props.modelValue || '', lang)
    return
  }
  try {
    monaco.editor.setModelLanguage(model, lang)
  } catch {}
}

function updateModelValueFromProps() {
  if (!model) return
  const next = props.modelValue || ''
  if (model.getValue() === next) return
  suppressEmit = true
  model.setValue(next)
  suppressEmit = false
}

function applyRevealLine() {
  if (!editor) return
  const ln = props.revealLine
  if (!ln || ln <= 0) return
  try {
    editor.revealLineInCenter(ln)
  } catch {}
}

function applyHighlight() {
  if (!monaco || !editor) return

  // 非激活块：弱高亮（多段）
  if (!props.dimHighlightRanges || !props.dimHighlightRanges.length || !props.highlightKind) {
    dimDecorationIds = editor.deltaDecorations(dimDecorationIds, [])
  } else {
    const dimClassName =
      props.highlightKind === 'current'
        ? 'merge-highlight-current-dim'
        : props.highlightKind === 'incoming'
          ? 'merge-highlight-incoming-dim'
          : 'merge-highlight-merged-dim'

    dimDecorationIds = editor.deltaDecorations(
      dimDecorationIds,
      props.dimHighlightRanges
        .filter((r) => r && r.startLine > 0 && r.endLine > 0)
        .map((r) => {
          const startLine = Math.max(1, r.startLine)
          const endLine = Math.max(startLine, r.endLine)
          return {
            range: new monaco.Range(startLine, 1, endLine, 1),
            options: {
              isWholeLine: true,
              className: dimClassName,
              linesDecorationsClassName: dimClassName,
            },
          }
        }),
    )
  }

  if (!props.highlightRange || !props.highlightKind) {
    decorationIds = editor.deltaDecorations(decorationIds, [])
    return
  }

  const startLine = Math.max(1, props.highlightRange.startLine)
  const endLine = Math.max(startLine, props.highlightRange.endLine)
  const className =
    props.highlightKind === 'current'
      ? 'merge-highlight-current'
      : props.highlightKind === 'incoming'
        ? 'merge-highlight-incoming'
        : 'merge-highlight-merged'

  decorationIds = editor.deltaDecorations(decorationIds, [
    {
      range: new monaco.Range(startLine, 1, endLine, 1),
      options: {
        isWholeLine: true,
        className,
        linesDecorationsClassName: className,
      },
    },
  ])
}

function applyGutterItems() {
  if (!monaco || !editor) return

  const items = props.gutterItems || []
  if (!items.length) {
    gutterDecorationIds = editor.deltaDecorations(gutterDecorationIds, [])
    applyGutterMarginOption()
    return
  }

  applyGutterMarginOption()

  const useLine = props.gutterPlacement === 'line'

  gutterDecorationIds = editor.deltaDecorations(
    gutterDecorationIds,
    items
      .filter((it) => it && it.line && it.line > 0)
      .map((it) => {
        const isApplied = isBlockApplied(it.blockId, it.kind)
        const className = it.kind === 'current' 
          ? (isApplied ? 'merge-glyph-current is-applied' : 'merge-glyph-current')
          : (isApplied ? 'merge-glyph-incoming is-applied' : 'merge-glyph-incoming')
        return {
          range: new monaco.Range(it.line, 1, it.line, 1),
          options: {
            isWholeLine: true,
            ...(useLine ? { linesDecorationsClassName: className } : { glyphMarginClassName: className }),
          },
        }
      }),
  )
}

onMounted(async () => {
  if (!containerRef.value) return

  monaco = await ensureMonacoLoaded()
  applyTheme()

  ensureModel()

  editor = monaco.editor.create(containerRef.value, {
    automaticLayout: true,
    readOnly: props.readOnly,
    glyphMargin: false,
    minimap: { enabled: false },
    fontSize: 13,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
  })

  editor.setModel(model)

  editor.onDidChangeModelContent(() => {
    if (suppressEmit) return
    const v = model?.getValue?.() ?? ''
    emit('update:modelValue', v)
  })

  themeObserver = new MutationObserver(() => {
    applyTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  applyRevealLine()
  applyHighlight()
  applyGutterItems()
  applyRightActions()

  scrollDisposable = editor.onDidScrollChange((e: any) => {
    layoutRightActions()
    // 同步滚动：如果属于同步组，通知父组件
    if (props.syncGroup && e.scrollTopChanged) {
      emit('scroll-change', e.scrollTop)
    }
  })
  layoutDisposable = editor.onDidLayoutChange(() => {
    layoutRightActions()
  })

  mouseDownDisposable = editor.onMouseDown((e: any) => {
    try {
      const target = e?.target
      const pos = target?.position
      if (!pos?.lineNumber) return
      const t = target?.type
      if (
        t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
        t !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
      ) {
        return
      }

      const line = pos.lineNumber as number
      const hit = (props.gutterItems || []).find((it) => it.line === line)
      if (!hit) return
      emit('gutter-click', hit.blockId)
    } catch {}
  })
})

watch(
  () => props.modelValue,
  () => {
    updateModelValueFromProps()
  }
)

watch(
  () => props.revealLine,
  () => {
    applyRevealLine()
  },
)

watch(
  () => [props.highlightRange, props.highlightKind],
  () => {
    applyHighlight()
  },
  { deep: true },
)

watch(
  () => props.dimHighlightRanges,
  () => {
    applyHighlight()
  },
  { deep: true },
)

watch(
  () => props.gutterItems,
  () => {
    applyGutterItems()
  },
  { deep: true },
)

watch(
  () => props.rightActions,
  () => {
    applyRightActions()
  },
  { deep: true },
)

watch(
  () => props.appliedBlocks,
  () => {
    applyRightActions()
    applyGutterItems()
  },
  { deep: true },
)

// 监听同步滚动位置
watch(
  () => props.syncScrollTop,
  (newScrollTop) => {
    if (newScrollTop !== null && newScrollTop !== undefined && editor) {
      const currentScrollTop = editor.getScrollTop()
      // 只有差异较大时才同步，避免循环
      if (Math.abs(currentScrollTop - newScrollTop) > 5) {
        editor.setScrollTop(newScrollTop)
      }
    }
  }
)

watch(
  () => props.gutterPlacement,
  () => {
    applyGutterItems()
  },
)

watch(
  () => [props.language, props.filePath],
  () => {
    if (!monaco) return
    ensureModel()
  }
)

watch(
  () => props.theme,
  () => {
    applyTheme()
  }
)

watch(
  () => props.readOnly,
  (v) => {
    if (!editor) return
    editor.updateOptions({ readOnly: v })
  }
)

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null

  try {
    mouseDownDisposable?.dispose?.()
  } catch {}
  mouseDownDisposable = null

  try {
    scrollDisposable?.dispose?.()
  } catch {}
  scrollDisposable = null

  try {
    layoutDisposable?.dispose?.()
  } catch {}
  layoutDisposable = null

  try {
    rightActionsContainer?.remove?.()
  } catch {}
  rightActionsContainer = null
  rightActionNodes.clear()

  editor?.dispose()
  editor = null

  dimDecorationIds = []

  model?.dispose()
  model = null
})
</script>

<template>
  <div ref="containerRef" class="monaco-editor-container" :style="minHeight ? { minHeight } : { flex: 1, minHeight: '200px' }" />
</template>

<style scoped>
.monaco-editor-container {
  width: 100%;
  height: 100%;
}

.monaco-editor-container :deep(.merge-highlight-current) {
  background: rgba(59, 130, 246, 0.16);
}

.monaco-editor-container :deep(.merge-highlight-current-dim) {
  background: rgba(59, 130, 246, 0.07);
}

.monaco-editor-container :deep(.merge-highlight-incoming) {
  background: rgba(34, 197, 94, 0.16);
}

.monaco-editor-container :deep(.merge-highlight-incoming-dim) {
  background: rgba(34, 197, 94, 0.07);
}

.monaco-editor-container :deep(.merge-highlight-merged) {
  background: rgba(245, 158, 11, 0.14);
}

.monaco-editor-container :deep(.merge-highlight-merged-dim) {
  background: rgba(245, 158, 11, 0.06);
}

.monaco-editor-container :deep(.merge-glyph-current) {
  cursor: pointer;
}

.monaco-editor-container :deep(.merge-glyph-current)::before {
  content: '→';
  display: inline-block;
  width: 100%;
  text-align: center;
  color: rgba(59, 130, 246, 0.95);
  font-weight: 700;
}

.monaco-editor-container :deep(.merge-glyph-incoming) {
  cursor: pointer;
}

.monaco-editor-container :deep(.merge-glyph-incoming)::before {
  content: '←';
  display: inline-block;
  width: 100%;
  text-align: center;
  color: rgba(34, 197, 94, 0.95);
  font-weight: 700;
}

.monaco-editor-container :deep(.merge-right-actions) {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 5;
}

/* WebStorm风格：按钮包装器，包含两个并排按钮 */
.monaco-editor-container :deep(.merge-right-action-wrapper) {
  position: absolute;
  display: flex;
  flex-direction: row;
  width: 44px;
  pointer-events: auto;
}

.monaco-editor-container :deep(.merge-right-action) {
  width: 22px;
  text-align: center;
  font-weight: 700;
  cursor: pointer;
  pointer-events: auto;
  user-select: none;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.monaco-editor-container :deep(.merge-right-action:hover) {
  background: rgba(0, 0, 0, 0.06);
}

.monaco-editor-container :deep(.merge-right-action-current) {
  color: rgba(59, 130, 246, 0.95);
}

.monaco-editor-container :deep(.merge-right-action-incoming) {
  color: rgba(34, 197, 94, 0.95);
}

.monaco-editor-container :deep(.merge-right-action-close) {
  color: rgba(239, 68, 68, 0.85);
}

.monaco-editor-container :deep(.merge-right-action-close:hover) {
  background: rgba(239, 68, 68, 0.1);
  color: rgba(239, 68, 68, 1);
}

/* 已应用状态样式 */
.monaco-editor-container :deep(.merge-right-action.is-applied) {
  background: rgba(34, 197, 94, 0.15) !important;
  color: rgba(34, 197, 94, 1) !important;
  font-weight: 700;
}

/* 已丢弃状态样式 */
.monaco-editor-container :deep(.merge-right-action.is-discarded) {
  background: rgba(239, 68, 68, 0.15) !important;
  color: rgba(239, 68, 68, 1) !important;
  font-weight: 700;
}

.monaco-editor-container :deep(.merge-glyph-current.is-applied)::before {
  content: '✓';
  color: rgba(34, 197, 94, 0.95);
}

.monaco-editor-container :deep(.merge-glyph-incoming.is-applied)::before {
  content: '✓';
  color: rgba(34, 197, 94, 0.95);
}
</style>
