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
// 「从远程地址推导仓库目录名」的唯一实现。
//
// 两处调用方：GUI 的克隆路由（/api/clone 决定 clone 出来的子目录名）与 g ai 的
// run_command 后处理（把 git clone 的落点登记进常用目录时，地址里没写目标目录，
// 只能按仓库名猜）。两边口径必须一致 —— 否则"认为克隆到了 A、实际在 B"。

/**
 * 从远程地址里取出仓库目录名(clone 出来的子目录就用它)。
 *   git@github.com:owner/repo.git     → repo
 *   https://gitee.com/owner/repo.git  → repo
 *   https://github.com/owner/repo/    → repo
 * 取不出来返回空串,调用方兜底成 repository。
 */
export function repoNameFromUrl(url) {
  const s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  const tail = s.split(/[/:]/).filter(Boolean).pop() || ''
  return tail.replace(/\.git$/i, '')
}
