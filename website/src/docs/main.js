import { createApp } from 'vue'
import DocsApp from './DocsApp.vue'
import { vReveal } from '../composables/useReveal.js'
import '../styles/tokens.css'
import '../styles/base.css'

document.documentElement.classList.add('js-ready')

createApp(DocsApp).directive('reveal', vReveal).mount('#app')
