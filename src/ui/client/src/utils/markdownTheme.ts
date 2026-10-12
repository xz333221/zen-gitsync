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

/**
 * 跟随**应用亮暗**的 Markdown 主题。
 *
 * 用户选的 `markdownTheme` 是给"文档预览"的皮肤(文件空间里预览 .md、设置页的主题卡片),
 * 它允许在深色应用里选一套浅色主题 —— 那是文档自己的样子,没错。
 * 但**嵌在应用面板里**的预览(AI 差异说明、AI 文件说明)不是文档,是界面的一部分:
 * 它必须跟着应用亮暗走,否则深色面板里会嵌一块纯白。
 */
export const APP_MARKDOWN_THEME: Record<'light' | 'dark', string> = {
  light: 'github',
  dark: 'github-dark'
}

/**
 * 实例级主题的类名前缀。完整类名是 `md-preview--scoped-<主题名>`。
 *
 * 为什么把主题名编进类名（而不是所有实例级主题共用一个类）：
 * 抬升后的选择器是 `.md-preview.md-preview--scoped-x`（特异性 0-2-0），
 * 两套**不同**主题的实例级样式表特异性相同 —— 谁后进 `<head>` 谁赢。
 * 共用一个类名时，浅色→深色切换会把 `-github` 追加到 `-github-dark` 后面，
 * 于是深色下永远读到浅色那套（实测踩过）。主题名进类名后，各套选择器只匹配自己的节点，
 * 互不干扰，同一个页面里也能并存两套不同的实例级主题。
 */
export const SCOPED_MARKDOWN_CLASS_PREFIX = 'md-preview--scoped-'

/** 实例级主题样式表的 id 前缀 */
const SCOPED_STYLE_ID_PREFIX = 'flowdash-md-preview-scoped-'

/** 已注入的实例级主题(按类名去重,同一套只写一个 <style>) */
const injectedScopedThemes = new Set<string>()

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

/**
 * 主题名 → 实例级类名（`md-preview--scoped-<主题名>`）。
 *
 * 未知 / 空主题名回退到 {@link DEFAULT_MARKDOWN_THEME}，与
 * {@link ensureScopedMarkdownTheme} 的实际注入保持一致（否则类名和样式表会对不上，
 * 表现为"标了 scoped 却还是全局配色"）。
 */
export function scopedMarkdownClass(theme?: string | null): string {
  const requested = typeof theme === 'string' && theme.trim() ? theme.trim() : DEFAULT_MARKDOWN_THEME
  const name = resolveTheme(requested) ? requested : DEFAULT_MARKDOWN_THEME
  // 只留 CSS 标识符安全字符：预设名本来都是 [a-z-]，这里只是兜住自定义主题名
  return SCOPED_MARKDOWN_CLASS_PREFIX + name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
}

/**
 * 注入一套**只作用于本实例**的 Markdown 主题，返回该主题对应的类名
 * （标到预览根节点上即生效，见 {@link scopedMarkdownClass}）。
 *
 * 主题预设的 CSS 全部以 `.md-preview` 打头，{@link applyMarkdownTheme} 直接写进 head
 * 让全应用的预览共用。这里把选择器抬成 `.md-preview.md-preview--scoped-x`（两段类名，
 * 特异性 0-2-0 > 全局那套的 0-1-0），于是同一页面里能并存两套配色：
 * 全局那套给文档预览，这套给标了对应 scoped 类名的预览。
 *
 * 同一主题只注入一次；`document` 不存在（SSR / 测试）时是空操作。
 */
export function ensureScopedMarkdownTheme(theme?: string | null): string | null {
  const className = scopedMarkdownClass(theme)
  if (typeof document === 'undefined') return className
  if (injectedScopedThemes.has(className)) return className

  const name = className.slice(SCOPED_MARKDOWN_CLASS_PREFIX.length)
  const css = resolveTheme(name) ?? resolveTheme(DEFAULT_MARKDOWN_THEME)
  if (!css) return null

  const style = document.createElement('style')
  style.id = `${SCOPED_STYLE_ID_PREFIX}${name}`
  style.setAttribute(MARKDOWN_THEME_ATTR, name)
  // 只抬选择器前缀:各主题的 CSS 里 `.md-preview` 仅出现在选择器位置(注释 / 取值里都没有)
  style.textContent = css.replace(/\.md-preview(?![\w-])/g, `.md-preview.${className}`)
  document.head.appendChild(style)
  injectedScopedThemes.add(className)
  return className
}
