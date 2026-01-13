<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null
    if (existing) {
      if ((existing as any)._loaded) return resolve()
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)))
      return
    }

    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.addEventListener('load', () => {
      ;(s as any)._loaded = true
      resolve()
    })
    s.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)))
    document.head.appendChild(s)
  })
}

function loadCss(href: string) {
  const existing = document.querySelector(`link[href="${href}"]`) as HTMLLinkElement | null
  if (existing) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

async function ensureMonacoLoaded() {
  if (monaco) return monaco
  if (monacoLoaderPromise) return monacoLoaderPromise

  const version = '0.55.1'
  const base = `https://cdn.jsdelivr.net/npm/monaco-editor@${version}/min/vs`
  const cssHref = `${base}/editor/editor.main.min.css`
  const loaderSrc = `${base}/loader.js`

  monacoLoaderPromise = (async () => {
    loadCss(cssHref)
    await loadScript(loaderSrc)

    const w = window as any
    if (!w.require) throw new Error('Monaco loader not found')

    w.require.config({ paths: { vs: base } })
    await new Promise<void>((resolve, reject) => {
      w.require(['vs/editor/editor.main'], () => resolve(), reject)
    })

    monaco = w.monaco
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
