import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN'
import enUS from './en-US'

// 支持的语言列表
export const SUPPORT_LOCALES = ['zh-CN', 'en-US'] as const
export type SupportLocale = typeof SUPPORT_LOCALES[number]

// 语言显示名称
export const LOCALE_NAMES: Record<SupportLocale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
}

// 从 localStorage 获取保存的语言，默认为中文
const getDefaultLocale = (): SupportLocale => {
  const savedLocale = localStorage.getItem('locale') as SupportLocale
  if (savedLocale && SUPPORT_LOCALES.includes(savedLocale)) {
    return savedLocale
  }
  // 检测浏览器语言
  const browserLang = navigator.language
  if (browserLang.startsWith('zh')) {
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

// 切换语言
export function setLocale(locale: SupportLocale) {
  i18n.global.locale.value = locale
  localStorage.setItem('locale', locale)
  // 更新 HTML lang 属性
  document.querySelector('html')?.setAttribute('lang', locale)
}

// 获取当前语言
export function getLocale(): SupportLocale {
  return i18n.global.locale.value as SupportLocale
}

export default i18n
