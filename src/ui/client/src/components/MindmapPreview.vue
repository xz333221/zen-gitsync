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
 * 思维导图预览组件
 * - 整篇 markdown 解析为一张大导图(markdownToRichMindMap)
 * - 标题层级作为节点父子关系
 * - 正文段落、列表项、代码块、表格都作为子节点,带 richContent 渲染
 * - 不可编辑、不可拖拽(previewMode)
 */
import { computed } from 'vue'
import { MindMap, markdownToRichMindMap } from 'flow-mindmap'
import 'flow-mindmap/style.css'

interface Props {
  /** 原始 markdown 文本 */
  content: string
}

const props = defineProps<Props>()

const data = computed(() => markdownToRichMindMap(props.content || '', '未命名文档'))
</script>

<template>
  <div class="mindmap-preview">
    <div class="mindmap-preview-header">
      <span class="mindmap-preview-title">整篇导图</span>
      <span class="mindmap-preview-hint">基于整篇 Markdown 自动生成 · 阅读模式</span>
    </div>
    <div class="mindmap-preview-canvas">
      <MindMap
        :data="data"
        preview-mode
      />
    </div>
  </div>
</template>

<style scoped>
.mindmap-preview {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-container, #ffffff);
}
.mindmap-preview-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--bg-panel, #f6f8fa);
  font-size: 12px;
}
.mindmap-preview-title {
  font-weight: 600;
  color: var(--text-primary, #1f2328);
  letter-spacing: 0.5px;
}
.mindmap-preview-hint {
  color: var(--text-secondary, #656d76);
  font-size: 11px;
}
.mindmap-preview-canvas {
  flex: 1;
  width: 100%;
  min-height: 0;
}
.mindmap-preview-canvas :deep(.zm-mindmap),
.mindmap-preview-canvas > * {
  width: 100%;
  height: 100%;
}
</style>
