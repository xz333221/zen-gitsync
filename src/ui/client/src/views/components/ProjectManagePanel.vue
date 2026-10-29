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
  项目清单（「项目管理」视图的主体）：一行一个 ProjectManageItem。

  刻意**不做搜索/筛选**（工作台左栏那套是给"快速选一个项目"用的）：这个视图的项目数
  就是用户自己的仓库数（几十个），按"正在跑 → 最近活跃 → 名字"排序后一屏能看完；
  真到需要筛的时候再加，现在加只是把工具栏塞满。

  排序口径与工作台左栏一致（有活跃执行的排前面，再按最后活跃时间倒序，最后按名字）——
  两处显示同一份清单，顺序不一样会让人以为数据不同步。
-->
<script setup lang="ts">
import { computed } from 'vue'
import { $t } from '@/lang/static'
import ProjectManageItem from '@views/components/ProjectManageItem.vue'
import type { ProjectSummary } from '@/types/workbench'

const props = defineProps<{
  projects: ProjectSummary[]
  loading: boolean
  /** 正在删除的项目 key（转圈 + 防重复点） */
  removingKey?: string
}>()

const emit = defineEmits<{
  remove: [project: ProjectSummary]
}>()

const ordered = computed(() => {
  return [...props.projects].sort((a, b) => {
    if ((a.stats.runningJobs > 0) !== (b.stats.runningJobs > 0)) {
      return a.stats.runningJobs > 0 ? -1 : 1
    }
    const ta = a.stats.lastActiveAt || ''
    const tb = b.stats.lastActiveAt || ''
    if (ta !== tb) return tb.localeCompare(ta)
    return a.name.localeCompare(b.name)
  })
})
</script>

<template>
  <div class="pm-list">
    <!-- 首屏加载：只在"还没有任何数据"时给整块 loading（轮询刷新不该闪） -->
    <div v-if="loading && projects.length === 0" class="pm-list__state">
      <el-icon class="is-loading pm-list__spinner">
        <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
          <path fill="currentColor" d="M512 64a32 32 0 0 1 32 32v192a32 32 0 0 1-64 0V96a32 32 0 0 1 32-32zm0 640a32 32 0 0 1 32 32v192a32 32 0 1 1-64 0V736a32 32 0 0 1 32-32zm448-192a32 32 0 0 1-32 32H736a32 32 0 1 1 0-64h192a32 32 0 0 1 32 32zm-640 0a32 32 0 0 1-32 32H96a32 32 0 0 1 0-64h192a32 32 0 0 1 32 32z"/>
        </svg>
      </el-icon>
      <p class="pm-list__state-text">{{ $t('@PROJM:正在读取项目列表…') }}</p>
    </div>

    <!-- 一个项目都没有：这是这个视图最该说话的时候 —— 告诉用户下一步去哪 -->
    <div v-else-if="projects.length === 0" class="pm-list__state">
      <p class="pm-list__state-title">{{ $t('@PROJM:尚无项目') }}</p>
      <p class="pm-list__state-text">{{ $t('@PROJM:用「添加项目」把仓库加进来，或看看上面的推荐列表') }}</p>
    </div>

    <ul v-else class="pm-list__items">
      <ProjectManageItem
        v-for="p in ordered"
        :key="p.key"
        :project="p"
        :removing="p.key === removingKey"
        @remove="emit('remove', $event)"
      />
    </ul>
  </div>
</template>

<style scoped>
.pm-list {
  display: flex;
  flex-direction: column;
}

.pm-list__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 24px 4px;
  padding: 28px 16px;
  /* 空态 / 加载态都不套框：虚线圈在这个视图里已经被「添加项目」那枚动作占了 */
  text-align: center;
}
.pm-list__state-title {
  margin: 0;
  font-size: var(--font-size-mid);
  color: var(--text-secondary);
}
.pm-list__state-text {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--text-meta);
}
.pm-list__spinner {
  font-size: 22px;
  color: var(--color-primary);
}

/* 平铺**网格**：一行按可用宽度放多张卡片（用户 2026-10-16：「每行多展示一些卡片」）。
   · auto-fill + minmax(420px)：1900px 屏 ≈ 4 列（33 个项目 8~9 行看完），
     1280px ≈ 2 列，窄屏自然退回单列，不需要任何媒体查询。
   · 卡片之间不画分隔线、也不套边框 —— 靠 20px 列间距与 hover 底色区分
     （"圆角 + 单 border"的卡片样式是用户点名不要的）。
   · 420 是"项目名不被压成省略号、路径还能看出是哪个仓库"的下限（卡片正面没有那排工具
     图标之后，这个下限由"图标 + 名字 + 分支/进度 + 路径"最宽的一行决定）。 */
.pm-list__items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  column-gap: 20px;
  row-gap: 6px;
  align-items: start;
}
</style>
