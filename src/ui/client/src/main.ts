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
import './styles/common.scss'
import './styles/dark-theme.scss'
import './styles/unified-dialogs.scss'
import './styles/workbench.scss'
import './styles/markdown-renderer.css'
import 'virtual:svg-icons-register'
import 'local-file-picker/dist/file-picker.css'
// Vue Flow 样式必须在 VueFlow 组件 mount 之前注入,否则会 console warn
// 之前写在 FlowExecutionViewer/FlowOrchestrationWorkspace 组件级 import,
// 由于这俩组件是 defineAsyncComponent 懒加载,首次 mount 时 css 还没注入。
// 提到入口保证应用启动即加载。
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
// element-plus 全量样式入口注入。
// 原因:unplugin-vue-components 的 ElementPlusResolver 只对模板里检测到的组件
// 按需注入 CSS,但有两类场景漏掉:
//  1) 命令式 API(ElMessage / ElMessageBox)——不走模板,resolver 检测不到;
//  2) 异步组件(defineAsyncComponent)用的 EP 组件(如 LogList 的 el-table)——
//     首屏 chunk 还在下载时样式未注入,导致表格行/边框裸奔。
// 入口直接引全量 dist/index.css,一次性解决所有 EP 组件样式时序问题,
// 不再逐个手动 import message/message-box/table 等 style/css.mjs。
// 代价:首屏多 ~80KB gzip CSS,但换掉所有样式延迟/裸奔 bug,值得。
import 'element-plus/dist/index.css'
import { initSvg } from './components/SvgIcon'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
// 注册全局 SvgIcon 组件
initSvg(app)
app.mount('#app')
