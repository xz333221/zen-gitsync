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
// 项目清单数据源：GET /api/workbench/projects
//
// 一个接口同时拿回「项目清单（含 Git 状态与任务统计）」和「看板任务（已带 column）」，
// 因为两者本来就是同一次扫描的产物，拆成两个接口只会让看板出现"项目已刷新、卡片还没到"的割裂。
//
// 看板的列不是前端算的：任务落在哪一列由后端 projectRegistry.deriveTaskColumn 统一推导，
// 前端重复实现一遍必然和项目统计对不上（比如统计说"已完成 3"，卡片却只数出 2 张）。

import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import type { BoardTask, ProjectSummary } from '@/types/workbench'

export function useWorkbenchProjects() {
  const projects = ref<ProjectSummary[]>([])
  const boardTasks = ref<BoardTask[]>([])
  const currentProjectPath = ref('')
  const loading = ref(false)
  const loaded = ref(false)

  /**
   * 拉一次项目 + 看板任务。
   * @param silent 静默刷新（轮询用）：失败不弹 toast，避免网络抖一下就一直刷错误条
   */
  async function loadProjects(silent = false): Promise<boolean> {
    if (!silent) loading.value = true
    try {
      const res = await fetch('/api/workbench/projects', { cache: 'no-store' }).then(r => r.json())
      if (!res?.success) {
        if (!silent) ElMessage.error(res?.error || $t('@WORKBENCH:读取项目列表失败'))
        return false
      }
      projects.value = Array.isArray(res.projects) ? res.projects : []
      boardTasks.value = Array.isArray(res.tasks) ? res.tasks : []
      currentProjectPath.value = res.currentProjectPath || ''
      loaded.value = true
      return true
    } catch (err: any) {
      if (!silent) ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 从工作台项目清单里移除一个条目（左栏「目录不存在」那一行的删除按钮）。
   *
   * 服务端做两件事：从常用目录（config.json 的 recentDirectories）摘掉 + 记进隐藏名单。
   * 只删前者的话，只要还有任务记着这个路径，它会立刻从「任务」那半边重新生成，
   * 用户看到的就是"点了没反应"（语义见服务端 hiddenProjects.js 的文件头注释）。
   *
   * **一条任务都不会被删**，所以成功提示必须把这件事说出来：用户按下这颗按钮时
   * 最怕的就是"顺手把历史也清了"。keptTasks 一并回传就是给这句话用的。
   */
  async function removeProject(path: string): Promise<{ ok: boolean; keptTasks: number }> {
    if (!path) return { ok: false, keptTasks: 0 }
    try {
      const res = await fetch('/api/workbench/projects/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then(r => r.json()).catch(() => null)
      if (!res?.success) {
        ElMessage.error(res?.error || $t('@WORKBENCH:移除项目失败'))
        return { ok: false, keptTasks: 0 }
      }
      return { ok: true, keptTasks: Number.isFinite(res.keptTasks) ? res.keptTasks : 0 }
    } catch (err: any) {
      ElMessage.error($t('@WORKBENCH:网络错误: ') + (err?.message || err))
      return { ok: false, keptTasks: 0 }
    }
  }

  return { projects, boardTasks, currentProjectPath, loading, loaded, loadProjects, removeProject }
}
