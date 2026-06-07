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
 * ANSI 转义码 → HTML 转换 composable
 *
 * 终端命令输出通常含 ANSI 颜色码（[31m...），直接渲染到 DOM 是纯文本。
 * 用 ansi-to-html 转成带样式的 HTML，配合 v-html 渲染。
 *
 * 颜色主题由调用方传入（不同主题可能用不同色板）。
 */
import Convert from 'ansi-to-html'

export type AnsiColorMap = Record<number, string>

export const DEFAULT_DARK_COLORS: AnsiColorMap = {
  0: 'var(--color-black)',
  1: '#cd3131',
  2: '#0dbc79',
  3: '#e5e510',
  4: '#2472c8',
  5: '#bc3fbc',
  6: '#11a8cd',
  7: '#e5e5e5',
  8: '#666666',
  9: '#f14c4c',
  10: '#23d18b',
  11: '#f5f543',
  12: '#3b8eea',
  13: '#d670d6',
  14: '#29b8db',
  15: 'var(--color-white)',
}

export interface UseAnsiOptions {
  /** 颜色映射（key 是 ANSI 0-15），默认深色主题 */
  colors?: AnsiColorMap
  /** 前景色 */
  fg?: string
  /** 背景色 */
  bg?: string
  /** 是否将 \n 转成 <br>，默认 false（保留原始空白） */
  newline?: boolean
  /** 是否转义 XML 特殊字符，默认 false */
  escapeXML?: boolean
  /** 是否流式模式（保留不完整序列），默认 false */
  stream?: boolean
}

/**
 * 创建一个 ansi-to-html 转换器实例
 *
 * @example
 *   const { ansiToHtml } = useAnsiToHtml()
 *   const html = ansiToHtml('[31merror[0m')
 */
export function useAnsiToHtml(options: UseAnsiOptions = {}) {
  const converter = new Convert({
    fg: options.fg ?? '#e5e5e5',
    bg: options.bg ?? 'transparent',
    newline: options.newline ?? false,
    escapeXML: options.escapeXML ?? false,
    stream: options.stream ?? false,
    colors: options.colors ?? DEFAULT_DARK_COLORS,
  })

  function ansiToHtml(text: string): string {
    return converter.toHtml(text)
  }

  return { ansiToHtml, converter }
}
