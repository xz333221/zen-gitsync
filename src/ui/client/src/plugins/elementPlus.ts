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
