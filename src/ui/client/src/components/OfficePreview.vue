<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { getFileExtension, getOfficePreviewUrl, getOfficeRawUrl } from '@/utils/officeFile'

const props = withDefaults(defineProps<{
  filePath: string
  source?: 'worktree' | 'git'
  rev?: string
  side?: 'old' | 'new'
}>(), { source: 'worktree', rev: '', side: 'new' })

const DocxPreview = defineAsyncComponent(() => import('@vue-office/docx'))
const ExcelPreview = defineAsyncComponent(() => import('@vue-office/excel'))
const PptxPreview = defineAsyncComponent(() => import('@vue-office/pptx'))

const ext = computed(() => getFileExtension(props.filePath))
const officeComponent = computed(() => {
  if (ext.value === 'docx') return DocxPreview
  if (ext.value === 'xls' || ext.value === 'xlsx') return ExcelPreview
  if (ext.value === 'pptx') return PptxPreview
  return null
})
const rawUrl = computed(() => getOfficeRawUrl(props.filePath, {
  source: props.source, rev: props.rev, side: props.side,
}))
const fallbackUrl = computed(() => getOfficePreviewUrl(props.filePath, {
  source: props.source, rev: props.rev, side: props.side,
}))

const sourceData = ref<ArrayBuffer | null>(null)
const fallbackBlobUrl = ref('')
const loading = ref(false)
const failed = ref(false)
const usingFallback = ref(false)
let requestId = 0

function revokeFallbackUrl() {
  if (fallbackBlobUrl.value) URL.revokeObjectURL(fallbackBlobUrl.value)
  fallbackBlobUrl.value = ''
}

async function fetchFallback(id: number) {
  try {
    const response = await fetch(fallbackUrl.value)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (id !== requestId) return
    fallbackBlobUrl.value = URL.createObjectURL(await response.blob())
    usingFallback.value = true
    failed.value = false
  } catch {
    if (id === requestId) failed.value = true
  }
}

async function loadPreview() {
  const id = ++requestId
  loading.value = true
  failed.value = false
  usingFallback.value = false
  sourceData.value = null
  revokeFallbackUrl()
  if (!officeComponent.value) {
    await fetchFallback(id)
    if (id === requestId) loading.value = false
    return
  }
  try {
    const response = await fetch(rawUrl.value)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (id !== requestId) return
    sourceData.value = await response.arrayBuffer()
  } catch {
    await fetchFallback(id)
  } finally {
    if (id === requestId) loading.value = false
  }
}

function onRenderError() {
  if (!usingFallback.value) {
    const id = requestId
    sourceData.value = null
    loading.value = true
    void fetchFallback(id).finally(() => { if (id === requestId) loading.value = false })
  }
}

function reload() { void loadPreview() }
watch(rawUrl, () => { void loadPreview() }, { immediate: true })
onBeforeUnmount(() => { requestId++; revokeFallbackUrl() })
</script>

<template>
  <div class="office-preview">
    <div class="office-preview-toolbar">
      <span class="office-preview-title">Office 预览</span>
      <span class="office-preview-badge">{{ ext.toUpperCase() }}</span>
      <span v-if="source === 'git'" class="office-preview-side">{{ side === 'old' ? '旧版本' : '新版本' }}</span>
      <button class="office-preview-reload" type="button" @click="reload">刷新</button>
    </div>
    <div v-if="loading" class="office-preview-state">正在生成预览…</div>
    <div v-else-if="failed" class="office-preview-state office-preview-error">
      <p>无法预览此 Office 文件。</p>
      <p class="office-preview-hint">支持 docx、xls/xlsx、pptx；老格式需要安装 LibreOffice 才能兜底预览。</p>
    </div>
    <iframe v-else-if="usingFallback" class="office-preview-frame" :src="fallbackBlobUrl" title="Office 文件 PDF 预览" />
    <component
      :is="officeComponent"
      v-else-if="officeComponent && sourceData"
      class="office-preview-document"
      :src="sourceData"
      @error="onRenderError"
    />
  </div>
</template>

<style scoped>
.office-preview { display: flex; flex-direction: column; height: 100%; min-height: 0; background: #fff; }
.office-preview-toolbar { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px; flex: 0 0 34px; border-bottom: 1px solid var(--border-color-light); }
.office-preview-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.office-preview-badge, .office-preview-side { font-size: 10px; padding: 2px 5px; border-radius: 3px; background: rgba(59,130,246,.15); color: var(--color-primary); }
.office-preview-side { background: var(--bg-hover); color: var(--text-tertiary); }
.office-preview-reload { margin-left: auto; border: 0; background: transparent; color: var(--text-tertiary); cursor: pointer; font-size: 12px; }
.office-preview-document { flex: 1; min-height: 0; overflow: auto; }
.office-preview-frame { width: 100%; height: 100%; flex: 1; border: 0; background: #525659; }
.office-preview-state { display: grid; place-content: center; flex: 1; text-align: center; color: var(--text-secondary); font-size: 13px; }
.office-preview-error { color: var(--color-danger, #d33); }
.office-preview-hint { color: var(--text-secondary); font-size: 12px; }
</style>

<style>
@import '@vue-office/docx/lib/index.css';
@import '@vue-office/excel/lib/index.css';
</style>
