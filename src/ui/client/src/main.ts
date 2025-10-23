import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import i18n from './locales'
import './main.css'
import './styles/tailwindcss.css'
import './styles/common.scss'
import './styles/dark-theme.scss'
import 'file-icons-js/css/style.css'

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.mount('#app')
