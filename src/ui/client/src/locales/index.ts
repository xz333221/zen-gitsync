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
import { createI18n } from 'vue-i18n'
// 使用 i18n 工具自动生成的翻译文件
import zhCN from '@/lang/zh/index.js'
import enUS from '@/lang/en/index.js'

// 支持的语言列表
export const SUPPORT_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportLocale = typeof SUPPORT_LOCALES[number]

// 语言显示名称
export const LOCALE_NAMES: Record<SupportLocale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
}

// 从 localStorage 读取已保存的语言作为 i18n bootstrap 兜底
// 注意：localStorage 只是早期 bootstrap 阶段能拿到的最快来源；
// 文件 ~/.git-commit-tool.json 是唯一真相源。configStore.loadConfig()
// 完成后会调 setLocale(configData.locale) 覆盖此值。
// 一次性迁移：setLocale 不再写 localStorage；configStore 启动时会清掉旧 'locale' 键。
const getDefaultLocale = (): SupportLocale => {
  let saved: SupportLocale | null = null
  try {
    const raw = localStorage.getItem('locale') as SupportLocale | null
    if (raw && SUPPORT_LOCALES.includes(raw)) saved = raw
  } catch { /* localStorage 不可用时静默 */ }
  if (saved) return saved
  // 检测浏览器语言
  const browserLang = typeof navigator !== 'undefined' ? navigator.language : ''
  if (browserLang && browserLang.startsWith('zh')) {
    return 'zh-CN'
  }
  return 'zh-CN' // 默认中文
}

// 创建 i18n 实例
const i18n = createI18n({
  legacy: false, // 使用 Composition API 模式
  locale: getDefaultLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS,
  },
  globalInjection: true, // 全局注入 $t 函数
})

// 切换语言（i18n 运行时）
// 持久化由 configStore.saveGeneralSettings({ locale }) 统一负责，写到 ~/.git-commit-tool.json
// 此函数不再写 localStorage；setLocale 只负责更新 i18n 运行时和 html[lang] 属性
export function setLocale(locale: SupportLocale) {
  i18n.global.locale.value = locale
  // 更新 HTML lang 属性
  if (typeof document !== 'undefined') {
    document.querySelector('html')?.setAttribute('lang', locale)
  }
}

// 获取当前语言
export function getLocale(): SupportLocale {
  return i18n.global.locale.value as SupportLocale
}

export default i18n
