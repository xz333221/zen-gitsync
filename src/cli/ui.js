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
// CLI 共用 UI 工具:
//   - boxenAdaptive(): boxen 包装,宽度自适应终端(避免 80 列硬编码在窄终端换行难看)
//   - 预留 messages 表的导入入口(后续把硬编码中文迁移过来)
//
// 当前会话先落地 boxen 宽度自适应 — messages 表作为下轮 i18n 的过渡形态,
// 避免一次性大改风险。

import boxen from 'boxen'

/**
 * 默认 boxen 宽度 — 当 process.stdout.columns 不可用(管道/CI)时使用
 */
const FALLBACK_TERMINAL_WIDTH = 100

/**
 * 计算 boxen 的 width 选项,基于终端列数 + 留出 padding/margin 空间
 *
 * @param {object} [opts]
 * @param {number} [opts.headroom=6] - 留给 padding(2) + margin(2) + 边框(2) 的总列数
 * @returns {number} 用于 boxen options.width
 */
export function calcBoxenWidth({ headroom = 6 } = {}) {
  const cols = process.stdout?.columns
  if (typeof cols !== 'number' || cols <= 0 || !Number.isFinite(cols)) {
    return FALLBACK_TERMINAL_WIDTH
  }
  // cols 已经包含 padding,boxen 的 width 选项是 "内部内容宽度" 还是 "总宽度" 与 version 有关
  // boxen 8.x: width = 内框内容宽度(不含 padding/border)
  // 我们设 width = cols - headroom,让 boxen 自己处理 padding
  const w = cols - headroom
  return w > 0 ? w : FALLBACK_TERMINAL_WIDTH
}

/**
 * boxen 包装,宽度自适应终端
 *
 * @param {string} message - 内容
 * @param {object} [options] - 透传给 boxen 的选项(width 会覆盖)
 * @returns {string}
 */
export function boxenAdaptive(message, options = {}) {
  // 用户显式传 width 时尊重用户;否则按终端自适应
  const width = options.width ?? calcBoxenWidth()
  return boxen(message, { ...options, width })
}