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
/**
 * Markdown 预览组件
 * - 渲染交给 flowdash-md-preview（markdown-it + highlight.js），不再自带 marked
 * - 解析结果拆分为 [html 片段 | mindmap 块] 列表，普通片段 v-html 渲染
 * - ```mindmap 围栏 → <MindMap> 组件渲染（来自 flow-mindmap）
 * - 排版与配色统一由 flowdash-md-preview 的主题提供（见 utils/markdownTheme.ts，
 *   全应用只注入一套），本组件不再自带排版样式，避免与主题打架
 */
import { computed, ref } from 'vue'
import { render as renderMarkdown } from 'flowdash-md-preview'
import { MindMap, markdownToMindMap } from 'flow-mindmap'
import { getRawFileUrl } from '@/utils/fileKind'
import 'flow-mindmap/style.css'

interface Props {
  /** 原始 markdown 文本 */
  content: string
  /** 是否允许 markdown 中的原始 HTML。AI 等不可信内容应关闭。 */
  allowHtml?: boolean
  /**
   * 源文件绝对路径。给了它，正文里相对路径的图片才会被解析成
   * /api/editor/raw 端点（浏览器按当前页面 URL 解析相对路径必然 404）。
   */
  basePath?: string
}

const props = withDefaults(defineProps<Props>(), { allowHtml: true })

type Segment =
  | { type: 'html'; html: string }
  | { type: 'mindmap'; id: number; md: string; data: ReturnType<typeof markdownToMindMap> }

function sanitizeRenderedHtml(value: string): string {
  if (typeof document === 'undefined') return value
  const template = document.createElement('template')
  template.innerHTML = value
  template.content.querySelectorAll('script, style, iframe, object, embed, form, input, button, textarea, select').forEach(node => node.remove())

  template.content.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
        element.removeAttribute(attribute.name)
        continue
      }
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        const url = attribute.value.trim().replace(/[\u0000-\u0020]+/g, '')
        const safe = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(url)
          || (name === 'src' && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(url))
        if (!safe) element.removeAttribute(attribute.name)
      }
    }
    if (element.getAttribute('target') === '_blank') {
      element.setAttribute('rel', 'noopener noreferrer')
    }
  })
  return template.innerHTML
}

/**
 * 把 markdown 里相对路径的图片解析成绝对路径，并换成 /api/editor/raw 端点。
 * - 外部 URL / 协议 / 锚点 / data: / 以 / 开头的路径一律不动
 * - 相对路径以 basePath（源文件绝对路径）所在目录为基准，处理 ./ 与 ../
 */
function resolveLocalAssetPath(basePath: string, rawUrl: string): string | null {
  const url = rawUrl.trim()
  if (!url) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#') || url.startsWith('/')) {
    return null
  }
  let decoded = url
  try { decoded = decodeURIComponent(url) } catch { /* 非法转义就按原值用 */ }
  const normalizedBase = basePath.replace(/\\/g, '/')
  const dir = normalizedBase.replace(/\/[^/]*$/, '')
  const stack: string[] = []
  for (const seg of `${dir}/${decoded}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { stack.pop(); continue }
    stack.push(seg)
  }
  const joined = stack.join('/')
  return normalizedBase.startsWith('/') ? `/${joined}` : joined
}

function rewriteLocalAssetUrls(html: string, basePath: string): string {
  if (typeof document === 'undefined') return html
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('img[src]').forEach((element) => {
    const src = element.getAttribute('src') || ''
    const resolved = resolveLocalAssetPath(basePath, src)
    if (resolved) element.setAttribute('src', getRawFileUrl(resolved))
  })
  return template.innerHTML
}

/**
 * 拆分 markdown:
 * 1. 抽出所有 ```mindmap 围栏块,记录 id 和内容
 * 2. 把围栏替换为占位符(markdown-it 会把 \u0000 规范化成 U+FFFD,
 *    所以占位符只能是不含 markdown 语法字符的纯 ASCII)
 * 3. 走 flowdash-md-preview 的 render → HTML
 * 4. 沿占位符切分 HTML 字符串,得到 [html | mindmap | html | ...] 列表
 */
const segments = computed<Segment[]>(() => {
  const src = props.content || ''
  const fences: { id: number; md: string }[] = []
  const placeholderPrefix = '@@FLOWDASH_MINDMAP_BLOCK_'
  const placeholderSuffix = '@@'

  // 匹配 ```mindmap ... ``` 围栏;语言名忽略大小写、允许空白
  const fenceRe = /```[ \t]*mindmap[ \t]*\n([\s\S]*?)```/gi
  const replaced = src.replace(fenceRe, (_m, body: string) => {
    const id = fences.length
    fences.push({ id, md: body })
    return `${placeholderPrefix}${id}${placeholderSuffix}`
  })

  // className: false → 不套外层 <div class="md-preview">,外层由模板给
  const parsedHtml = renderMarkdown(replaced, {
    className: false,
    html: props.allowHtml
  })
  let html = props.allowHtml ? parsedHtml : sanitizeRenderedHtml(parsedHtml)
  if (props.basePath) html = rewriteLocalAssetUrls(html, props.basePath)

  // 独占一行的占位符会被 markdown-it 包成 <p>占位符</p>,切分时连标签一起吃掉,
  // 免得片段边界留下空的 <p>
  const placeholderRe = new RegExp(
    `(?:<p>)?\\s*${placeholderPrefix}(\\d+)${placeholderSuffix}\\s*(?:</p>)?`,
    'g'
  )
  const result: Segment[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = placeholderRe.exec(html)) !== null) {
    if (match.index > lastIndex) {
      result.push({ type: 'html', html: html.slice(lastIndex, match.index) })
    }
    const id = Number(match[1])
    result.push({ type: 'mindmap', id, md: fences[id].md, data: markdownToMindMap(fences[id].md) })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < html.length) {
    result.push({ type: 'html', html: html.slice(lastIndex) })
  }
  if (result.length === 0) {
    result.push({ type: 'html', html: '<p class="md-empty">无内容</p>' })
  }
  return result
})

const rootRef = ref<HTMLElement | null>(null)
/** 供外部（如复制到剪贴板）拿到渲染后的 DOM。 */
defineExpose({ getRenderedElement: () => rootRef.value })
</script>

<template>
  <div ref="rootRef" class="md-preview">
    <template v-for="(seg, idx) in segments" :key="idx">
      <div
        v-if="seg.type === 'html'"
        class="md-segment"
        v-html="seg.html"
      />
      <div v-else class="md-mindmap">
        <div class="md-mindmap-title">四维导图</div>
        <MindMap
          :data="seg.data"
          preview-mode
          class="md-mindmap-canvas"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 排版 / 配色全部由 flowdash-md-preview 的主题预设提供(全局注入一套,
   见 src/utils/markdownTheme.ts)。这里只保留必要的布局兜底与思维导图皮肤,
   不再覆盖 h1/pre/code 等标签,否则会盖住主题(属性选择器特异性更高)。 */
.md-preview {
  word-break: break-word;
}

.md-segment { display: block; }

.md-mindmap {
  margin: 18px 0 28px;
  border: 1px solid var(--border-color, var(--md-border));
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--bg-panel, #ffffff);
}
.md-mindmap-title {
  padding: 8px 12px;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary, var(--md-text-muted));
  background: var(--bg-code, var(--md-bg-subtle));
  letter-spacing: 0.5px;
}
.md-mindmap-canvas {
  width: 100%;
  height: 480px;
  display: block;
}
</style>
