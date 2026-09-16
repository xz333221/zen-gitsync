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
// 最近项目 / 常用目录的统一列表组件(同一份数据源 + 同一套卡片外观)。
//
// 两个调用方,差异只有两点,全部由 props 表达:
//   1. 点击语义  mode='open'(App.vue 非 Git 仓库空态)   → 点击即在新的 cmd 标签页打开该目录
//               mode='pick'(切换工作目录弹窗的常用目录) → 点击把路径回填到输入框,
//                                                       Ctrl/Cmd + 点击才在新标签页打开
//   2. 外壳形态  variant='panel' → 自带标题行 + 搜索框 + 卡片容器,撑满父级高度(右侧整列空态)
//               variant='bare'  → 无外壳直接铺在弹窗表单里,列表自身限高滚动
//
// 拉取 / 搜索 / 加载态 / 空态 / 复制路径 / 移除 都收在这里,调用方不再各写一份。
// 数据源:GET /api/recent_directories(只读) + POST /api/remove_recent_directory(移除)
//
// i18n 复用 @13D1C 命名空间:该分组原本就是 GitStatus.vue 定义、被目录相关组件沿用的
// 目录家族文案(原 RecentProjectsList.vue 同样复用),不为此新建命名空间。
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { Delete, DocumentCopy, Folder, Loading, Search } from "@element-plus/icons-vue";
import { $t } from "@/lang/static";
import { getFolderNameFromPath } from "@/utils/path";

const props = withDefaults(defineProps<{
  /** open:点击即新标签页打开 | pick:点击上抛 select 事件,由父组件决定(弹窗里是回填输入框) */
  mode?: "open" | "pick";
  /** panel:带外框/标题/搜索的空态面板 | bare:裸列表,用于弹窗内嵌 */
  variant?: "panel" | "bare";
  /** missing:只允许移除已失效目录(避免误删还能打开的有效项目) | always:任意条目都可移除 */
  removable?: "missing" | "always";
  /** 挂载时自动拉取;弹窗场景传 false,由父组件在打开时调 reload() */
  autoLoad?: boolean;
  /** 卡片网格每列最小宽度,窄容器下自动降为单列 */
  minCardWidth?: string;
  /** 移除按钮的提示文案(两处语境不同,由调用方传) */
  removeLabel?: string;
  /** 空态文案 */
  emptyText?: string;
  /** 列表的无障碍标签 */
  ariaLabel?: string;
}>(), {
  mode: "open",
  variant: "panel",
  removable: "missing",
  autoLoad: true,
  minCardWidth: "380px",
});

const emit = defineEmits<{ select: [path: string] }>();

const directories = ref<Array<{ path: string; exists: boolean }>>([]);
const isLoading = ref(false);
// 搜索关键词:只在 panel 形态渲染输入框,bare 形态下始终为空
const searchQuery = ref("");

// 平台差异只影响"Ctrl + 点击"的提示文案(⌘ / Ctrl)
const isMac = computed(() => {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as any).userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /mac/i.test(navigator.platform || "");
});

const ctrlHint = computed(() =>
  isMac.value
    ? $t("@13D1C:按住 ⌘ 点击用新标签打开")
    : $t("@13D1C:按住 Ctrl 点击用新标签打开")
);

const removeLabelText = computed(() => props.removeLabel ?? $t("@13D1C:从最近项目中移除"));
const resolvedEmptyText = computed(() => props.emptyText ?? $t("@13D1C:暂无最近项目"));
const resolvedAriaLabel = computed(() => props.ariaLabel ?? $t("@13D1C:最近项目列表"));

// 列表项:补一个 basename 做第一行,完整路径放第二行(同名目录靠完整路径区分)
const items = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const list = q
    ? directories.value.filter(item => item.path.toLowerCase().includes(q))
    : directories.value;
  return list.map(item => ({ ...item, base: getFolderNameFromPath(item.path) }));
});

// 整张卡片的悬浮提示:pick 形态下把"Ctrl+点击"的用法讲在这里
function itemTitle(item: { path: string; exists: boolean }) {
  if (props.mode === "pick") return `${ctrlHint.value}\n${item.path}`;
  return item.exists ? item.path : $t("@13D1C:目录不存在");
}

function itemAriaLabel(item: { path: string; exists: boolean }) {
  if (!item.exists) return $t("@13D1C:{path} (目录不存在)", { path: item.path });
  return props.mode === "pick"
    ? $t("@13D1C:选择 {path}", { path: item.path })
    : $t("@13D1C:在新标签页打开 {path}", { path: item.path });
}

/** 移除按钮是否渲染:always 形态下任意条目都能清理 */
function canRemove(item: { exists: boolean }) {
  return props.removable === "always" || !item.exists;
}

async function load() {
  isLoading.value = true;
  try {
    const res = await fetch("/api/recent_directories", { cache: "no-store" });
    const data = await res.json();
    directories.value = Array.isArray(data?.directories) ? data.directories : [];
  } catch {
    directories.value = [];
  } finally {
    isLoading.value = false;
  }
}

async function openInNewTab(dirPath: string) {
  if (!dirPath) return;
  try {
    const res = await fetch("/api/open-new-tab-gui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (!data?.success) {
      ElMessage.error(data?.error || $t("@13D1C:打开失败"));
    }
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:打开失败")}: ${(err as Error).message}`);
  }
}

// 卡片点击:open 形态直接开新标签页;pick 形态普通点击回抛给父组件,Ctrl/Cmd 点击仍开新标签页
function onItemClick(item: { path: string; exists: boolean }, event: MouseEvent) {
  const wantNewTab = props.mode === "open" || event.ctrlKey || event.metaKey;
  if (!wantNewTab) {
    emit("select", item.path);
    return;
  }
  if (!item.exists) {
    ElMessage.warning($t("@13D1C:目录不存在,无法打开"));
    return;
  }
  openInNewTab(item.path);
}

// 复制路径到剪贴板。失败降级提示,避免"静默成功"的假象。
async function copyPath(dirPath: string) {
  if (!dirPath) return;
  try {
    await navigator.clipboard.writeText(dirPath);
    ElMessage.success($t("@13D1C:路径已复制到剪贴板"));
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:复制失败")}: ${(err as Error).message}`);
  }
}

// 从列表中移除:两处统一为"确认后移除",确认文案用通用措辞,
// 避免最近项目/常用目录各自一套(具体含义由 removeLabel 提示)。
async function removeDirectory(dirPath: string) {
  if (!dirPath) return;
  try {
    await ElMessageBox.confirm(
      $t("@13D1C:确定要移除以下目录吗？", { path: dirPath }),
      $t("@13D1C:移除目录"),
      {
        confirmButtonText: $t("@13D1C:移除"),
        cancelButtonText: $t("@13D1C:取消"),
        type: "warning",
      }
    );
  } catch {
    return; // 用户取消
  }
  try {
    const res = await fetch("/api/remove_recent_directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath }),
    });
    const data = await res.json();
    if (data?.success) {
      directories.value = directories.value.filter(d => d.path !== dirPath);
      ElMessage.success($t("@13D1C:已从目录列表中移除"));
    } else {
      ElMessage.error(data?.error || $t("@13D1C:移除失败"));
    }
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:移除失败")}: ${(err as Error).message}`);
  }
}

onMounted(() => {
  if (props.autoLoad) load();
});

// 弹窗在每次打开时都需要最新数据(用户可能刚在别处切过目录)
defineExpose({ reload: load });
</script>

<template>
  <div class="dir-list" :class="`dir-list--${variant}`">
    <!-- 外壳:仅 panel 形态自带标题行 + 搜索框;bare 形态由调用方(弹窗表单 label)提供标题 -->
    <template v-if="variant === 'panel'">
      <div class="dir-list__head">
        <span class="dir-list__title">{{ $t('@13D1C:最近项目') }}</span>
        <span class="dir-list__hint">{{ $t('@13D1C:点击在新标签页打开') }}</span>
      </div>
      <div class="dir-list__search">
        <el-icon class="dir-list__search-icon" aria-hidden="true"><Search /></el-icon>
        <input
          v-model="searchQuery"
          type="text"
          class="dir-list__search-input"
          :placeholder="$t('@13D1C:搜索最近项目...')"
          :aria-label="$t('@13D1C:搜索最近项目')"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="dir-list__search-clear"
          :aria-label="$t('@13D1C:清空搜索')"
          @click="searchQuery = ''"
        >×</button>
      </div>
    </template>

    <div v-if="isLoading && directories.length === 0" class="dir-list__empty">
      <el-icon><Loading /></el-icon>
      <span>{{ $t('@13D1C:加载中...') }}</span>
    </div>
    <div v-else-if="directories.length === 0" class="dir-list__empty">
      {{ resolvedEmptyText }}
    </div>
    <div v-else-if="items.length === 0" class="dir-list__empty">
      {{ $t('@13D1C:没有匹配 "{q}" 的项目', { q: searchQuery }) }}
    </div>
    <ul
      v-else
      class="dir-list__items"
      :aria-label="resolvedAriaLabel"
      :style="{ '--dir-card-min': minCardWidth }"
    >
      <li
        v-for="item in items"
        :key="item.path"
        class="dir-card"
        :class="{ 'is-missing': !item.exists }"
        :title="itemTitle(item)"
      >
        <button
          type="button"
          class="dir-card__btn"
          :aria-label="itemAriaLabel(item)"
          @click="onItemClick(item, $event)"
        >
          <el-icon class="dir-card__icon" aria-hidden="true"><Folder /></el-icon>
          <span class="dir-card__name">
            <span class="dir-card__name-base">{{ item.base }}</span>
            <span class="dir-card__name-path">{{ item.path }}</span>
          </span>
          <span v-if="!item.exists" class="dir-card__tag">{{ $t('@13D1C:不存在') }}</span>
        </button>
        <!-- 操作按钮与卡片按钮平级(不能嵌套 button),.stop 阻止冒泡到卡片点击。
             默认透明,hover 卡片才显形,避免列表静止时被一堆小图标抢视觉重心。 -->
        <button
          type="button"
          class="dir-card__action dir-card__copy"
          :title="$t('@13D1C:复制路径')"
          :aria-label="$t('@13D1C:复制路径 {path}', { path: item.path })"
          @click.stop="copyPath(item.path)"
        >
          <el-icon aria-hidden="true"><DocumentCopy /></el-icon>
        </button>
        <!-- 失效目录的移除按钮常驻显形(方便一键清理),有效目录则 hover 才出现 -->
        <button
          v-if="canRemove(item)"
          type="button"
          class="dir-card__action dir-card__remove"
          :class="{ 'is-pinned': !item.exists }"
          :title="removeLabelText"
          :aria-label="`${removeLabelText} ${item.path}`"
          @click.stop="removeDirectory(item.path)"
        >
          <el-icon aria-hidden="true"><Delete /></el-icon>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* ── 外壳 ─────────────────────────────────────────────────────────── */
.dir-list {
  text-align: left;
}
/* panel:撑满父级(右侧整列空态),卡片化外壳 + 内部滚动 */
.dir-list--panel {
  margin-top: 0;
  /* min-height:0 让 flex 子项可被父级 grid-template-rows 高度约束,
     否则 height:100% + flex 链会被子项自然高度撑爆 */
  min-height: 0;
  height: 100%;
  padding: var(--spacing-xl);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  /* 不设 overflow:hidden,滚动交给 .dir-list__items */
}
/* bare:弹窗内嵌,无外框;列表限高自带滚动,避免弹窗被长列表撑高 */
.dir-list--bare {
  display: block;
}
.dir-list--bare .dir-list__items {
  flex: none;
  max-height: 42vh;
}
.dir-list__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--spacing-base);
}
.dir-list__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  letter-spacing: -0.2px;
  color: var(--text-primary);
}
.dir-list__hint {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 搜索框:panel 形态独占 */
.dir-list__search {
  position: relative;
  display: flex;
  align-items: center;
  margin-top: var(--spacing-sm);
  border: 1px solid var(--border-color-light);
  border-radius: 10px;
  background: var(--bg-panel);
  padding: 0 var(--spacing-md);
  height: 40px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.dir-list__search:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}
.dir-list__search-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  margin-right: var(--spacing-base);
}
.dir-list__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font: inherit;
  font-size: var(--font-size-base);
  color: var(--text-primary);
  padding: 0;
  height: 100%;
}
.dir-list__search-input::placeholder {
  color: var(--text-tertiary);
}
.dir-list__search-clear {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: var(--spacing-sm);
  border: none;
  background: var(--bg-component-hover);
  color: var(--text-secondary);
  border-radius: var(--radius-full);
  font-size: var(--font-size-md);
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.dir-list__search-clear:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.dir-list__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  color: var(--text-secondary);
  font-size: 13px;
}

/* ── 卡片网格 ─────────────────────────────────────────────────────── */
.dir-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--dir-card-min, 380px), 100%), 1fr));
  gap: var(--spacing-md);
  margin-top: var(--spacing-sm);
  /* panel 形态下占满父 flex 容器剩余空间,多出时内部滚动而不是撑爆外层 */
  align-content: start;
  /* 给卡片 focus-visible 的外描边留出空间,避免被自身 overflow 切掉 */
  padding: var(--spacing-xs);
  margin: calc(-1 * var(--spacing-xs));
}
.dir-list--panel .dir-list__items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.dir-list--bare .dir-list__items {
  overflow-y: auto;
}

.dir-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  font-size: var(--font-size-md);
  color: var(--text-primary);
  /* 不做 transform/阴影/位移动画:状态变化只用背景与描边表达 */
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.dir-card:hover {
  background: var(--bg-component-hover);
  border-color: var(--border-color);
}
.dir-card:active {
  background: var(--tint-primary-08);
}
.dir-card.is-missing {
  color: var(--text-secondary);
}
.dir-card.is-missing:hover {
  border-color: var(--tint-danger-50);
  background: var(--tint-danger-06);
}
.dir-card__btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.dir-card__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-base);
}
/* 图标做成 tinted 色块,与卡片层级匹配 */
.dir-card__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  font-size: 20px;
  border-radius: var(--radius-lg);
  background: var(--tint-primary-08);
  color: var(--color-primary);
}
/* 失效目录:图标色块退成中性灰,与"不存在"语义一致 */
.dir-card.is-missing .dir-card__icon {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}
.dir-card__name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.dir-card__name-base {
  font-family: ui-monospace, monospace;
  font-size: var(--font-size-15);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  letter-spacing: -0.1px;
}
.dir-card.is-missing .dir-card__name-base {
  color: var(--text-secondary);
}
.dir-card__name-path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  /* 弱化到项目名之后 */
  opacity: 0.85;
}
.dir-card__tag {
  flex-shrink: 0;
  padding: 1px var(--spacing-sm);
  font-size: var(--font-size-xs);
  border-radius: var(--radius-sm);
  background: var(--tint-danger-14);
  color: var(--color-danger-light);
}

/* ── 卡片上的操作按钮 ─────────────────────────────────────────────── */
.dir-card__action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  border-radius: var(--radius-base);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast), color var(--transition-fast);
}
.dir-card:hover .dir-card__action,
.dir-card__action:focus-visible {
  opacity: 1;
}
.dir-card__copy:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.dir-card.is-missing .dir-card__copy:hover {
  background: var(--bg-component-hover);
  color: var(--text-secondary);
}
/* 移除按钮:破坏性操作,常驻是 border + danger 配色,显式区分于复制 */
.dir-card__remove {
  border: 1px solid var(--tint-danger-50);
  background: var(--bg-panel);
  color: var(--color-danger-light);
}
.dir-card__remove.is-pinned {
  opacity: 1;
}
.dir-card__remove:hover {
  background: var(--tint-danger-14);
  border-color: var(--color-danger-light);
  color: var(--color-danger);
}
.dir-card__action:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.dir-card__remove:focus-visible {
  outline-color: var(--color-danger-light);
}
</style>
