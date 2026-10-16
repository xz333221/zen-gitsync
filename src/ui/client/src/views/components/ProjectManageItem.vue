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
  「项目管理」视图里的一张卡片：项目本体 + 启动方式 + 打开方式 + 删除。

  三处刻意的设计（2026-10-16 前后按用户反馈定型）：
    1. **不是卡片**：不画边框、不给常驻圆角，跟工作台左栏同一套语言 —— 平铺、hover/展开
       才出底色；"当前"项目靠一条 3px 主色竖条 + 淡渐变底表达。
    2. **卡片正面只留三颗管理按钮**（展开启动方式 / 打开方式 / 删除）。曾经在卡片上摆过
       一排「用 X 打开」工具图标，用户反馈"这些图标不用展示在卡片外边，现在太多了，看着
       好乱"（33 张卡 × 9 个图标 ≈ 一屏 300 个图标）—— 已全部收回「…」菜单（那 20 项一个
       不少，含各工具的权限档）。
    3. 信息分三行（名字 / 分支+进度 / 完整路径）：路径是这页最有用的辨认线索
       （同名项目、同一仓库的多个克隆），宁可占一行也不缩成省略号。

  与工作台那一行的分工（形态相似但语义不同，刻意不合并）：那边的行"点一下 = 选中当看板
  过滤器"，这边的卡片"点一下 = 展开启动方式"；这边的删除对**任何项目**都开着（管理语义），
  那边只在 exists === false 时给删。两处不一样是有意为之，别为了"对齐"改掉。
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
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
// 33 行各注册一个常驻监听纯属浪费。关闭判据与工作台同口径：
// 触发按钮不算"外面"，popper 里的点击也不算。
const menuOpen = ref(false)
const triggerEl = ref<HTMLElement | null>(null)

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
        <el-icon v-else class="pm-item__icon pm-item__icon--folder" aria-hidden="true">
          <!-- folder-filled.svg（Tabler icons，MIT）：回退"彩色片"—— 32px 淡主色底 +
               主色实心文件夹，与 favicon 同尺寸同存在感（2026-10-16 用户要求） -->
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 3a1 1 0 0 1 .608 .206l.1 .087l2.706 2.707h6.586a3 3 0 0 1 2.995 2.824l.005 .176v8a3 3 0 0 1 -2.824 2.995l-.176 .005h-14a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-11a3 3 0 0 1 2.824 -2.995l.176 -.005h4z" />
          </svg>
        </el-icon>
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
          </template>
        </div>

        <!-- 完整路径：管理工作最需要的辨认线索（同名项目 / 同一仓库的多个克隆） -->
        <div class="pm-item__path">{{ project.path }}</div>
      </div>

      <span class="pm-item__time">{{ relativeTimeFromIso(project.stats.lastActiveAt) }}</span>

      <!-- 操作区常驻（不像工作台那样 hover 才出现）：「管理」语义下这些就是主操作。
           2026-10-16 用户反馈：卡片正面不再摆那一排「用 X 打开」工具图标（33 张卡 × 9 个
           图标 = 一屏 300 个图标，太乱）。工具打开全部回到「…」菜单里（20 项一个不少）。 -->
      <div class="pm-item__actions">
        <button
          v-if="canOpen"
          type="button"
          class="pm-item__action pm-item__action--caret"
          :class="{ 'is-on': expanded }"
          :title="expanded ? $t('@PROJM:收起启动方式') : $t('@PROJM:展开启动方式')"
          :aria-label="`${expanded ? $t('@PROJM:收起启动方式') : $t('@PROJM:展开启动方式')} ${project.name}`"
          :aria-expanded="expanded"
          @click.stop="toggleExpanded"
        >
          <!-- chevron-down.svg（Tabler icons，MIT）：展开/收起启动方式。
               用户反馈实心三角夹在两根描边图标（dots / trash）中间太扎眼 → 改描边折角同笔触；
               展开态由 CSS 翻 180°（见 .pm-item__action--caret.is-on）。 -->
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 9l6 6l6-6" />
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
              type="button"
              class="pm-item__action"
              :class="{ 'is-on': menuOpen }"
              :title="$t('@WORKBENCH:打开方式')"
              :aria-label="`${$t('@WORKBENCH:打开方式')} ${project.name}`"
              :aria-expanded="menuOpen"
              aria-haspopup="menu"
              @click.stop="toggleMenu"
            >
              <el-icon aria-hidden="true">
                <!-- dots.svg（Tabler icons，MIT）：三点菜单（原 EP MoreFilled） -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0" />
                  <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0" />
                  <path d="M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0" />
                </svg>
              </el-icon>
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
          <el-icon aria-hidden="true" :class="{ 'is-rotating': removing }">
            <!-- trash.svg（Tabler icons，MIT）：从清单移除（原 EP Delete） -->
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 7l16 0" />
              <path d="M10 11l0 6" />
              <path d="M14 11l0 6" />
              <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12" />
              <path d="M9 7v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
            </svg>
          </el-icon>
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
/* ── 平铺卡片（跟工作台左栏 .proj-item 同一套语言：不画边框、只在有底色时才有圆角） ──
   用户明确不喜欢"圆角 + 单层 border"的卡片样子，也明确要求"一行里多放几张卡片"
   （见 ProjectManagePanel 的网格）。所以一张卡 = 一小块平铺内容：
   hover/选中才出底色，"当前"项目靠一条 3px 主色竖条 + 淡渐变底表达。 */
.pm-item {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 7px 8px 5px 12px;
  border-radius: var(--radius-md);
  transition: background var(--transition-fast) var(--ease-custom);
}
.pm-item:hover { background: var(--bg-container-hover); }
.pm-item.is-open { background: var(--bg-subtle); }
.pm-item.is-current {
  background: linear-gradient(90deg, var(--tint-primary-12), transparent 60%);
}
/* 竖条走 ::before 而不是 border-left：border 会挤进内容盒，把图标槽与项目名整体右移，
   有图标与没图标的卡片就对不齐（工作台那次为这条踩过坑）。 */
.pm-item.is-current::before {
  content: '';
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 3px;
  background: var(--color-primary);
  border-radius: 0 2px 2px 0;
}
.pm-item.is-missing .pm-item__name { color: var(--text-meta); }

.pm-item__head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  cursor: pointer;
  outline: none;
}
.pm-item__head:focus-visible { outline: var(--focus-outline); outline-offset: -2px; }

.pm-item__icon-slot {
  flex-shrink: 0;
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
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
}
/* 回退"彩色片"（2026-10-16 用户要求）：与工作台左栏同一套（那边圆角 radius-lg 配它的槽，
   这边跟自家 favicon 同档用 radius-md） */
.el-icon.pm-item__icon--folder {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-md);
  background: var(--tint-primary-08);
  color: var(--color-primary);
}

/* 身份块：吃掉卡片里除图标与时间之外的宽度 */
.pm-item__meta { flex: 1 1 auto; min-width: 0; }
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
  animation: pm-pulse 1.4s ease-in-out infinite;
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
  max-width: 160px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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

/* 完整路径：等宽 + 省略。direction:rtl 让省略发生在**前面**、保住目录名与最后两级
   （长路径里最有用的那一段）；行有 title 兜底全路径。 */
.pm-item__path {
  margin-top: 3px;
  font-size: var(--font-size-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

/* ── 操作区（卡片右侧常驻） ─────────────────────────────────────────── */
.pm-item__actions {
  flex-shrink: 0;
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

/* 展开/收起的 disclosure 箭头：展开时翻 180°。
   只挂 caret 按钮 ——「⋯」菜单也吃 is-on（menuOpen），不能对它按 is-on 全局旋转。 */
.pm-item__action--caret svg {
  transition: transform var(--transition-fast) var(--ease-custom);
}
.pm-item__action--caret.is-on svg {
  transform: rotate(180deg);
}
/* 危险动作（删除）静息是普通灰，hover 才转红：33 行各挂一枚常驻红图标太吵，
   而 hover 时的红已经足够说清"这一下是破坏性的"。 */
.pm-item__action--danger { color: var(--text-meta); }
.pm-item__action--danger:hover {
  color: var(--color-danger-dark);
  background: color-mix(in srgb, var(--color-danger) 14%, transparent);
}
.pm-item__action:disabled { cursor: default; opacity: 0.55; }

/* 时间：卡片右上角（与项目名同一行），不占第二行 */
.pm-item__time {
  flex-shrink: 0;
  margin-left: 4px;
  text-align: right;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}

/* 启动方式：复用 ProjectStartupAiPanel，但它是"面板"形态（自带外边距/阴影）——
   嵌在卡片里时去掉外边距与阴影，与上面的内容左对齐（41px = 图标槽 32 + gap 9）。 */
.pm-item__startup {
  padding: 2px 0 6px 41px;
}
.pm-item__startup :deep(.startup-ai-panel) {
  margin-top: 0;
  box-shadow: none;
  background: var(--bg-container);
}

@keyframes pm-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(1.3); }
}
.is-rotating { animation: rotating 1s linear infinite; }
@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .pm-item__running,
  .is-rotating { animation: none; }
  .pm-item__action--caret svg { transition: none; }
}
</style>
