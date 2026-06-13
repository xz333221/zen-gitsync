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
// 工作台 job 状态展示工具：标签 + 颜色。
// 两个视图（WorkbenchView 子任务徽标、ExecutionLogManager 卡片）共享。

import { $t } from '@/lang/static'

/** 状态 → 国际化标签。sub.status 也复用这个函数（todo / running / done / error / cancelled / pending） */
export function statusLabel(s: string): string {
  switch (s) {
    case 'todo': return $t('@WORKBENCH:待执行')
    case 'running': return $t('@WORKBENCH:执行中')
    case 'done': return $t('@WORKBENCH:已完成')
    case 'error': return $t('@WORKBENCH:出错')
    case 'cancelled': return $t('@WORKBENCH:已取消')
    case 'pending': return $t('@WORKBENCH:排队中')
    default: return s
  }
}

/** 状态 → CSS 颜色变量。灰色 cancelled 与"未完成"区分开 */
export function statusColor(s: string): string {
  switch (s) {
    case 'running': return 'var(--color-primary)'
    case 'done': return '#22c55e'
    case 'error': return '#ef4444'
    case 'cancelled': return '#9ca3af'
    case 'pending': return '#f59e0b'
    default: return 'var(--text-tertiary)'
  }
}
