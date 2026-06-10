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
 * - 解析 markdown → 拆分为 [html 片段 | mindmap 块] 列表
 * - 普通片段 v-html 渲染
 * - ```mindmap 围栏 → <MindMap> 组件渲染（来自 flow-mindmap）
 */
import { computed } from 'vue'
import { marked } from 'marked'
import { MindMap, markdownToMindMap } from 'flow-mindmap'
import 'flow-mindmap/style.css'

interface Props {
  /** 原始 markdown 文本 */
  content: string
}

const props = defineProps<Props>()

type Segment =
  | { type: 'html'; html: string }
  | { type: 'mindmap'; id: number; md: string; data: ReturnType<typeof markdownToMindMap> }

/**
 * 拆分 markdown:
 * 1. 抽出所有 ```mindmap 围栏块,记录 id 和内容
 * 2. 把围栏替换为占位符
 * 3. 走 marked → HTML
 * 4. 沿占位符切分 HTML 字符串,得到 [html | mindmap | html | ...] 列表
 */
const segments = computed<Segment[]>(() => {
  const src = props.content || ''
  const fences: { id: number; md: string }[] = []
  const placeholderPrefix = '\x00MINDMAP_BLOCK_'
  const placeholderSuffix = '\x00'

  // 匹配 ```mindmap ... ``` 围栏;语言名忽略大小写、允许空白
  const fenceRe = /```[ \t]*mindmap[ \t]*\n([\s\S]*?)```/gi
  const replaced = src.replace(fenceRe, (_m, body: string) => {
    const id = fences.length
    fences.push({ id, md: body })
    return `${placeholderPrefix}${id}${placeholderSuffix}`
  })

  const html = marked.parse(replaced, { async: false }) as string

  // 把占位符还原成不可见标记,便于在 HTML 字符串里切分
  const placeholderRe = new RegExp(
    `${placeholderPrefix}(\\d+)${placeholderSuffix}`,
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
</script>

<template>
  <div class="md-preview">
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
.md-preview {
  padding: 20px 24px;
  color: inherit;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

/* 透出到全局样式:让 marked 出来的标签继承主题色 */
.md-preview :deep(h1),
.md-preview :deep(h2),
.md-preview :deep(h3),
.md-preview :deep(h4),
.md-preview :deep(h5),
.md-preview :deep(h6) {
  border-bottom: 1px solid var(--border-color, #d0d7de);
  padding-bottom: 0.3em;
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
}
.md-preview :deep(h1) { font-size: 1.8em; }
.md-preview :deep(h2) { font-size: 1.4em; }
.md-preview :deep(h3) { font-size: 1.2em; }
.md-preview :deep(p) { margin: 0 0 14px; }
.md-preview :deep(a) { color: var(--link-color, #0969da); text-decoration: none; }
.md-preview :deep(a:hover) { text-decoration: underline; }
.md-preview :deep(code) {
  background: var(--code-bg, #f6f8fa);
  padding: 2px 5px;
  border-radius: 4px;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 87%;
}
.md-preview :deep(pre) {
  background: var(--code-bg, #f6f8fa);
  padding: 14px 16px;
  border-radius: 6px;
  overflow: auto;
  margin: 0 0 16px;
}
.md-preview :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 100%;
}
.md-preview :deep(blockquote) {
  border-left: 3px solid var(--border-color, #d0d7de);
  margin: 0 0 16px;
  padding: 0 16px;
  color: var(--text-secondary, #656d76);
}
.md-preview :deep(img) { max-width: 100%; border-radius: 4px; }
.md-preview :deep(hr) {
  border: none;
  border-top: 1px solid var(--border-color, #d0d7de);
  margin: 24px 0;
}
.md-preview :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 16px;
}
.md-preview :deep(th),
.md-preview :deep(td) {
  border: 1px solid var(--border-color, #d0d7de);
  padding: 6px 13px;
}
.md-preview :deep(thead tr) { background: var(--code-bg, #f6f8fa); }
.md-preview :deep(ul),
.md-preview :deep(ol) { padding-left: 2em; margin-bottom: 16px; }
.md-preview :deep(li) { margin: 4px 0; }

.md-segment { display: block; }

.md-mindmap {
  margin: 18px 0 28px;
  border: 1px solid var(--border-color, #d0d7de);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-panel, #ffffff);
}
.md-mindmap-title {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #656d76);
  background: var(--code-bg, #f6f8fa);
  border-bottom: 1px solid var(--border-color, #d0d7de);
  letter-spacing: 0.5px;
}
.md-mindmap-canvas {
  width: 100%;
  height: 480px;
  display: block;
}
</style>
