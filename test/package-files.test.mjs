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

// 守门测试:package.json#files 必须覆盖所有"运行时会 import 到的本地模块"。
//
// 为什么需要这个守门(2026-09-18 事故):
//   `files` 是**逐条列举**的白名单,不像 `src/utils/**` 那样成目录地打包。
//   当天的数据目录收敛把 `src/paths.js` / `src/fsAtomic.js` / `src/configSplit.js` /
//   `src/dataDirMigration.js` 四个新模块加进 `src/` 根下,但谁也没想起来往 `files` 里补 ——
//   结果 2.17.1 发到 npm 之后,全局 `g ui` 一起手就是:
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../zen-gitsync/src/paths.js'
//       imported from .../zen-gitsync/src/config.js
//   本地永远复现不了(本地有全部文件),所以必须靠"发布物自检"来守。
//
// 断言口径:把 `files` 展开成"实际会进 tarball 的文件集合",再从这个集合里
// 逐个文件抽出相对 import / require 的说明符,解析到真实文件后要求它**也在集合里**。
// 任何一个没被覆盖 = 用户装上就是 ERR_MODULE_NOT_FOUND。
//
// 刻意不做的事:不真的跑 `npm pack`(慢 + 依赖网络/缓存),只按 npm 的白名单语义
// 在本地推演。`npm run verify:package-files` 的同伴校验见本文件末尾的手工说明。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

// 打包产物里的前端 bundle:体积以 MB 计、且相互 import 全在同一目录下,
// 逐个正则扫一遍纯属浪费(它们的覆盖由 `src/ui/public/**` 这一条 glob 保证)。
const SKIP_SCAN_PREFIXES = [join('src', 'ui', 'public', 'assets')]

// 测试文件会 import 各种只在仓库里存在的夹具,不被发布物需要 → 不参与"运行时依赖"扫描。
const TEST_FILE_RE = /\.(test|spec)\.(mjs|js|cjs|ts)$/

const rel = (p) => relative(ROOT, p).split(sep).join('/')

function walkFiles(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walkFiles(p, acc)
    else if (st.isFile()) acc.push(p)
  }
  return acc
}

/** 极简版 npm `files` 匹配:本项目只用到"目录/**"与"精确文件"两种写法。 */
function matchPattern(entry, relPath) {
  const e = entry.replace(/\\/g, '/').replace(/^\.\//, '')
  if (e.endsWith('/**')) {
    const prefix = e.slice(0, -3)
    return relPath === prefix || relPath.startsWith(prefix + '/')
  }
  if (e.includes('*')) {
    const re = new RegExp('^' + e.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')
    return re.test(relPath)
  }
  return relPath === e
}

/** 展开 `files` → 实际会被打包的仓库相对路径集合(含 npm 自动带上/被强制引用的入口)。 */
function collectShipped() {
  const entries = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(entries.length > 0, 'package.json 缺少 files 白名单 —— 那会把整个仓库连同 node_modules 打进包里')

  const shipped = new Set()
  for (const entry of entries) {
    if (entry.endsWith('/**')) {
      const dir = join(ROOT, entry.slice(0, -3))
      for (const f of walkFiles(dir)) shipped.add(rel(f))
    } else {
      const abs = join(ROOT, entry)
      if (existsSync(abs) && statSync(abs).isFile()) shipped.add(rel(abs))
    }
  }
  // bin 与 main 是"无论 files 怎么写都必须存在"的入口,一并纳入检查范围。
  const entries2 = [pkg.main, ...Object.values(pkg.bin || {})].filter(Boolean)
  for (const e of entries2) {
    const abs = resolve(ROOT, e)
    assert.ok(existsSync(abs), `package.json 声明的入口不存在: ${e}`)
    shipped.add(rel(abs))
  }
  return shipped
}

/**
 * 抽掉注释再扫描 —— 否则文件头 / 用法示例里的 `import ... from './utils/perfMark.js'`
 * 会被当成真依赖,报出"磁盘上不存在"的假警报(首次写这个测试时踩到:
 * `src/ui/server/utils/perfMark.js` 与 `src/cli/cleanup.js` 的头部注释各有一处)。
 * 只处理块注释与整行 `//` 注释:行尾注释里出现形如 `from './x'` 的概率可以忽略,
 * 而粗暴地全局去 `//` 会把 `https://…` 一起吃掉。
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 从源码里抽出相对模块说明符(ESM import/export-from/动态 import + CJS require)。 */
function extractRelativeSpecifiers(code) {
  const patterns = [
    /\bfrom\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bimport\s+['"](\.[^'"]+)['"]/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  const found = new Set()
  const source = stripComments(code)
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.add(m[1])
  }
  return [...found]
}

/** 相对说明符 → 磁盘上的真实文件(Node ESM 带扩展名,CJS 可能省略)。 */
function resolveSpecifier(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec)
  const candidates = [
    base,
    `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`,
    join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.cjs'),
  ]
  return candidates.find((p) => existsSync(p) && statSync(p).isFile()) || null
}

test('package.json#files 覆盖所有被 import 的本地模块', () => {
  const shipped = collectShipped()

  const missing = []
  const unresolved = []

  for (const relPath of shipped) {
    if (!/\.(js|mjs|cjs)$/.test(relPath)) continue
    if (TEST_FILE_RE.test(relPath)) continue
    if (SKIP_SCAN_PREFIXES.some((p) => relPath.startsWith(p + '/'))) continue

    const abs = join(ROOT, relPath)
    const code = readFileSync(abs, 'utf-8')

    for (const spec of extractRelativeSpecifiers(code)) {
      const target = resolveSpecifier(abs, spec)
      if (!target) {
        unresolved.push(`${relPath} → ${spec}`)
        continue
      }
      if (!shipped.has(rel(target))) {
        missing.push({ from: relPath, spec, expected: rel(target) })
      }
    }
  }

  assert.deepEqual(
    unresolved, [],
    '有相对 import 指向磁盘上不存在的文件(写错了,或文件被删了):\n  ' + unresolved.join('\n  ')
  )

  const detail = missing
    .map((m) => `  ${m.from}  import "${m.spec}"\n      → 需要把 ${m.expected} 加进 package.json#files`)
    .join('\n')

  assert.deepEqual(
    missing, [],
    `package.json#files 漏了 ${missing.length} 个运行时会 import 到的文件 —— `
    + `发布会打出缺文件的包(全局安装后 ERR_MODULE_NOT_FOUND):\n${detail}`
  )
})

test('CLI 运行时模块都在发布物里', () => {
  const shipped = collectShipped()
  // 这几条是"今天新加就漏了"的那批,单独钉一遍,让回归测试的意图一眼可见。
  for (const f of ['src/paths.js', 'src/fsAtomic.js', 'src/configSplit.js', 'src/dataDirMigration.js']) {
    assert.ok(shipped.has(f), `${f} 不在 package.json#files 里 —— 发布后全局 g ui 会 ERR_MODULE_NOT_FOUND`)
  }
})
