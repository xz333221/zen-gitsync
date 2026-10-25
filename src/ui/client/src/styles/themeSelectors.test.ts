/**
 * 主题选择器守卫 —— 防 `html.dark` 这类死选择器回潮。
 *
 * 背景（2026-10-12 破案）：本项目深色主题挂在 `<html data-theme="dark">` 属性上
 * （见 stores/configStore.ts 的 applyTheme），不是 .dark class
 * （那是 Element Plus 官方暗色方案的钩子，本项目没引它）。
 * 曾经有 16 处深色覆盖写成 `html.dark ...` —— 浏览器与构建器全都不报错，
 * 只有深色模式下肉眼才能发现它们从未生效；OrchestratorConsole 的
 * 「对话 / 指令」拨片因此被用户报了两次（选中档实测对比度 1.70:1）。
 *
 * 实现说明：这里刻意不用 import.meta.glob —— 它的展开结果会在 vite transform
 * 阶段被静态固化成模块导入列表，并按内容哈希缓存：新增的源文件不会被纳入
 * 扫描（实测加违规样本 + touch 测试文件都抓不到，假绿）。改用 node:fs
 * 运行时实时扫描，每次运行都看真实的文件系统。
 */
import { describe, test, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** vitest 固定从 src/ui/client 启动（package.json 的 test 脚本就是这样跑的） */
const SRC_ROOT = join(process.cwd(), 'src')
if (!existsSync(SRC_ROOT)) {
  throw new Error(`主题选择器守卫找不到 ${SRC_ROOT} —— 请从 src/ui/client 目录运行 vitest`)
}

function walkStyleFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) walkStyleFiles(p, out)
    else if (/\.(vue|scss|css)$/.test(ent.name)) out.push(p)
  }
  return out
}

/** 剥注释：解释性注释里会引用错误写法本身（"别写 html.dark"），不剥会把自己绊倒 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
}

/** .vue 取全部 <style> 块；.scss / .css 全文都是样式 */
function styleText(file: string, src: string): string {
  if (!file.endsWith('.vue')) return src
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '').join('\n')
}

describe('主题选择器守卫', () => {
  test('样式里不出现 html.dark（深色只认 html[data-theme="dark"] / [data-theme="dark"]）', () => {
    const offenders = walkStyleFiles(SRC_ROOT)
      .filter((file) => /html\.dark\b/.test(stripComments(styleText(file, readFileSync(file, 'utf8')))))
      .map((file) => file.replace(SRC_ROOT, 'src'))
    expect(offenders).toEqual([])
  })

  // 2026-10-25：控制台的「对话/指令」拨片已删（只剩指令），这条守卫随之移除。
})
