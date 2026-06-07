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
// import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import SvgIcon from './index.vue' // svg component

const modules = (import.meta as any).glob('./svg*.svg')
const _icons = []
for (const path in modules) {
  const p = path.split('svg/')[1].split('.svg')[0]
  _icons.push(p)
}

export function initSvg(app: any) {
  app.component('svg-icon', SvgIcon)
    // for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    //     app.component(key, component)
    // }
}
export { SvgIcon }
