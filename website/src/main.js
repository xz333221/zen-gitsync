import { createApp } from 'vue'
import App from './App.vue'
import { vReveal } from './composables/useReveal.js'
import './styles/tokens.css'
import './styles/base.css'

// JS 就绪后才启用"先隐藏、进视口再显示"的进场动效;脚本挂了内容也照样可见
document.documentElement.classList.add('js-ready')

createApp(App).directive('reveal', vReveal).mount('#app')
