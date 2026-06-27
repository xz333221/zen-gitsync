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
        // 走默认 importStyle (theme-chalk 完整包),保证 in-js 样式(segmented 指示器、
        // collapse 折叠动画等)与 css 都被 resolver 注入,容器高度不会算错 → 滚动条消失。
        // dev 期间触发 reload 的问题由下面的 optimizeDeps 兜底解决。
        resolvers: [ElementPlusResolver()],
      }),
      tailwindcss(),
      vue(),
      createSvgIcon(isBuild),
    ],
  optimizeDeps: {
    // monaco-editor (~3 MB) 仅 EditorView / SourceMapView / MonacoDiffViewer 用,这两个 view
    // 是路由级 lazy 加载;exclude 让 Vite dev 期跳过预构建,首启不再 ~30s 卡在 [optimizer]
    // build,改由浏览器运行时直接 esbuild 解析(配合 manualChunks 已独立切到 'monaco' chunk)
    exclude: ['ai-model-form', 'monaco-editor'],
    // entries:主入口即可。GitStatus 已改为静态 import,vite 从 main.ts → App.vue → GitStatus
    // 自然遍历整条依赖链,不需要单独列。其它 lazy 路由按需发现。
    entries: ['src/main.ts'],
    // 兜底:把 element-plus 整个包放进去,运行期即使 resolver 漏掉,Vite 也不再需要新增依赖
    include: ['element-plus/es > element-plus'],
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
    // 默认 5544；strictPort:true 时端口被占直接报错，避免 preview 工具抓到漂移后的端口
    // （preview 工具只问 .port/launch.json 配的 5544，不知道 vite 漂到 5545）
    port: 5544,
    strictPort: true,
    open: true,
    // 显式绑 IPv4,避免 vite 8 默认 'localhost' 只绑 IPv6 [::1] 导致浏览器走 127.0.0.1 拿不到 HMR
    host: '127.0.0.1',
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
            // 体积大且仅特定视图用到的库 → 各自独立 chunk,首屏不下载
            // monaco-editor 仅 EditorView 用(~3 MB)
            if (id.includes('monaco-editor')) return 'monaco'
            // @vue-flow/* 仅 SourceMapView + FlowOrchestrationWorkspace 用(~700 KB)
            if (id.includes('@vue-flow')) return 'vue-flow'
            // flow-mindmap 仅 MindmapPreview 用(~500 KB)
            if (id.includes('flow-mindmap')) return 'flow-mindmap'
            // socket.io-client 仅 Stores 用,但长连接常驻,独立 chunk 利于缓存
            if (id.includes('socket.io-client')) return 'socket-io'
            // element-plus 整体(被 resolver 按需,但全量包仍在)
            if (id.includes('element-plus')) return 'element-plus'
            // dagre 仅 FlowOrchestrationWorkspace 用
            if (id.includes('dagre')) return 'dagre'
            // 其它 node_modules 统一 vendor,避免过度切分
            if (id.includes('node_modules')) return 'vendor'
          },
        },
      },
    },
  }
})
