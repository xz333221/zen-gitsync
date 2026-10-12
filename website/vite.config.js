import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'

// 站点页脚展示的版本号直接读主包 package.json,不手写、不会过期
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// base 用相对路径:同一份 dist 既能挂在域名根目录,也能挂在 /zen-gitsync/ 这类子路径
export default defineConfig({
  base: './',
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5273, open: false },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 截图是产品资产,原样拷贝,不做 base64 内联
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900
  }
})
