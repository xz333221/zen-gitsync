#!/usr/bin/env node
/**
 * 跨平台 test runner: 递归枚举 test/ + src/**\/ 下的 *.test.{mjs,js,ts} 文件,
 * 交给 node --test 运行。Windows + bash + zsh 都能跑通,避免 glob expansion 差异。
 *
 * 用法:
 *   node scripts/run-tests.cjs                 # 跑全部
 *   node scripts/run-tests.cjs --watch         # watch 模式
 *   node scripts/run-tests.cjs <glob>...       # 只跑匹配的文件(相对仓库根)
 *   node scripts/run-tests.cjs --list          # 列出找到的测试文件,不执行
 *
 * 退出码:
 *   0 = 全绿
 *   1 = 有失败用例
 *   2 = 找不到匹配文件 / 参数错误
 */
'use strict'
const { readdirSync, statSync } = require('fs')
const { join, relative, sep, resolve } = require('path')
const { spawn } = require('child_process')

const ROOT = join(__dirname, '..')
const SCAN_DIRS = [
  join(ROOT, 'test'),
  join(ROOT, 'src', 'utils'),
  join(ROOT, 'src', 'cli'),
  join(ROOT, 'src', 'ui', 'server'),
]
const PATTERNS = /\.(test|spec)\.(mjs|js|ts)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
      walk(p, acc)
    } else if (PATTERNS.test(name)) {
      acc.push(p)
    }
  }
  return acc
}

const argv = process.argv.slice(2)
const watch = argv.includes('--watch')
const listOnly = argv.includes('--list')
const filters = argv.filter(a => !a.startsWith('--'))

let files = SCAN_DIRS.flatMap(d => walk(d))
if (filters.length) {
  const wanted = filters.map(f => resolve(ROOT, f))
  files = files.filter(p => wanted.some(w => p === w || p.startsWith(w + sep) || p.includes(w)))
}

if (!files.length) {
  console.error('[run-tests] 未找到任何测试文件(检查 SCAN_DIRS / 过滤参数)')
  process.exit(2)
}

console.log(`[run-tests] 找到 ${files.length} 个测试文件:`)
files.forEach(f => console.log('  - ' + relative(ROOT, f).split(sep).join('/')))

if (listOnly) process.exit(0)

const args = ['--test', ...(watch ? ['--watch'] : []), ...files]
const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', code => {
  // node --test 退出码 0 = 全过,1 = 有失败。watch 模式被 Ctrl-C 时为 130。
  process.exit(code ?? 0)
})
child.on('error', err => {
  console.error('[run-tests] 启动 node --test 失败:', err.message)
  process.exit(2)
})