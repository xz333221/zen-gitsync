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
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import i18n from './locales'
import './main.css'
import './styles/tailwindcss.css'
// element-plus 全量样式必须在项目自定义样式之前注入。
// 原因:EP 2.14+ 的 dist/index.css 在 :root 下用 var() 链式定义主题变量
// (--el-table-bg-color: var(--el-fill-color-blank) 等),:root 与
// [data-theme="dark"] 特异性相同 (0,1,0),相同特异性下后加载的赢。
// 若 EP CSS 在 dark-theme.scss 之后加载,会把深色覆盖盖回 :root 的 #fff,
// 导致深色主题下 el-table 背景仍是白色。
// 入口顺序:EP 全量 CSS → 项目 scss 覆盖,保证项目深色变量赢。
// 代价:首屏多 ~80KB gzip CSS,但换掉所有 EP 组件样式延迟/裸奔 bug,值得。
import 'element-plus/dist/index.css'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import 'local-file-picker/dist/file-picker.css'
import './styles/common.scss'
import './styles/dark-theme.scss'
import './styles/unified-dialogs.scss'
import './styles/workbench.scss'
import './styles/markdown-renderer.css'
import 'virtual:svg-icons-register'
import { initSvg } from './components/SvgIcon'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
// 注册全局 SvgIcon 组件
initSvg(app)
app.mount('#app')
