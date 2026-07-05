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
// 非 Git 仓库空态下展示"最近项目"列表
// 数据源:复用 DirectorySelector 调用的 /api/recent_directories
// 交互:点击 → 在新标签页打开(POST /api/open-new-tab-gui)
import { ref, computed, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { Folder, Loading, Search } from "@element-plus/icons-vue";
import { $t } from "@/lang/static";

const { variant = 'inline' } = defineProps<{ variant?: 'inline' | 'fullpage' }>();

const recentDirectories = ref<Array<{ path: string; exists: boolean }>>([]);
const isLoadingRecent = ref(false);
// 搜索关键词:仅 fullpage 模式展示输入框,inline 模式走默认行为不渲染
const searchQuery = ref('');

// Path split: basename shows as project name; parent path shown smaller + muted.
// Handles both \ and / so Windows paths render correctly even when the OS
// normalizes to forward slashes (e.g. E:/workspace/...).
function splitPath(fullPath: string): { base: string; parent: string } {
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return { base: fullPath, parent: '' };
  return { base: parts[parts.length - 1], parent: parts.slice(0, -1).join('/') };
}


// 大小写不敏感子串匹配,匹配 path 任意位置
const filteredDirectories = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return recentDirectories.value;
  return recentDirectories.value.filter(item => item.path.toLowerCase().includes(q));
});

// Decorate items with displayBase so template renders the basename bold on line 1.
// Line 2 shows the full path verbatim (item.path) so each card is uniquely identifiable
// at a glance - parent-only was too ambiguous (e.g. multiple cards sharing c:/users).
const displayItems = computed(() => {
  return filteredDirectories.value.map(item => {
    const { base } = splitPath(item.path);
    return {
      ...item,
      displayBase: base,
    };
  });
});

async function loadRecentDirectories() {
  isLoadingRecent.value = true;
  try {
    const res = await fetch("/api/recent_directories", { cache: "no-store" });
    const data = await res.json();
    if (data && Array.isArray(data.directories)) {
      recentDirectories.value = data.directories;
    } else {
      recentDirectories.value = [];
    }
  } catch {
    recentDirectories.value = [];
  } finally {
    isLoadingRecent.value = false;
  }
}

async function openRecentDirInNewTab(dirPath: string) {
  if (!dirPath) return;
  try {
    const res = await fetch("/api/open-new-tab-gui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirPath })
    });
    const data = await res.json();
    if (!data?.success) {
      ElMessage.error(data?.error || $t("@13D1C:打开失败"));
    }
  } catch (err) {
    ElMessage.error(`${$t("@13D1C:打开失败")}: ${(err as Error).message}`);
  }
}

function onRecentDirClick(item: { path: string; exists: boolean }) {
  if (!item.exists) {
    ElMessage.warning($t("@13D1C:目录不存在,无法打开"));
    return;
  }
  openRecentDirInNewTab(item.path);
}

onMounted(() => {
  loadRecentDirectories();
});
</script>

<template>
  <div class="recent-projects" :class="{ 'recent-projects--fullpage': variant === 'fullpage' }">
    <div class="recent-projects__head">
      <span class="recent-projects__title">{{ $t('@13D1C:最近项目') }}</span>
      <span class="recent-projects__hint">{{ $t('@13D1C:点击在新标签页打开') }}</span>
    </div>
    <!-- 搜索框:仅 fullpage 模式(非 Git 仓库右侧整列)展示,inline 紧凑版不渲染避免占用空间 -->
    <div v-if="variant === 'fullpage'" class="recent-projects__search">
      <el-icon class="recent-projects__search-icon" aria-hidden="true"><Search /></el-icon>
      <input
        v-model="searchQuery"
        type="text"
        class="recent-projects__search-input"
        :placeholder="$t('@13D1C:搜索最近项目...')"
        :aria-label="$t('@13D1C:搜索最近项目')"
      />
      <button
        v-if="searchQuery"
        type="button"
        class="recent-projects__search-clear"
        :aria-label="$t('@13D1C:清空搜索')"
        @click="searchQuery = ''"
      >×</button>
    </div>
    <div v-if="isLoadingRecent && recentDirectories.length === 0" class="recent-projects__empty">
      <el-icon><Loading /></el-icon>
      <span>{{ $t('@13D1C:加载中...') }}</span>
    </div>
    <div v-else-if="recentDirectories.length === 0" class="recent-projects__empty">
      {{ $t('@13D1C:暂无最近项目') }}
    </div>
    <div v-else-if="filteredDirectories.length === 0" class="recent-projects__empty">
      {{ $t('@13D1C:没有匹配 "{q}" 的项目', { q: searchQuery }) }}
    </div>
    <ul v-else class="recent-projects__list" :aria-label="$t('@13D1C:最近项目列表')">
      <li
        v-for="item in displayItems"
        :key="item.path"
        class="recent-projects__item"
        :class="{ 'is-missing': !item.exists }"
      >
        <button
          type="button"
          class="recent-projects__btn"
          :title="item.exists ? item.path : $t('@13D1C:目录不存在')"
          :aria-label="item.exists
            ? $t('@13D1C:在新标签页打开 {path}', { path: item.path })
            : $t('@13D1C:{path} (目录不存在)', { path: item.path })"
          @click="onRecentDirClick(item)"
        >
          <el-icon class="recent-projects__icon" aria-hidden="true"><Folder /></el-icon>
          <span class="recent-projects__name" :title="item.path">
            <span class="recent-projects__name-base">{{ item.displayBase }}</span>
            <span class="recent-projects__name-parent">{{ item.path }}</span>
          </span>
          <span v-if="!item.exists" class="recent-projects__tag">{{ $t('@13D1C:不存在') }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.recent-projects {
  margin-top: var(--spacing-lg);
  /* 左右比标准 padding-md 略宽一点,避免长路径贴边;上下保持原节奏 */
  padding: var(--spacing-md) calc(var(--spacing-md) * 1.5);
  background: var(--bg-container, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: var(--radius-md);
  text-align: left;
}
/* 占满模式:由 App.vue 在非 Git 仓库时设置 variant="fullpage",
   字号 16px + 大圆角 + 卡片化布局 */
.recent-projects--fullpage {
  margin-top: 0;
  /* 关键:min-height: 0 让 flex 子项可被父级 grid-template-rows 高度约束,
     否则 height:100% + flex 链会被子项自然高度撑爆 */
  min-height: 0;
  height: 100%;
  padding: var(--spacing-xl) var(--spacing-xl);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  /* 不在这里设 overflow:hidden,留给 .recent-projects__list 自身做滚动。
     之前在这里 overflow:hidden 会让列表项 hover 时 transform: translateY(-1px)
     上移被切掉边框/阴影 */
}
.recent-projects__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--spacing-base);
}
.recent-projects__title {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}
.recent-projects__hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}
.recent-projects--fullpage .recent-projects__title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  letter-spacing: -0.2px;
}
.recent-projects--fullpage .recent-projects__hint {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 搜索框:fullpage 模式独占,inline 模式不渲染 */
.recent-projects__search {
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
.recent-projects__search:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring);
}
.recent-projects__search-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-md);
  margin-right: var(--spacing-base);
}
.recent-projects__search-input {
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
.recent-projects__search-input::placeholder {
  color: var(--text-tertiary);
}
.recent-projects__search-clear {
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
.recent-projects__search-clear:hover {
  background: var(--tint-primary-12);
  color: var(--color-primary);
}
.recent-projects__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  color: var(--text-secondary);
  font-size: 13px;
}
.recent-projects__list {
  list-style: none;
  margin: 0;
  padding: 0;
  /* 不限高度:列表项少时自然铺开,空出下方区域而非出现内部滚动条 */
}
.recent-projects--fullpage .recent-projects__list {
  display: grid;
  /* 卡片保持够宽(380px)避免路径频繁换行;窗口极窄时降为 1 列,
     路径单行省略号(末尾用 ... 截断,完整路径通过 :title 提示) */
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: var(--spacing-md);
  margin-top: var(--spacing-sm);
  /* 列表占满父 flex 容器剩余空间,多出时内部滚动而不是撑爆外层 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
  /* 给第一行 item hover 留出 translateY(-1px) + box-shadow 空间,
     否则上边框/阴影会被 list 自身的 overflow:auto 切掉 */
  padding: var(--spacing-xs);
  margin: calc(-1 * var(--spacing-xs));
}
.recent-projects__item {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--radius-base);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: background var(--transition-fast);
}
.recent-projects__item:hover {
  background: var(--tint-primary-12);
}
.recent-projects--fullpage .recent-projects__item {
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  font-size: var(--font-size-md);
  /* Drop transform + box-shadow: motion conveys state, not decoration. */
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.recent-projects--fullpage .recent-projects__item:hover {
  background: var(--bg-component-hover);
  border-color: var(--border-color);
}
.recent-projects--fullpage .recent-projects__item:active {
  background: var(--tint-primary-08);
}
/* fullpage 图标做成 tinted 色块容器,提升卡片视觉层级;
   inline 模式仍是裸图标保持紧凑 */
.recent-projects--fullpage .recent-projects__icon {
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
.recent-projects__btn {
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
.recent-projects__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: var(--radius-base);
}
.recent-projects__item.is-missing {
  color: var(--text-secondary);
  cursor: not-allowed;
}
.recent-projects__item.is-missing:hover {
  background: var(--tint-danger-06);
}
.recent-projects--fullpage .recent-projects__item.is-missing:hover {
  border-color: var(--tint-danger-50);
  background: var(--tint-danger-06);
}
.recent-projects__icon {
  flex-shrink: 0;
  color: var(--color-primary);
}
.recent-projects__item.is-missing .recent-projects__icon {
  color: var(--text-secondary);
}
/* 缺失态:fullpage 图标色块从中性蓝改为灰底,与 is-missing 语义一致 */
.recent-projects--fullpage .recent-projects__item.is-missing .recent-projects__icon {
  background: var(--bg-component-hover);
}
.recent-projects__name {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.recent-projects__name-base {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  letter-spacing: -0.1px;
}
.recent-projects__name-parent {
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  /* faded to recede behind the project name */
  opacity: 0.85;
}
.recent-projects--fullpage .recent-projects__name-base {
  font-size: var(--font-size-15);
}
.recent-projects--fullpage .recent-projects__name-parent {
  font-size: 12px;
}
.recent-projects__tag {
  flex-shrink: 0;
  padding: 1px var(--spacing-sm);
  font-size: var(--font-size-xs);
  border-radius: var(--radius-sm);
  background: var(--tint-danger-14);
  color: var(--color-danger-light);
}
</style>
