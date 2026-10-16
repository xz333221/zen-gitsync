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
// 「用某个编辑器 / AI 工具打开一个目录」的判定 + 请求（**不含**安装引导弹窗）。
//
// 为什么单独抽：这个动作现在有三个调用点 ——
//   · 顶栏目录选择器的工具菜单；
//   · 项目行「打开方式」菜单（ProjectOpenMenuList，工作台与项目管理视图共用）；
//   · 项目管理视图行内那条工具快捷条（ProjectManageItem）。
// 「检测跑过没 → 这个工具装没装 → 打开 / 引导安装」这套判断抄三遍必然漂
// （历史上 kimi/zcode/dsh 漏 try/catch 就是这么发生的，见 useDirectoryOpenActions 头注释）。
//
// ⚠️ 刻意**不**在这里持有安装弹窗状态：弹窗是"每处一个实例"的资源
// （ToolInstallDialog 走 CommonDialog，关掉后节点仍留在 DOM —— 每行挂一个就是几十份）。
// 这里只回一个 `status`，由调用方决定弹窗挂在哪：
//   'opened'  → 已成功打开（这里已弹过成功提示）
//   'install' → 没装，调用方负责弹安装引导
//   'failed'  → 检测失败（这里已弹过提示），调用方什么都不用做
//   'no-dir'  → 没给目录（调用方的 bug，静默返回，别弹误导性的提示）

import { ElMessage } from 'element-plus'
import { $t } from '@/lang/static'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'
import {
  TOOL_DISPLAY_NAMES,
  ensureToolsChecked,
  openPathWithTool,
} from '@/composables/useDirectoryOpenActions'

export type OpenWithToolStatus = 'opened' | 'install' | 'failed' | 'no-dir'

export function useOpenWithTool() {
  const toolsStore = useToolsStore()

  /**
   * 工具是否"确认未安装"：检测没跑完（lastCheckedAt === null）一律按未知处理 ——
   * 那时 isToolAvailable 全是 false，直接信它会在装了 VSCode 的机器上挂一排「未安装」。
   */
  function toolMissing(tool: ToolId): boolean {
    return toolsStore.lastCheckedAt !== null && !toolsStore.isToolAvailable(tool)
  }

  async function tryOpenWithTool(
    tool: ToolId,
    dirPath: string,
    permissionMode?: string,
  ): Promise<OpenWithToolStatus> {
    if (!dirPath) return 'no-dir'
    if (!(await ensureToolsChecked())) {
      ElMessage.warning($t('@67CE7:工具检测失败，请稍后重试'))
      return 'failed'
    }
    if (!toolsStore.isToolAvailable(tool)) return 'install'

    const r = await openPathWithTool(tool, dirPath, permissionMode)
    if (r.success) {
      ElMessage.success(r.message || $t('@67CE7:已用 {tool} 打开目录', { tool: TOOL_DISPLAY_NAMES[tool] }))
      return 'opened'
    }
    ElMessage.error(`${$t('@67CE7:打开失败: ')}${r.error ?? ''}`)
    return 'failed'
  }

  return { toolMissing, tryOpenWithTool }
}
