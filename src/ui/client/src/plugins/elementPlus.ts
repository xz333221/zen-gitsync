import type { App } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import en from 'element-plus/dist/locale/en.mjs'
import type { SupportLocale } from '@/locales'

// Element Plus 语言包映射
const localeMap = {
  'zh-CN': zhCn,
  'en-US': en,
}

// 获取 Element Plus 语言包
export function getElementPlusLocale(locale: SupportLocale) {
  return localeMap[locale] || zhCn
}

// 安装 Element Plus
export function setupElementPlus(app: App, locale: SupportLocale) {
  app.use(ElementPlus, {
    locale: getElementPlusLocale(locale),
  })
}
