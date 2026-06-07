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
/**
 * 终端会话管理 composable
 *
 * 封装与后端 /api/terminal-sessions* 的交互：
 * - GET    /api/terminal-sessions
 * - POST   /api/terminal-sessions/:id/restart
 * - DELETE /api/terminal-sessions/:id
 *
 * 状态：
 * - terminalSessions: 当前会话列表
 * - loading: 是否正在拉取
 *
 * 用法：
 *   const { sessions, loading, refresh, restart, remove } = useTerminalSessions()
 *   await refresh()
 */
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

export interface TerminalSession {
  id: number
  command: string
  workingDirectory?: string
  pid?: number | null
  createdAt?: number
  lastStartedAt?: number
  alive?: boolean
}

export function useTerminalSessions() {
  const sessions = ref<TerminalSession[]>([])
  const loading = ref(false)

  async function refresh(): Promise<void> {
    try {
      loading.value = true
      const resp = await fetch('/api/terminal-sessions')
      const result = await resp.json()
      if (result?.success) {
        sessions.value = Array.isArray(result.sessions) ? result.sessions : []
      } else {
        ElMessage.error(result?.error || '获取终端会话失败')
      }
    } catch (e: any) {
      ElMessage.error(e?.message || '获取终端会话失败')
    } finally {
      loading.value = false
    }
  }

  async function restart(session: TerminalSession): Promise<boolean> {
    try {
      loading.value = true
      const resp = await fetch(`/api/terminal-sessions/${session.id}/restart`, { method: 'POST' })
      const result = await resp.json()
      if (result?.success) {
        ElMessage.success('已重新启动终端')
        await refresh()
        return true
      }
      ElMessage.error(result?.error || '重新启动失败')
      return false
    } catch (e: any) {
      ElMessage.error(e?.message || '重新启动失败')
      return false
    } finally {
      loading.value = false
    }
  }

  async function remove(session: TerminalSession): Promise<boolean> {
    try {
      await ElMessageBox.confirm(
        '确定要删除该终端会话记录吗？如果该终端仍在运行，将尝试结束进程。',
        '删除终端会话',
        {
          confirmButtonText: '删除',
          cancelButtonText: '取消',
          type: 'warning',
        }
      )
    } catch {
      return false  // 用户取消
    }

    try {
      loading.value = true
      const resp = await fetch(`/api/terminal-sessions/${session.id}`, { method: 'DELETE' })
      const result = await resp.json()
      if (result?.success) {
        ElMessage.success('已删除')
        await refresh()
        return true
      }
      ElMessage.error(result?.error || '删除失败')
      return false
    } catch (e: any) {
      ElMessage.error(e?.message || '删除失败')
      return false
    } finally {
      loading.value = false
    }
  }

  /**
   * 同步合并一个新会话到列表（如果同 id 存在则更新）
   * 用于命令执行后立即显示新建的会话
   */
  function upsert(session: TerminalSession): void {
    const idx = sessions.value.findIndex(s => s.id === session.id)
    if (idx >= 0) {
      sessions.value.splice(idx, 1, session)
    } else {
      sessions.value.unshift(session)
    }
  }

  return {
    sessions,
    loading: computed(() => loading.value),
    count: computed(() => sessions.value.length),
    refresh,
    restart,
    remove,
    upsert,
  }
}
