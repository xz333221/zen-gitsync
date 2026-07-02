// Vitest 配置:复用 vite.config.ts 的 7 个 alias + 同样的 unplugin 链 + jsdom 环境。
// 插件顺序必须 AutoImport → Components → vue(Element Plus 约定)。
import { defineConfig, mergeConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default mergeConfig(
  defineConfig({
    plugins: [
      AutoImport({ resolvers: [ElementPlusResolver()] }),
      Components({ resolvers: [ElementPlusResolver()] }),
      vue(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@views': path.resolve(__dirname, './src/views'),
        '@stores': path.resolve(__dirname, './src/stores'),
        '@utils': path.resolve(__dirname, './src/utils'),
        '@assets': path.resolve(__dirname, './src/assets'),
        '@styles': path.resolve(__dirname, './src/styles'),
      },
    },
    define: { 'import.meta.env.PKG_VERSION': JSON.stringify('0.0.0-test') },
  }),
  defineConfig({
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.{test,spec}.ts'],
      css: false,
      server: { deps: { inline: ['element-plus'] } },
    },
  }),
)
