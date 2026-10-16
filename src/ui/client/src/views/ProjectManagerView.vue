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
  「项目管理」视图：把项目当资产来管（添加 / 删除 / 看启动方式与打开方式）。

  为什么单开一个视图而不是并进工作台左栏（用户截图圈的是左侧活动栏）：
    · 工作台那一栏的点击语义是"选中 = 过滤看板"，再加"删除活项目 / 展开启动方式"
      会让同一个点击有多种含义；
    · 管理工作需要更宽的地方（完整路径、启动方式面板、推荐列表），左栏 200 多像素放不下。

  数据只有一份来源：GET /api/workbench/projects（与工作台同一接口、同一份清单）。
  刷新策略：
    · 挂载拉一次；
    · 10s 静默轮询兜底（别的 g ui 实例增删项目、任务路径带来的新项目都能看到）——
      比工作台的 5s 松一档：这里不显示实时任务进度，没必要跟得那么紧；
    · 添加 / 删除成功后就地刷一次，用户不用等下一个轮询周期。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { $t } from '@/lang/static'
import ProjectManagePanel from '@views/components/ProjectManagePanel.vue'
import RecommendedProjects from '@views/components/RecommendedProjects.vue'
import AddProjectDialog from '@views/components/AddProjectDialog.vue'
import { useWorkbenchProjects } from '@/composables/useWorkbenchProjects'
import type { ProjectSummary } from '@/types/workbench'

const { projects, loading, loadProjects, removeProject, addProject } = useWorkbenchProjects()

/** 正在删除的项目 key（行内转圈 + 防重复点） */
const removingKey = ref('')
const addVisible = ref(false)
const addSubmitting = ref(false)
const recommendedRef = ref<InstanceType<typeof RecommendedProjects> | null>(null)

let pollTimer: number | null = null
onMounted(() => {
  void loadProjects()
  pollTimer = window.setInterval(() => { void loadProjects(true) }, 10000)
})
onBeforeUnmount(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
})

/**
 * 添加一个目录。不切当前项目 —— 添加 ≠ 切过去看（切目录会改全局状态、波及其他实例）。
 * 失败时**不关弹窗**（由调用方决定），用户改一下路径就能重试，不必重新走一遍选择器。
 */
async function performAdd(dirPath: string): Promise<{ ok: boolean; alreadyKnown: boolean }> {
  const r = await addProject(dirPath)
  if (!r.ok) return r
  ElMessage.success(r.alreadyKnown
    ? $t('@PROJM:该目录已在项目列表中')
    : $t('@PROJM:已添加到项目列表'))
  await loadProjects(true)
  return r
}

/** 弹窗里的提交（成功才关窗；失败保持打开，让用户改路径） */
async function onSubmitAdd(dirPath: string) {
  addSubmitting.value = true
  try {
    const r = await performAdd(dirPath)
    if (!r.ok) return
    addVisible.value = false
    // 刚加的这个可能正躺在推荐列表里 —— 刷一次让它消失（一次有预算上限的扫描）
    void recommendedRef.value?.reload()
  } finally {
    addSubmitting.value = false
  }
}

/** 推荐列表里的一键添加（那一行自己会标"已添加"，所以这里不刷推荐列表） */
function onAddFromRecommended(dirPath: string) {
  return performAdd(dirPath)
}

async function onRemove(p: ProjectSummary) {
  removingKey.value = p.key
  try {
    const r = await removeProject(p.path)
    if (!r.ok) return
    const name = p.name || p.path
    ElMessage.success(r.keptTasks > 0
      ? $t('@PROJM:已移除「{name}」，它的 {n} 条任务仍保留', { name, n: r.keptTasks })
      : $t('@PROJM:已移除「{name}」', { name }))
    await loadProjects(true)
  } finally {
    removingKey.value = ''
  }
}
</script>

<template>
  <section class="pm">
    <header class="pm__head">
      <h2 class="pm__title">{{ $t('@PROJM:项目管理') }}</h2>
      <span class="pm__count">{{ $t('@PROJM:共 {n} 个项目', { n: projects.length }) }}</span>
      <button
        type="button"
        class="pm__add"
        :aria-label="$t('@PROJM:添加项目')"
        @click="addVisible = true"
      >
        <el-icon aria-hidden="true"><Plus /></el-icon>
        <span>{{ $t('@PROJM:添加项目') }}</span>
      </button>
    </header>

    <!-- 单一滚动容器：项目列表可以很长，推荐区跟着它一起滚（不给列表单独加滚动条，
         否则「滚到底看推荐」会变成"滚两次"） -->
    <div class="pm__body">
      <ProjectManagePanel
        :projects="projects"
        :loading="loading"
        :removing-key="removingKey"
        @remove="onRemove"
      />

      <RecommendedProjects ref="recommendedRef" :on-add="onAddFromRecommended" />
    </div>

    <AddProjectDialog
      v-model:visible="addVisible"
      :submitting="addSubmitting"
      @submit="onSubmitAdd"
    />
  </section>
</template>

<style scoped>
.pm {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  padding: 16px 20px 20px;
}
.pm__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding-bottom: 12px;
}
.pm__title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--text-primary);
}
.pm__count {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
  font-variant-numeric: tabular-nums;
}
.pm__add {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: #fff;
  font-family: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background var(--transition-fast) var(--ease-custom);
}
.pm__add:hover { background: var(--color-primary-dark, var(--color-primary)); filter: brightness(1.06); }
.pm__add:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }

.pm__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;   /* 滚动条不贴着卡片边 */
}
</style>
