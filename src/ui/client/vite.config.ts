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

// 读取外层 package.json 的版本号，构建时注入到 import.meta.env.PKG_VERSION
// vite.config.ts 位于 src/ui/client/，外层 package.json 在 ../../../package.json
function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '../../..', 'package.json')
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8')
      const pkg = JSON.parse(raw)
      return pkg.version || '0.0.0'
    }
  } catch (error) {
    console.error('读取 package.json 版本失败:', error)
  }
  return '0.0.0'
}

const pkgVersion = getPackageVersion()

// const backendPort = getBackendPort()

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  const isBuild = command === 'build'

  return {
    define: {
      'import.meta.env.PKG_VERSION': JSON.stringify(pkgVersion),
    },
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
  optimizeDeps: {
    exclude: ['ai-model-form'],
  },
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
    // watch: {
    //   // 忽略构建输出目录，避免 build 时触发热更新
    //   ignored: [
    //     '**/public/**',
    //     '**/dist/**',
    //     path.resolve(__dirname, '../public/**'),  // 使用绝对路径
    //     '**/.git/**',
    //     '**/node_modules/**'
    //   ],
    //   // 使用轮询可能会更稳定，但会消耗更多资源
    //   // usePolling: false,
    //   // interval: 100
    // },
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
