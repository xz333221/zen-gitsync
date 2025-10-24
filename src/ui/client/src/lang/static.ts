/**
 * 静态翻译函数导出
 * 用于在 script 标签内使用 $t 翻译函数
 * 
 * 使用方式：
 * import { $t } from '@/lang/static'
 * 
 * const message = $t('common.confirm')
 */

import i18n from '@/locales'

// 导出 $t 函数，可以在 Vue 组件的 script 部分使用
export const $t = (key: string, params?: any) => {
  return i18n.global.t(key, params)
}

// 也可以导出其他 i18n 相关的方法
export const $te = (key: string) => {
  return i18n.global.te(key)
}

