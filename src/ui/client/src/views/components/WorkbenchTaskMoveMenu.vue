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
  看板「待处理」卡片的右键菜单：移动到其他项目。

  为什么菜单挂在组件库里、只此一份：菜单跟着**右键的那张卡**走，但 DOM 里只有
  一个实例（teleport 到 body、position:fixed）。33 张卡各挂一份弹窗是踩过的坑
  （list-row-dialog-instances）—— 这里连 v-for 里的痕迹都没有。

  形态抄的是本仓库既有的右键菜单语言（EditorView / MindmapView 的 .ctx-menu）：
  容器底 + 1px 边 + 悬浮阴影的浮层，平铺项 + hover 底色。它是浮层不是列表卡，
  所以不走"去卡片化"那套（那条针对的是铺满一屏的列表行）。

  边界处理（都在 openContextMenu 的同类里验证过）：
    · 贴边时翻转：菜单渲染后量一次自身宽高，把坐标夹回视口；
    · 点别处 / 滚动 / Esc 关闭：pointerdown 用捕获阶段且放行菜单内部的点击
      （否则点项目那一秒先被"关闭"吃掉，移动就发不出去）。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { $t } from '@/lang/static'
import type { BoardTask, ProjectSummary } from '@/types/workbench'
import { canonicalProjectPath } from '@/utils/path'

const props = defineProps<{
  visible: boolean
  /** 右键时的 clientX/clientY（视口坐标） */
  x: number
  y: number
  /** 被右键的那张卡；null 时不渲染 */
  task: BoardTask | null
  /** 全量项目清单（左栏同源：最近目录 ∪ 任务里出现过的 projectPath） */
  projects: ProjectSummary[]
}>()

const emit = defineEmits<{
  /** 选中了目标项目，回传该项目的原始路径（落库用原串，比较才归一） */
  move: [targetPath: string]
  close: []
}>()

/**
 * 候选目标：除任务当前所属项目外的全部项目。
 * 按 canonicalProjectPath 比较 —— 大小写 / 斜杠写法不同也是同一个项目，
 * 直接用原串比会把"当前项目"也列出来（点了什么都不会发生）。
 */
const options = computed(() => {
  const current = canonicalProjectPath(props.task?.projectPath)
  return props.projects.filter(p => canonicalProjectPath(p.path) !== current)
})

const menuRef = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })

/** 渲染后量一次自身尺寸，把坐标夹回视口（贴屏幕右下角时不然会溢出） */
watch(() => props.visible, async (v) => {
  if (!v) return
  await nextTick()
  const el = menuRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const pad = 8
  pos.value = {
    x: Math.min(Math.max(pad, props.x), Math.max(pad, window.innerWidth - rect.width - pad)),
    y: Math.min(Math.max(pad, props.y), Math.max(pad, window.innerHeight - rect.height - pad)),
  }
})

function onPointerDown(e: PointerEvent) {
  // 菜单内部的点击放行 —— 关菜单发生在选中之后（见 onPick），不能在这里拦掉
  const el = menuRef.value
  if (el && e.target instanceof Node && el.contains(e.target)) return
  emit('close')
}
function onScroll() {
  emit('close')
}
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  emit('close')
}
watch(() => props.visible, (v) => {
  if (!v) return
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('keydown', onKeydown, true)
}, { immediate: true })
watch(() => props.visible, (v) => {
  if (v) return
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('keydown', onKeydown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('keydown', onKeydown, true)
})

function onPick(p: ProjectSummary) {
  emit('move', p.path)
}
</script>

<template>
  <teleport to="body">
    <div
      v-if="visible && task"
      ref="menuRef"
      class="kb-move-menu"
      role="menu"
      :style="{ top: pos.y + 'px', left: pos.x + 'px' }"
      @contextmenu.prevent
    >
      <p class="kb-move-menu__head">{{ $t('@WORKBENCH:移动到其他项目') }}</p>
      <div class="kb-move-menu__list">
        <button
          v-for="p in options"
          :key="p.key"
          type="button"
          class="kb-move-menu__item"
          role="menuitem"
          :title="p.path"
          @click="onPick(p)"
        >
          <span class="kb-move-menu__name">{{ p.name }}</span>
          <span v-if="p.exists === false" class="kb-move-menu__warn">
            {{ $t('@WORKBENCH:目录不存在') }}
          </span>
        </button>
        <p v-if="options.length === 0" class="kb-move-menu__empty">
          {{ $t('@WORKBENCH:没有其他项目') }}
        </p>
      </div>
    </div>
  </teleport>
</template>

<style scoped lang="scss">
.kb-move-menu {
  position: fixed;
  z-index: var(--z-menu-float);
  /* 使用容器背景而非面板背景：深色主题下 --bg-panel 是半透明 rgba，
     菜单会"通透"，文字与底层内容重叠看不清（同 .ctx-menu 的教训）。 */
  background: var(--bg-container);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 4px;
  min-width: 200px;
  max-width: 320px;
  user-select: none;

  &__head {
    margin: 0;
    padding: 6px 10px 4px;
    font-size: var(--font-size-mid);
    color: var(--text-tertiary);
  }

  /* 项目多的时候（本机 38 个）菜单不能高过屏幕：列表自己滚，标题不动 */
  &__list {
    max-height: min(50vh, 400px);
    overflow-y: auto;
  }

  &__item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: none;
    border: none;
    border-radius: var(--radius-base);
    cursor: pointer;
    font-size: var(--font-size-mid);
    color: var(--text-primary);
    text-align: left;
    transition: background var(--transition-fast);

    &:hover {
      background: var(--bg-hover);
    }
  }

  &__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__warn {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--color-warning);
  }

  &__empty {
    margin: 0;
    padding: 6px 10px;
    font-size: var(--font-size-mid);
    color: var(--text-tertiary);
  }
}
</style>
