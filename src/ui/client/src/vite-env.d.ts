/// <reference types="vite/client" />

// vite-plugin-svg-icons 虚拟模块类型声明
declare module 'virtual:svg-icons-register' {
  const register: () => void
  export default register
}
