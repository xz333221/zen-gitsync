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
    original: string
    modified: string
    language?: string
    filePath?: string
    theme?: string
    readOnly?: boolean
  }>(),
  {
    language: 'plaintext',
    filePath: '',
    theme: 'auto',
    readOnly: true,
  },
)

const containerRef = ref<HTMLDivElement | null>(null)

let monaco: any = null
let diffEditor: any = null
let originalModel: any = null
let modifiedModel: any = null

let themeObserver: MutationObserver | null = null

let monacoLoaderPromise: Promise<any> | null = null

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
        },
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
  const theme = getResolvedTheme()
  monaco.editor.setTheme(theme)
}

function createModels() {
  if (!monaco) return

  originalModel?.dispose()
  modifiedModel?.dispose()

  const lang = getResolvedLanguage()
  originalModel = monaco.editor.createModel(props.original || '', lang)
  modifiedModel = monaco.editor.createModel(props.modified || '', lang)
}

function setModelsToEditor() {
  if (!diffEditor || !originalModel || !modifiedModel) return
  diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel,
  })
}

function updateTextToModels() {
  if (originalModel && originalModel.getValue() !== (props.original || '')) {
    originalModel.setValue(props.original || '')
  }
  if (modifiedModel && modifiedModel.getValue() !== (props.modified || '')) {
    modifiedModel.setValue(props.modified || '')
  }
}

onMounted(async () => {
  if (!containerRef.value) return

  monaco = await ensureMonacoLoaded()

  applyTheme()
  createModels()

  diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
    automaticLayout: true,
    readOnly: props.readOnly,
    renderSideBySide: true,
    minimap: { enabled: false },
    fontSize: 13,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    originalEditable: !props.readOnly,
  })

  setModelsToEditor()

  themeObserver = new MutationObserver(() => {
    applyTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

watch(
  () => props.language,
  () => {
    if (!monaco) return
    const lang = getResolvedLanguage()
    if (originalModel) monaco.editor.setModelLanguage(originalModel, lang)
    if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, lang)
  },
)

watch(
  () => props.filePath,
  () => {
    if (!monaco) return
    if (props.language !== 'auto') return
    const lang = getResolvedLanguage()
    if (originalModel) monaco.editor.setModelLanguage(originalModel, lang)
    if (modifiedModel) monaco.editor.setModelLanguage(modifiedModel, lang)
  },
)

watch(
  () => props.theme,
  () => {
    applyTheme()
  },
)

watch(
  () => [props.original, props.modified],
  () => {
    updateTextToModels()
  },
)

onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null

  diffEditor?.dispose()
  diffEditor = null

  originalModel?.dispose()
  modifiedModel?.dispose()
  originalModel = null
  modifiedModel = null
})
</script>

<template>
  <div ref="containerRef" class="monaco-diff-container" />
</template>

<style scoped>
.monaco-diff-container {
  height: 100%;
  min-height: 320px;
}
</style>
