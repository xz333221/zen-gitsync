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
// 「把 zen-gitsync 登记为某个工具的 MCP 服务」的前端状态。
//
// 顶栏编辑器按钮的右键菜单（DirectorySelector.vue，simpleTools 与 claude 两处）
// 共用这个 store：状态是单例，两处菜单各拉一次会各踩各的缓存，而"已添加"的判断
// 必须只有一个来源 —— 否则一处显示已添加、另一处还让点。
//
// 为什么是 pinia store 而不是模块级 ref 的 composable：与 toolsStore 同一理由
// （同属"本机 CLI 环境探测"、同一批工具、同一个刷新节奏），且测试里每个挂载
// 拿到全新 pinia、状态天然隔离 —— 模块级单例会让用例互相污染。
//
// 写配置文件的真相在服务端（src/mcp/install.js，与 CLI 的 `g mcp install` 同一份），
// 前端只传 target id，不拼路径、不认格式。动作函数**不抛异常**，一律返回
// { success, message?, error? }，让"失败"成为调用方必须显式处理的状态。

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ToolId } from '@/stores/toolsStore'

/** 一个 MCP 登记目标的状态（GET /api/mcp-install/targets 的一条） */
export interface McpTargetStatus {
  id: string
  label: string
  /** 配置文件路径（该平台不适用时为 null） */
  file: string | null
  /** 配置里是否已经登记了 zen-gitsync */
  installed: boolean
  /** 目标产品的目录是否存在（false = 没检测到，安装会被跳过） */
  parent_exists: boolean
}

/**
 * ToolId → MCP 安装目标 id（服务端 TARGETS 表）。
 *
 * 没列到的工具 = **未核实支持 MCP**，右键菜单里不显示该入口：
 *   · kimi —— 没核实到配置格式；
 *   · zcode —— 桌面应用，没有 CLI 通道；
 *   · dsh —— 自身没有 MCP 支持（翻过装机包的 dist，无 mcp 相关代码）。
 * 宁可没有这个入口，也不要给一个点了不生效的按钮。
 * 将来核实清楚了往这里加一行 + 服务端 TARGETS 加一个目标，两头就通。
 *
 * ⚠️ claude 的目标是 `claude-code`（CLI 直连的 ~/.claude.json），**不是**服务端
 * TARGETS 里那个 `claude`（Claude Desktop 的 claude_desktop_config.json）——
 * 顶栏那颗按钮开的就是 Claude Code CLI。
 */
export const TOOL_MCP_TARGETS: Partial<Record<ToolId, string>> = {
  vscode: 'vscode',
  claude: 'claude-code',
  codex: 'codex',
  opencode: 'opencode',
  codebuddy: 'codebuddy',
  pi: 'pi',
}

/** 一次安装 / 移除的结果：success=false 时 error 一定有值 */
export interface McpInstallResult {
  success: boolean
  /** 服务端给的人话结果（带文件路径），失败时为 undefined */
  message?: string
  error?: string
}

/** 统一的 POST 封装：网络异常也转成结果对象，不让调用方被 promise rejection 打穿 */
async function post(path: string, body: Record<string, unknown>): Promise<McpInstallResult> {
  try {
    const resp = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json().catch(() => null)
    if (!resp.ok || !data?.success) {
      return { success: false, error: data?.error || `HTTP ${resp.status}` }
    }
    return { success: true, message: typeof data.message === 'string' ? data.message : undefined }
  } catch (e) {
    return { success: false, error: (e as Error).message }
  }
}

export const useMcpInstallStore = defineStore('mcpInstall', () => {
  const statuses = ref<Record<string, McpTargetStatus>>({})
  /** 拉到过一次没有（拉过之后不重复打，除非 force） */
  const loaded = ref(false)
  let inflight: Promise<void> | null = null

  /**
   * 拉一次全部目标的登记状态（右键菜单打开时触发）。拉过就复用；
   * 安装 / 移除成功后传 force 刷新，让菜单提示从「一键安装」翻成「已添加」。
   */
  function fetchStatuses(force = false): Promise<void> {
    if (!force && loaded.value) return Promise.resolve()
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const resp = await fetch('/api/mcp-install/targets')
        const data = await resp.json()
        if (data?.success && Array.isArray(data.targets)) {
          const next: Record<string, McpTargetStatus> = {}
          for (const t of data.targets) {
            if (t && typeof t.id === 'string') next[t.id] = t as McpTargetStatus
          }
          statuses.value = next
          loaded.value = true
        }
      } catch {
        // 查询失败保持原状，菜单提示降级为「检测中…」
      } finally {
        inflight = null
      }
    })()
    return inflight
  }

  /** 这个工具能不能装 zen-gitsync MCP（在白名单里才有入口）。null = 不支持 */
  function targetOf(tool: ToolId): string | null {
    return TOOL_MCP_TARGETS[tool] ?? null
  }

  /** 三态：yes = 已添加；no = 没添加；unknown = 状态还没问到（别显示成"没添加"） */
  function installedState(tool: ToolId): 'yes' | 'no' | 'unknown' {
    const id = targetOf(tool)
    if (!id) return 'unknown'
    const s = statuses.value[id]
    if (!s) return 'unknown'
    return s.installed ? 'yes' : 'no'
  }

  async function installFor(tool: ToolId): Promise<McpInstallResult> {
    const id = targetOf(tool)
    if (!id) return { success: false, error: '该工具不支持 MCP' }
    return post('/api/mcp-install/install', { target: id })
  }

  async function removeFor(tool: ToolId): Promise<McpInstallResult> {
    const id = targetOf(tool)
    if (!id) return { success: false, error: '该工具不支持 MCP' }
    return post('/api/mcp-install/remove', { target: id })
  }

  return { statuses, loaded, fetchStatuses, targetOf, installedState, installFor, removeFor }
})
