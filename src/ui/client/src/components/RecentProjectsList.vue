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
import { ref, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { Folder, Loading } from "@element-plus/icons-vue";
import { $t } from "@/lang/static";

withDefaults(defineProps<{ variant?: 'inline' | 'fullpage' }>(), {
  variant: 'inline',
});

const recentDirectories = ref<Array<{ path: string; exists: boolean }>>([]);
const isLoadingRecent = ref(false);

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
    <div v-if="isLoadingRecent && recentDirectories.length === 0" class="recent-projects__empty">
      <el-icon><Loading /></el-icon>
      <span>{{ $t('@13D1C:加载中...') }}</span>
    </div>
    <div v-else-if="recentDirectories.length === 0" class="recent-projects__empty">
      {{ $t('@13D1C:暂无最近项目') }}
    </div>
    <ul v-else class="recent-projects__list" :aria-label="$t('@13D1C:最近项目列表')">
      <li
        v-for="item in recentDirectories"
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
          <span class="recent-projects__name">{{ item.path }}</span>
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
  border-radius: 6px;
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
  overflow: hidden;
}
.recent-projects__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.recent-projects__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.recent-projects__hint {
  font-size: 11px;
  color: var(--text-secondary);
}
.recent-projects--fullpage .recent-projects__title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.2px;
}
.recent-projects--fullpage .recent-projects__hint {
  font-size: 13px;
  color: var(--text-secondary);
}
.recent-projects__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px;
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
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 4px;
  /* 列表占满父 flex 容器剩余空间,多出时内部滚动而不是撑爆外层 */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  align-content: start;
}
.recent-projects__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: background 0.12s;
}
.recent-projects__item:hover {
  background: rgba(45, 127, 249, 0.12);
}
.recent-projects--fullpage .recent-projects__item {
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--border-color-light);
  background: var(--bg-panel);
  font-size: 16px;
  transition: border-color 0.18s, box-shadow 0.18s, transform 0.12s, background 0.18s;
}
.recent-projects--fullpage .recent-projects__item:hover {
  background: var(--bg-component-hover);
  border-color: var(--color-primary);
  box-shadow: var(--focus-ring-soft);
  transform: translateY(-1px);
}
.recent-projects--fullpage .recent-projects__icon {
  width: 20px;
  height: 20px;
  font-size: 20px;
}
.recent-projects__btn {
  display: flex;
  align-items: center;
  gap: 8px;
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
  border-radius: 4px;
}
.recent-projects__item.is-missing {
  color: var(--text-secondary);
  cursor: not-allowed;
}
.recent-projects__item.is-missing:hover {
  background: rgba(239, 68, 68, 0.06);
}
.recent-projects--fullpage .recent-projects__item.is-missing:hover {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.04);
}
.recent-projects__icon {
  flex-shrink: 0;
  color: #2D7FF9;
}
.recent-projects__item.is-missing .recent-projects__icon {
  color: var(--text-secondary);
}
.recent-projects__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.recent-projects--fullpage .recent-projects__name {
  font-size: 15px;
}
.recent-projects__tag {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 3px;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
</style>
