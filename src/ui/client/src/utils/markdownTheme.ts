/*
 * Copyright 2026 xz333221
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Markdown 预览主题(全局唯一)。
 *
 * 渲染与配色都交给 flowdash-md-preview:它的每个主题预设都是一段作用域限定在
 * `.md-preview` 内的 CSS。这里把选中的那套写进 document.head 里的一个 <style>,
 * 于是全应用的 Markdown 预览(文件空间预览、差异预览里的 markdown、AI 差异说明)
 * 共用同一套配色,组件自身不再散落排版样式。
 */
import { resolveTheme, THEMES } from 'flowdash-md-preview'

/** 注入的主题样式表 id;重复应用时按它复用同一个 <style> 节点 */
export const MARKDOWN_THEME_STYLE_ID = 'flowdash-md-preview-theme'

/** <style> 上的主题名标记,便于在 DevTools 里看出当前用的是哪套 */
export const MARKDOWN_THEME_ATTR = 'data-md-theme'

/** 默认主题:各主题预设的键名,取自 flowdash-md-preview */
export const DEFAULT_MARKDOWN_THEME = 'github'

/** 可选主题列表(顺序即包内 THEMES 的声明顺序) */
export const MARKDOWN_THEMES: string[] = Object.keys(THEMES)

/** 设置面板里的一个主题选项(名字 + 预览色) */
export interface MarkdownThemeOption {
  value: string
  /** 主题底色,用于选项左侧的小色块 */
  bg?: string
  /** 主题前景色,用于色块上的示例文字 */
  fg?: string
}

/** 从主题 CSS 里抽第一个 color / background 值(抽不到就返回 undefined,色块退化成透明) */
function pickCssColor(css: string, prop: 'color' | 'background'): string | undefined {
  const matched = new RegExp(`(?:^|[;{\\n])\\s*${prop}\\s*:\\s*([^;]+);`).exec(css)
  return matched ? matched[1].trim() : undefined
}

/** 供设置面板渲染的主题选项:每项带一小块底色,方便直接看出亮/暗与风格 */
export const MARKDOWN_THEME_OPTIONS: MarkdownThemeOption[] = MARKDOWN_THEMES.map((name) => {
  const css = resolveTheme(name) || ''
  return { value: name, bg: pickCssColor(css, 'background'), fg: pickCssColor(css, 'color') }
})

/**
 * 把主题 CSS 应用到当前文档。
 *
 * - 未传 / 传了未知名字时回退到 {@link DEFAULT_MARKDOWN_THEME}
 * - 非浏览器环境(SSR / 测试)下是空操作
 */
export function applyMarkdownTheme(theme?: string | null): void {
  if (typeof document === 'undefined') return

  const requested = typeof theme === 'string' && theme.trim() ? theme.trim() : DEFAULT_MARKDOWN_THEME
  const css = resolveTheme(requested) ?? resolveTheme(DEFAULT_MARKDOWN_THEME)

  let style = document.getElementById(MARKDOWN_THEME_STYLE_ID) as HTMLStyleElement | null
  if (!css) {
    style?.remove()
    return
  }

  if (!style) {
    style = document.createElement('style')
    style.id = MARKDOWN_THEME_STYLE_ID
    document.head.appendChild(style)
  }
  style.setAttribute(MARKDOWN_THEME_ATTR, requested)
  if (style.textContent !== css) {
    style.textContent = css
  }
}
