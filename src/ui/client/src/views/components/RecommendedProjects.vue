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
<!--
  「推荐添加」：磁盘上已有、但不在项目清单里的仓库。

  服务的根因：写 recentDirectories 的地方只有两处（GUI 启动 + /api/change_directory），
  所以智能体克隆 / 新建出来的仓库不会自己进清单。服务端扫一遍"已有项目的父目录"，
  把旁边的仓库列出来（扫描范围与预算见 routes/workbench/projectRecommend.js）。

  为什么把 add 做成**函数 prop** 而不是 emit：
  这一行点了「添加」之后要显示"已加入"还是"失败、留在原地"，需要知道结果；
  emit 是单向通知、拿不到返回值。父组件把 addProject 直接递进来最省事，
  也不影响"添加成功后刷新整份项目清单"（那是父组件的事）。

  一句话范围说明是刻意加的：用户看到"推荐"两字会以为扫了全盘，
  实际只扫了已有项目的同级目录 —— 不说清楚，扫描不到就变成一个说不清的 bug。
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import IconButton from '@components/IconButton.vue'
import { $t } from '@/lang/static'

export interface RecommendedProject {
  path: string
  name: string
  mtime: number
}

const props = defineProps<{
  /** 真正执行添加（父组件的 useWorkbenchProjects.addProject）；返回结果供本组件决定行内状态 */
  onAdd: (path: string) => Promise<{ ok: boolean; alreadyKnown: boolean }>
}>()

type Status = 'idle' | 'loading' | 'done' | 'empty' | 'error'

const status = ref<Status>('idle')
const items = ref<RecommendedProject[]>([])
const errorText = ref('')
const addingPath = ref('')
/** 本次会话里已经加成功的（服务端下次扫描也不会再列出来，这里只是立刻消失） */
const addedPaths = ref<Set<string>>(new Set())

async function reload() {
  status.value = 'loading'
  errorText.value = ''
  try {
    const res = await fetch('/api/workbench/projects/recommended', { cache: 'no-store' })
      .then(r => r.json())
      .catch(() => null)
    if (!res?.success) {
      status.value = 'error'
      errorText.value = res?.error || $t('@PROJM:读取推荐列表失败')
      return
    }
    items.value = Array.isArray(res.recommendations) ? res.recommendations : []
    status.value = items.value.length ? 'done' : 'empty'
  } catch (err: any) {
    status.value = 'error'
    errorText.value = err?.message || $t('@PROJM:读取推荐列表失败')
  }
}

async function add(item: RecommendedProject) {
  addingPath.value = item.path
  try {
    const r = await props.onAdd(item.path)
    if (!r.ok) return
    const next = new Set(addedPaths.value)
    next.add(item.path)
    addedPaths.value = next
  } finally {
    addingPath.value = ''
  }
}

onMounted(reload)
defineExpose({ reload })
</script>

<template>
  <section class="pm-rec">
    <header class="pm-rec__head">
      <h3 class="pm-rec__title">{{ $t('@PROJM:推荐添加') }}</h3>
      <span v-if="status === 'done'" class="pm-rec__count">{{ items.length }}</span>
      <IconButton
        size="small"
        :disabled="status === 'loading'"
        :tooltip="$t('@PROJM:重新扫描')"
        @click="reload"
      >
        <el-icon :class="{ 'is-rotating': status === 'loading' }"><Refresh /></el-icon>
      </IconButton>
    </header>
    <p class="pm-rec__hint">{{ $t('@PROJM:扫描已有项目所在的目录，列出还没加进来、且含 .git 的仓库') }}</p>

    <div v-if="status === 'loading' && items.length === 0" class="pm-rec__state">
      <p class="pm-rec__state-text">{{ $t('@PROJM:正在扫描…') }}</p>
    </div>

    <div v-else-if="status === 'error'" class="pm-rec__state pm-rec__state--error">
      <p class="pm-rec__state-text">{{ errorText }}</p>
    </div>

    <div v-else-if="status === 'empty'" class="pm-rec__state">
      <p class="pm-rec__state-text">{{ $t('@PROJM:没有发现可以添加的仓库，可以直接用「添加项目」指定路径') }}</p>
    </div>

    <ul v-else-if="items.length" class="pm-rec__items">
      <li v-for="item in items" :key="item.path" class="pm-rec__item">
        <div class="pm-rec__info">
          <span class="pm-rec__name">{{ item.name }}</span>
          <span class="pm-rec__path" :title="item.path">{{ item.path }}</span>
        </div>
        <span v-if="addedPaths.has(item.path)" class="pm-rec__added">{{ $t('@PROJM:已添加') }}</span>
        <button
          v-else
          type="button"
          class="pm-rec__add"
          :disabled="addingPath === item.path"
          :aria-label="`${$t('@PROJM:添加')} ${item.name}`"
          @click="add(item)"
        >
          {{ addingPath === item.path ? $t('@PROJM:添加中…') : $t('@PROJM:添加') }}
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* 这一区现在是**项目列表上面**的一条带子（用户要求把扫描添加挪上来）：不画边框、
   不套卡片，只用一层极淡的底色把它与下面的列表分开 —— 底+字同向翻转，深色下同样成立。 */
.pm-rec {
  flex-shrink: 0;
  margin-bottom: 6px;
  padding: 8px 10px 6px;
  background: var(--bg-subtle);
}
.pm-rec__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-rec__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.pm-rec__count {
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.pm-rec__hint {
  margin: 2px 0 4px;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  color: var(--text-meta);
}
.pm-rec__state {
  padding: 8px;
  text-align: center;
}
.pm-rec__state--error .pm-rec__state-text { color: var(--color-danger-dark); }
.pm-rec__state-text {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--text-meta);
  word-break: break-word;
}

.pm-rec__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;              /* 横向平铺：宽屏一屏看全，不竖着排一长条 */
  max-height: 132px;        /* 最多三行左右，别把下面的项目列表挤下去 */
  overflow-y: auto;
}
.pm-rec__item {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  padding: 3px 6px 3px 8px;
  border-radius: var(--radius-md);   /* 只在 hover 底色上看得见 */
  transition: background var(--transition-fast) var(--ease-custom);
}
.pm-rec__item:hover { background: var(--bg-container-hover); }
.pm-rec__info {
  flex: 0 1 auto;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.pm-rec__name {
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  white-space: nowrap;
}
.pm-rec__path {
  min-width: 0;
  max-width: 320px;
  font-size: var(--font-size-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--text-meta);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 「添加」是文字按钮：原来那种"圆角 + 单层 border"的小方块是用户点名不要的样式；
   现在静息只有主色文字，hover 才浮出一层淡底。 */
.pm-rec__add {
  flex-shrink: 0;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-primary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    background var(--transition-fast) var(--ease-custom),
    color var(--transition-fast) var(--ease-custom);
}
.pm-rec__add:hover:not(:disabled) { background: var(--tint-primary-12); }
.pm-rec__add:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.pm-rec__add:disabled { cursor: default; opacity: 0.6; }
.pm-rec__added {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-success);
}
.is-rotating { animation: pm-rec-rotating 1s linear infinite; }
@keyframes pm-rec-rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .is-rotating { animation: none; }
}
</style>
