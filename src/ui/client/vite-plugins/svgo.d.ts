// svgo 2.x 不随包提供类型声明（3.x 才有），这里只声明本项目用到的两个形状。
// 只覆盖 optimize + OptimizeOptions，不追求完整还原 —— 依赖它的两处（svg-icon / svg-sprite）
// 各自都有运行时回归测试（vite-plugins/svg-icon.test.ts、svg-sprite.test.ts）。
declare module 'svgo' {
  export interface OptimizeOptions {
    plugins?: Array<string | { name: string; params?: Record<string, unknown> }>
    [key: string]: unknown
  }

  export type OptimizeResult = { data: string } | { error: string }

  export function optimize(input: string, options?: OptimizeOptions): OptimizeResult
}
