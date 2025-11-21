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
