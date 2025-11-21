import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
// import { visualizer } from 'rollup-plugin-visualizer'
import tailwindcss from "@tailwindcss/vite"
import fs from 'fs'
import createSvgIcon from './vite-plugins/svg-icon'

// 读取后端服务器端口
function getBackendPort() {
  try {
    // 尝试读取.port文件
    const portFilePath = path.resolve(__dirname, '../../..', '.port')
    if (fs.existsSync(portFilePath)) {
      const port = fs.readFileSync(portFilePath, 'utf8').trim()
      console.log(`检测到后端服务器端口: ${port}`)
      return parseInt(port, 10)
    }
  } catch (error) {
    console.error('读取后端端口失败:', error)
  }
  
  // 默认端口
  console.log('使用默认后端端口: 3000')
  return 3000
}

// const backendPort = getBackendPort()

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isBuild = command === 'build'
  
  return {
    plugins: [
      AutoImport({
        resolvers: [ElementPlusResolver()],
      }),
      Components({
        resolvers: [ElementPlusResolver()],
      }),
      tailwindcss(),
      vue(),
      createSvgIcon(isBuild),
      // visualizer({
      //   open: true,
      //   gzipSize: true,
      //   brotliSize: true,
      //   filename: 'stats.html'
      // })
    ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@components": path.resolve(__dirname, "./src/components"),
      "@views": path.resolve(__dirname, "./src/views"),
      "@stores": path.resolve(__dirname, "./src/stores"),
      "@utils": path.resolve(__dirname, "./src/utils"),
      "@assets": path.resolve(__dirname, "./src/assets"),
      "@styles": path.resolve(__dirname, "./src/styles"),
    },
  },
  server: {
    port: 5544,
    open: true,
    proxy: {
      "/api": {
        target: `http://localhost:${getBackendPort()}`, // 动态设置后端服务地址
        changeOrigin: true,
        // rewrite: (path) => path.replace(/^\/api/, '')
      },
    },
  },
    build: {
      outDir: path.resolve(__dirname, "../public"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("node_modules")) {
              return "vendor"
            }
          },
        },
      },
    },
  }
})
