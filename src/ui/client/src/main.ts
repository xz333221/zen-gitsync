import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import i18n from './locales'
import './main.css'
import './styles/tailwindcss.css'
import './styles/common.scss'
import './styles/dark-theme.scss'
import './styles/unified-dialogs.scss'
import 'virtual:svg-icons-register'
import 'local-file-picker/dist/file-picker.css'
import { initSvg } from './components/SvgIcon'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
// 注册全局 SvgIcon 组件
initSvg(app)
app.mount('#app')
