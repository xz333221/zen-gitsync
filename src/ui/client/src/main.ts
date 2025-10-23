import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './main.css'
import './styles/tailwindcss.css'
import './styles/common.scss'
import './styles/dark-theme.scss'
import 'file-icons-js/css/style.css'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
