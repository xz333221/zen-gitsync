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
  「项目管理」视图里的一行：项目本体 + 启动方式 + 打开方式 + 删除。

  和工作台左栏那一行的分工（两处形态相似但语义不同，刻意不合并）：
    · 工作台的行：点一下 = 把这行当看板过滤器（选中态），打开方式收在 hover 才出现的「…」里；
    · 这一行：点一下 = 展开这块的「启动方式」（AI 启动建议），打开方式与删除都常驻可见。
  所以这里的删除**对任何项目都开着**（不只是目录已不存在的那些）：这个视图的语义就是
  "管理清单"，活项目的"从清单移除"同样正当（任务不删、目录还在、随时能加回来）。
  工作台那边只在 exists === false 时给删除，是因为它的用途是清理死条目 —— 两处不一样是
  有意为之，别为了"对齐"把这条改掉。

  「启动方式」直接复用 ProjectStartupAiPanel（同一个面板、同一份 i18n），挂在
  `v-if="expanded"` 后面 —— 展开才挂载 = 展开才发请求（十几个项目不可能一起分析）。
  服务端会按项目清单白名单校验传过去的路径（见 routes/projectStartupAi.js）。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { Delete, Folder, MoreFilled } from '@element-plus/icons-vue'
import SvgIcon from '@components/SvgIcon/index.vue'
import ProjectOpenMenuList from '@components/ProjectOpenMenuList.vue'
import ProjectStartupAiPanel from '@components/ProjectStartupAiPanel.vue'
import { useIconFallback } from '@/composables/useIconFallback'
import { $t } from '@/lang/static'
import { relativeTimeFromIso } from '@/utils/relativeTime'
import type { ProjectSummary } from '@/types/workbench'

const props = defineProps<{
  project: ProjectSummary
  /** 正在删除这一行（按钮转圈 + 防重复点） */
  removing?: boolean
}>()

const emit = defineEmits<{
  remove: [project: ProjectSummary]
}>()

/** 目录在不在，决定"能不能打开 / 能不能分析启动方式" */
const canOpen = computed(() => props.project.exists !== false)

const { isIconBroken, markIconFailed } = useIconFallback()

/** 「启动方式」展开态：展开才挂 ProjectStartupAiPanel（= 展开才请求模型） */
const expanded = ref(false)
function toggleExpanded() {
  if (!canOpen.value) return
  expanded.value = !expanded.value
}

// ── 打开方式菜单 ──────────────────────────────────────────────────────
// 每行自己持有一份状态，但**只在自己打开时才挂 document 监听**：
// 33 行各注册一个常驻监听纯属浪费（工作台那边把状态提到面板级就是为了这个，
// 但它一行只有一个 popover，这里自管更好读）。关闭判据与工作台同口径：
// 触发按钮不算"外面"，popper 里的点击也不算。
const menuOpen = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const popoverWrap = ref<HTMLElement | null>(null)

function toggleMenu(e: MouseEvent) {
  if (menuOpen.value) {
    menuOpen.value = false
    return
  }
  triggerEl.value = (e.currentTarget as HTMLElement) || null
  menuOpen.value = true
}

function onDocumentMouseDown(e: MouseEvent) {
  const target = e.target as Node | null
  if (!target) return
  if (triggerEl.value?.contains(target)) return
  for (const el of Array.from(document.querySelectorAll('.pm-open-menu'))) {
    if (el.contains(target)) return
  }
  menuOpen.value = false
}

watch(menuOpen, (open) => {
  if (open) document.addEventListener('mousedown', onDocumentMouseDown, true)
  else document.removeEventListener('mousedown', onDocumentMouseDown, true)
})
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMouseDown, true))

/**
 * 分支文案。**空串 = 不显示**（与工作台同一口径）：不是 Git 仓库时不留文字，
 * 那一格空着本身就是"这儿没有分支"的信号。
 */
function gitLine(p: ProjectSummary): string {
  if (!p.git) return ''
  if (p.git.isGitRepo === null) return $t('@WORKBENCH:未知')
  if (!p.git.isGitRepo) return ''
  if (p.git.detached) return $t('@WORKBENCH:游离 HEAD')
  return p.git.branch || $t('@WORKBENCH:未知')
}

function hasBranchIcon(p: ProjectSummary): boolean {
  return !!(p.git && p.git.isGitRepo && (p.git.detached || p.git.branch))
}

/**
 * 「从清单移除」的确认框：文案与工作台逐字共用（含"任务不会被删除"那句）。
 * 有任务 / 没任务分两句 —— 统一一句"你的 N 条任务还在"在 N=0 时读起来像出了 bug。
 */
async function confirmRemove() {
  const p = props.project
  const name = p.name || p.path
  const msg = p.stats.total > 0
    ? $t('@WORKBENCH:移除项目「{name}」？会从常用目录和项目列表中去掉它。该项目的 {n} 条任务不会被删除，仍可在「全部项目」下查看。', { name, n: p.stats.total })
    : $t('@WORKBENCH:移除项目「{name}」？会从常用目录和项目列表中去掉它。', { name })
  try {
    await ElMessageBox.confirm(msg, $t('@WORKBENCH:移除项目'), {
      confirmButtonText: $t('@WORKBENCH:移除'),
      cancelButtonText: $t('@WORKBENCH:取消'),
      type: 'warning',
    })
  } catch {
    return
  }
  emit('remove', p)
}
</script>

<template>
  <li
    class="pm-item"
    :class="{ 'is-missing': project.exists === false, 'is-open': expanded, 'is-current': project.isCurrent }"
  >
    <!-- 行头：点一下展开/收起「启动方式」。role=button + tabindex 让它可键盘操作。
         ⚠️ 行上的 keydown 必须带 .self：事件从按钮冒泡上来时不带 .self 会
         既展开又 preventDefault 掉按钮自己的激活（工作台那次踩过，见那里的注释）。 -->
    <div
      class="pm-item__head"
      role="button"
      tabindex="0"
      :aria-expanded="expanded"
      :title="project.path"
      @click="toggleExpanded"
      @keydown.enter.self.prevent="toggleExpanded"
      @keydown.space.self.prevent="toggleExpanded"
    >
      <span class="pm-item__icon-slot">
        <img
          v-if="project.iconUrl && !isIconBroken(project.iconUrl)"
          class="pm-item__icon pm-item__icon--img"
          :src="project.iconUrl"
          alt=""
          @error="markIconFailed(project.iconUrl)"
        />
        <el-icon v-else class="pm-item__icon"><Folder /></el-icon>
      </span>

      <div class="pm-item__meta">
        <div class="pm-item__row1">
          <span class="pm-item__name">{{ project.name }}</span>
          <span v-if="project.stats.runningJobs > 0" class="pm-item__running" aria-hidden="true" />
          <span v-if="project.isCurrent" class="pm-chip pm-chip--current">{{ $t('@WORKBENCH:当前') }}</span>
        </div>

        <div class="pm-item__row2">
          <template v-if="project.exists === false">
            <span class="pm-chip pm-chip--missing">{{ $t('@WORKBENCH:目录不存在') }}</span>
          </template>
          <template v-else>
            <span v-if="gitLine(project)" class="pm-item__branch">
              <svg-icon v-if="hasBranchIcon(project)" icon-class="git-branch" class-name="pm-item__branch-icon" />
              <span class="pm-item__branch-name">{{ gitLine(project) }}</span>
            </span>
            <span v-if="project.git && project.git.ahead > 0" class="pm-chip pm-chip--ahead">↑{{ project.git.ahead }}</span>
            <span v-if="project.git && project.git.behind > 0" class="pm-chip pm-chip--behind">↓{{ project.git.behind }}</span>
            <span v-if="project.git && project.git.changed > 0" class="pm-chip pm-chip--dirty">●{{ project.git.changed }}</span>
            <span v-if="project.stats.total > 0" class="pm-item__progress">
              {{ $t('@WORKBENCH:{done}/{total} 任务完成', { done: project.stats.done, total: project.stats.total }) }}
            </span>
            <span class="pm-item__time">{{ relativeTimeFromIso(project.stats.lastActiveAt) }}</span>
          </template>
        </div>

        <!-- 完整路径：管理工作最需要的辨认线索（同名项目 / 同一仓库的多个克隆） -->
        <div class="pm-item__path">{{ project.path }}</div>
      </div>

      <!-- 操作区常驻（不像工作台那样 hover 才出现）：「管理」语义下这些就是主操作 -->
      <div class="pm-item__actions">
        <button
          v-if="canOpen"
          type="button"
          class="pm-item__action"
          :class="{ 'is-on': expanded }"
          :title="expanded ? $t('@PROJM:收起启动方式') : $t('@PROJM:展开启动方式')"
          :aria-label="`${expanded ? $t('@PROJM:收起启动方式') : $t('@PROJM:展开启动方式')} ${project.name}`"
          :aria-expanded="expanded"
          @click.stop="toggleExpanded"
        >
          <svg viewBox="0 0 1024 1024" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M64 192h896v192L512 702 64 384z" />
          </svg>
        </button>

        <el-popover
          v-if="canOpen"
          :visible="menuOpen"
          :trigger="('manual' as any)"
          placement="bottom-end"
          :width="272"
          :show-arrow="false"
          :offset="6"
          :teleported="true"
          popper-class="pm-open-menu"
        >
          <template #reference>
            <button
              ref="popoverWrap"
              type="button"
              class="pm-item__action"
              :class="{ 'is-on': menuOpen }"
              :title="$t('@WORKBENCH:打开方式')"
              :aria-label="`${$t('@WORKBENCH:打开方式')} ${project.name}`"
              :aria-expanded="menuOpen"
              aria-haspopup="menu"
              @click.stop="toggleMenu"
            >
              <el-icon aria-hidden="true"><MoreFilled /></el-icon>
            </button>
          </template>
          <ProjectOpenMenuList
            v-if="menuOpen"
            :path="project.path"
            :name="project.name"
            @done="menuOpen = false"
          />
        </el-popover>

        <button
          type="button"
          class="pm-item__action pm-item__action--danger"
          :disabled="removing"
          :title="$t('@WORKBENCH:从清单移除')"
          :aria-label="`${$t('@WORKBENCH:从清单移除')} ${project.name}`"
          @click.stop="confirmRemove"
        >
          <el-icon aria-hidden="true" :class="{ 'is-rotating': removing }"><Delete /></el-icon>
        </button>
      </div>
    </div>

    <!-- 启动方式（AI 启动建议）：展开才挂载 = 展开才请求 -->
    <div v-if="expanded && canOpen" class="pm-item__startup">
      <ProjectStartupAiPanel :project-path="project.path" />
    </div>
  </li>
</template>

<style scoped>
.pm-item {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  overflow: hidden;
  transition: border-color var(--transition-fast) var(--ease-custom);
}
.pm-item:hover { border-color: var(--border-card-hover); }
.pm-item.is-open { border-color: var(--tint-primary-30); }
.pm-item.is-missing { border-color: color-mix(in srgb, var(--color-danger) 30%, transparent); }
.pm-item.is-current { box-shadow: inset 3px 0 0 var(--color-primary); }

.pm-item__head {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  column-gap: 10px;
  align-items: center;
  padding: 10px 12px;
  cursor: pointer;
  outline: none;
}
.pm-item__head:hover { background: var(--bg-container-hover); }
.pm-item__head:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }

.pm-item__icon-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
}
.pm-item__icon { font-size: var(--font-size-xl); color: var(--text-meta); }
.pm-item__icon--img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}

.pm-item__meta { min-width: 0; }
.pm-item__row1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.pm-item__name {
  font-size: var(--font-size-mid);
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm-item__running {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
  box-shadow: var(--dot-glow-warning);
}
.pm-item__row2 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}
.pm-item__branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 180px;
  font-family: var(--font-mono, ui-monospace, monospace);
}
.pm-item__branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* color 这条不能省：SvgIcon 自己声明了 .svg-icon{color:--text-secondary}，
   不覆盖的话图标比分支名亮一档（工作台那处同一坑）。 */
.pm-item__branch :deep(.pm-item__branch-icon) {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  color: currentColor;
}
.pm-item__progress { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.pm-item__time { margin-left: auto; flex-shrink: 0; font-variant-numeric: tabular-nums; }

/* 完整路径：等宽字体 + 省略号（全文在行 title 与这里自己的 title 里） */
.pm-item__path {
  margin-top: 3px;
  font-size: var(--font-size-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;   /* 长路径截前面、留结尾（目录名 + 最后两级最有用） */
  text-align: left;
}

.pm-item__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.pm-item__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-meta);
  font-size: var(--font-size-mid);
  cursor: pointer;
  transition:
    color var(--transition-fast) var(--ease-custom),
    background var(--transition-fast) var(--ease-custom);
}
.pm-item__action:hover { color: var(--color-primary); background: var(--tint-primary-12); }
.pm-item__action:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.pm-item__action.is-on { color: var(--color-primary); background: var(--tint-primary-12); }
.pm-item__action--danger { color: var(--color-danger-dark); }
.pm-item__action--danger:hover {
  color: var(--color-danger-dark);
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
}
.pm-item__action:disabled { cursor: default; opacity: 0.55; }
.is-rotating { animation: rotating 1s linear infinite; }
@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 启动方式：复用 ProjectStartupAiPanel，但它是"面板"形态（自带外边距/阴影/折叠头）——
   嵌在行里时去掉外边距与阴影，让它看起来是这一行的下半段。 */
.pm-item__startup {
  padding: 0 12px 12px;
}
.pm-item__startup :deep(.startup-ai-panel) {
  margin-top: 0;
  box-shadow: none;
  border: 1px solid var(--border-card);
  border-radius: var(--radius-md);
}

/* 运行中呼吸点：与工作台同一条动画 */
@keyframes pm-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.3); }
}
.pm-item__running { animation: pm-pulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .pm-item__running,
  .is-rotating { animation: none; }
}
</style>
