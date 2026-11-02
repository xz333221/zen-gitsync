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
// 守门测试:自定义属性不能引用自己。
//
// 为什么需要:variables.scss 里曾有 `--focus-outline: var(--focus-outline);` ——
// CSS 把自引用判成循环依赖（guaranteed-invalid），所有 `outline: var(--focus-outline)`
// 在 computed-value 阶段一起失效。全项目 86 处在用它（43 个 :focus-visible 焦点环），
// 但界面不会报错、单测也不会红 —— 表现只是"键盘聚焦时没有轮廓"，
// 属于**没人会主动发现**的那类回归。
//
// 断言口径:剥掉注释后扫描 .scss/.css 与 .vue 的 style 块，找出
// `--x: <任何东西> var(--x)` 这种直接自引用。间接环（a→b→a）不在此列，
// 那种需要真的跑一遍 CSS 求值才能判，成本不划算。

import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full)
    }
  }
  return out
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** .vue 只取 <style> 块，.scss/.css 取全文。 */
function styleSources(file: string): string[] {
  const src = readFileSync(file, 'utf-8')
  if (!file.endsWith('.vue')) return [stripComments(src)]
  const blocks: string[] = []
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    blocks.push(stripComments(m[1]))
  }
  return blocks
}

/** 找出值里引用了自己的自定义属性。 */
function findSelfReferences(css: string): string[] {
  const hits: string[] = []
  // 值限制在同一声明内（不含 ; { }），避免跨声明误匹配
  const re = /(--[\w-]+)\s*:\s*([^;{}]*?)\bvar\(\s*(--[\w-]+)\s*\)/g
  let m
  while ((m = re.exec(css))) {
    if (m[1] === m[3]) hits.push(m[1])
  }
  return hits
}

describe('自定义属性不得自引用', () => {
  test('全部 .scss / .css / .vue style 块', () => {
    const files = [
      ...walk(CLIENT_SRC, ['.scss', '.css', '.vue']),
    ]

    const offenders: string[] = []
    let scanned = 0

    for (const file of files) {
      for (const css of styleSources(file)) {
        scanned++
        for (const name of findSelfReferences(css)) {
          offenders.push(`${relative(CLIENT_SRC, file).split(sep).join('/')} → ${name}`)
        }
      }
    }

    // 防"扫了个寂寞":文件数掉到 100 以下说明 walk 规则坏了
    expect(scanned).toBeGreaterThan(100)

    expect(
      offenders,
      `这些自定义属性引用了自己，浏览器会把它们判成 guaranteed-invalid：\n  ${offenders.join('\n  ')}`,
    ).toEqual([])
  })

  test('自引用检测本身有效（反样本）', () => {
    expect(findSelfReferences('--a: var(--a);')).toEqual(['--a'])
    expect(findSelfReferences('--a: 2px solid var(--a);')).toEqual(['--a'])
    expect(findSelfReferences('--a: var(--b);')).toEqual([])
    // 注释里的不算
    expect(findSelfReferences(stripComments('/* --a: var(--a); */ --b: 1px;'))).toEqual([])
  })
})
