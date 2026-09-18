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
// 「用外部程序打开一个目录」的统一出口。
//
// 顶栏的 DirectorySelector（作用于当前工作目录）和多项目编排台的项目列表（作用于
// 列表里任意一个项目）需要的是同一套动作：文件管理器 / 终端 / 各编辑器与 AI 工具 /
// 在新标签页跑 g ui。两边只差「打开哪个路径」和「提示文案怎么写」，
// 所以接口调用、端点映射、工具展示名都收在这里 —— 否则同一份 URL 抄两遍，
// 后端改个路由就要满仓库找调用点。
//
// 设计取舍：这些函数**不抛异常**，一律返回 { success, message?, error? }。
// 抛异常时调用方要么漏写 try/catch（历史上 kimi/zcode/dsh 就是这么漏的，失败静默），
// 要么每个调用点抄一遍 catch。返回值让"失败"成为一种必须显式处理的状态。
// toast 与安装引导仍归调用方 —— 两处的措辞和交互本来就不一样。

import { useToolsStore, type ToolId } from '@/stores/toolsStore'

/** 一次「打开」的结果：success=false 时 error 一定有值 */
export interface OpenDirectoryResult {
  success: boolean
  /** 服务端返回的成功文案（可能带 permission-mode 之类的细节），失败时为 undefined */
  message?: string
  /** 服务端返回的失败原因，或网络层异常信息 */
  error?: string
}

/** ToolId → 后端端点。新增工具时这里和 TOOL_DISPLAY_NAMES 一起加，别再往组件里写 URL */
const TOOL_ENDPOINTS: Record<ToolId, string> = {
  vscode: '/api/open-directory-with-vscode',
  claude: '/api/open-directory-with-claude-code',
  codex: '/api/open-directory-with-codex',
  opencode: '/api/open-directory-with-opencode',
  kimi: '/api/open-directory-with-kimi',
  zcode: '/api/open-directory-with-zcode',
  dsh: '/api/open-directory-with-dsh',
}

/** 工具展示名：菜单、tooltip、安装引导都用它，保证同一个工具在三处叫法一致 */
export const TOOL_DISPLAY_NAMES: Record<ToolId, string> = {
  vscode: 'VSCode',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  zcode: 'ZCode',
  dsh: 'DeepSeek Harness',
}

/**
 * 「用工具打开」菜单里的工具。**不含 claude** —— 它有三种权限模式，
 * 两端都是单独排布的（见各自模板里的 claude 菜单），混进这个列表会把"一行一个工具"的
 * 节奏打乱。用类型把它排除掉，将来误加一条会在编译期报错。
 */
export type OpenWithToolId = Exclude<ToolId, 'claude'>

/**
 * 「用工具打开」菜单项的可展示元数据。
 * labelKey 存的是翻译 key 而不是译好的字符串：模块顶层求值只会在首次导入时取一次语言，
 * 用户在设置里切语言后菜单不会跟着变。
 */
export interface OpenWithTool {
  id: OpenWithToolId
  name: string
  /** SvgIcon 的 icon-class（sprite 名） */
  icon: string
  labelKey: string
}

export const OPEN_WITH_TOOLS: OpenWithTool[] = [
  { id: 'vscode', name: 'VSCode', icon: 'vscode', labelKey: '@67CE7:用 VSCode 打开' },
  { id: 'codex', name: 'Codex', icon: 'codex', labelKey: '@67CE7:用 Codex 打开' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode', labelKey: '@67CE7:用 OpenCode 打开' },
  { id: 'kimi', name: 'Kimi Code', icon: 'kimi', labelKey: '@67CE7:用 Kimi Code 打开' },
  { id: 'zcode', name: 'ZCode', icon: 'zcode', labelKey: '@67CE7:用 ZCode 打开' },
  { id: 'dsh', name: 'DeepSeek Harness', icon: 'dsh', labelKey: '@67CE7:用 DeepSeek Harness 打开' },
]

/** 统一的 POST 封装：网络异常也转成结果对象，不让调用方被 promise rejection 打穿 */
async function post(path: string, body: Record<string, unknown>): Promise<OpenDirectoryResult> {
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

/** 在资源管理器 / 访达里打开目录 */
export function openPathInFileManager(dirPath: string): Promise<OpenDirectoryResult> {
  return post('/api/open_directory', { path: dirPath })
}

/** 在系统终端里打开目录（新窗口） */
export function openPathInTerminal(dirPath: string): Promise<OpenDirectoryResult> {
  return post('/api/open_terminal', { path: dirPath })
}

/**
 * 新开一个终端标签页，在目标目录里执行 `g ui`。
 * 服务端会剥掉 PORT 环境变量，子进程自己挑空闲端口 —— 所以不会和当前实例抢端口。
 */
export function launchGuiInNewTab(dirPath: string): Promise<OpenDirectoryResult> {
  return post('/api/open-new-tab-gui', { path: dirPath })
}

/**
 * 用某个编辑器 / AI 工具打开目录。
 * @param permissionMode 仅 claude 用（default / acceptEdits / bypassPermissions），其它工具会忽略
 */
export function openPathWithTool(
  tool: ToolId,
  dirPath: string,
  permissionMode?: string,
): Promise<OpenDirectoryResult> {
  return post(TOOL_ENDPOINTS[tool], permissionMode ? { path: dirPath, permissionMode } : { path: dirPath })
}

/**
 * 确保工具检测跑过一轮（返回 false = 检测失败，调用方该提示"稍后重试"而不是当成未安装）。
 * 「未安装 → 弹安装引导」这个判断建立在检测结果上，检测没跑完时 isToolAvailable 全是 false，
 * 直接信它会把装了 VSCode 的机器判成没装。
 */
export async function ensureToolsChecked(): Promise<boolean> {
  const toolsStore = useToolsStore()
  if (toolsStore.lastCheckedAt === null) await toolsStore.checkTools()
  return toolsStore.lastCheckedAt !== null
}
