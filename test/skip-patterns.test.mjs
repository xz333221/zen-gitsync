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

// 守门测试:产物/资源跳过清单与目录剪枝清单只能有一份定义。
//
// 为什么需要这个守门:
//   这份清单原来在三个地方各写一遍 —— `src/aiCommit.js`、`src/ui/server/routes/config.js`
//   是两份逐字相同的 18 条正则;`src/ui/server/routes/npm.js` 里更夸张,同一个文件
//   内两份 IGNORED_DIRS。三处各自维护不会立刻报错,只会**不对称地漏**:
//   加个新产物目录(比如 .turbo)时改了 AI 这边,npm 扫描那边照旧钻进去遍历几万文件,
//   或者反过来 —— 提交时跳过了、diff 里却还在。
//
// 断言口径:
//   1. 共享模块本身的行为(哪些路径该跳过);
//   2. 三个消费方都 import 它,且剥掉注释后**本地不再有同名定义**。
//      —— 剥注释是必须的:文件头注释里就写着 SKIP_FILE_PATTERNS,不剥会假红。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKIP_FILE_PATTERNS, SCAN_IGNORED_DIRS, isSkippedFile } from '../src/utils/skipPatterns.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 消费方:任何一个新增的调用点都该加进来。 */
const CONSUMERS = [
  'src/aiCommit.js',
  'src/ui/server/routes/config.js',
  'src/ui/server/routes/npm.js',
]

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
}

test('产物 / 资源 / lock 文件被跳过,普通源码不被误伤', () => {
  const skipped = [
    'dist/app.js',
    'build/index.html',
    'coverage/lcov.info',
    'node_modules/react/index.js',
    'packages/app/.next/server/page.js',
    'package-lock.json',
    'pnpm-lock.yaml',
    'vendor/a.min.js',
    'assets/logo.svg',
    'assets/demo.mp4',
    'assets/font.woff2',
    'downloads/archive.zip',
  ]
  for (const p of skipped) {
    assert.ok(isSkippedFile(p), `${p} 应该被跳过,但 isSkippedFile 返回 false`)
  }

  const kept = ['src/aiCommit.js', 'src/ui/server/routes/npm.js', 'README.md', 'docs/guide.md']
  for (const p of kept) {
    assert.ok(!isSkippedFile(p), `${p} 不该被跳过,但 isSkippedFile 返回 true`)
  }
})

test('目录剪枝清单包含常见产物目录,不含源码目录', () => {
  for (const dir of ['node_modules', 'dist', 'build', 'coverage', '.next', '__pycache__', 'vendor']) {
    assert.ok(SCAN_IGNORED_DIRS.has(dir), `${dir} 不在 SCAN_IGNORED_DIRS 里`)
  }
  for (const dir of ['src', 'test', 'docs']) {
    assert.ok(!SCAN_IGNORED_DIRS.has(dir), `${dir} 不该被剪掉`)
  }
})

test('三个消费方都从共享模块导入,本地不留副本', () => {
  for (const file of CONSUMERS) {
    const code = stripComments(readFileSync(join(ROOT, file), 'utf-8'))

    assert.match(
      code,
      /from\s+['"][^'"]*utils\/skipPatterns\.js['"]/,
      `${file} 没有从 utils/skipPatterns.js 导入 —— 清单又分叉了`,
    )

    // 反向断言:本地再定义一份就说明有人把旧代码贴回来了。
    // 前缀加 [^\w.$] 防止 `const MY_SKIP_FILE_PATTERNS` 这类同后缀变量误判。
    assert.doesNotMatch(
      code,
      /(^|[^\w.$])(const|let|var)\s+SKIP_FILE_PATTERNS\s*=/,
      `${file} 又出现了本地 SKIP_FILE_PATTERNS 定义`,
    )
    assert.doesNotMatch(
      code,
      /(^|[^\w.$])(const|let|var)\s+IGNORED_DIRS\s*=\s*new\s+Set/,
      `${file} 又出现了本地 IGNORED_DIRS 定义`,
    )
  }
})

test('共享模块自身只定义一次清单', () => {
  assert.ok(SKIP_FILE_PATTERNS.length > 0, 'SKIP_FILE_PATTERNS 不能为空')
  assert.ok(SCAN_IGNORED_DIRS.size > 0, 'SCAN_IGNORED_DIRS 不能为空')
  // 正则不能带 g/y,否则 .test() 会因 lastIndex 状态随机返回 false
  for (const re of SKIP_FILE_PATTERNS) {
    assert.ok(!re.global && !re.sticky, `跳过规则 ${re} 不能带 g/y 标志(会让 .test 有状态)`)
  }
})
