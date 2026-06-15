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
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

// 跨组件共享的编辑器"未保存文件"状态：
// EditorView 写入（每次内容变更 / 保存 / 关闭 tab 时），ActivityBar 读取以显示徽标。
// 和 Git 的 uncommitted 徽标刻意区分开：
//   - editor dirty = 文件已改动但尚未落盘（编辑器内部状态）
//   - git uncommitted = 改动已落盘但尚未提交（仓库状态）
export const useEditorTabsStore = defineStore('editorTabs', () => {
  const dirtyCount = ref(0)

  function setDirtyCount(n: number) {
    dirtyCount.value = Math.max(0, n | 0)
  }

  const hasDirty = computed(() => dirtyCount.value > 0)

  return { dirtyCount, hasDirty, setDirtyCount }
})
