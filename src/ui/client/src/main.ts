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
// 命令式 API 的样式手动补:ElMessage / ElMessageBox 通过 JS 调用而非模板用法,
// unplugin-vue-components 只对模板里检测到的组件自动注入 CSS,这俩的样式不会自动加载,
// 不手动 import 会渲染成无样式的裸 div(ElMessage toast 尤其明显,ElMessageBox 靠
// unified-dialogs.scss 的覆盖还能凑合看,但 base 的遮罩/定位/动画仍缺)。
// 同类坑见 AttachmentZone.vue 对 ElImageViewer 的单独 import。
import 'element-plus/es/components/message/style/css.mjs'
import 'element-plus/es/components/message-box/style/css.mjs'
import { initSvg } from './components/SvgIcon'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
// 注册全局 SvgIcon 组件
initSvg(app)
app.mount('#app')
