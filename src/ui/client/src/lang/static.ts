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

