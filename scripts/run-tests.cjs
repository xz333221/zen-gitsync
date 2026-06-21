#!/usr/bin/env node
/**
 * 跨平台 test runner: 递归枚举 test/ + src/**\/ 下的 *.test.{mjs,js,ts} 文件,
 * 交给 node --test 运行。Windows + bash + zsh 都能跑通,避免 glob expansion 差异。
 *
 * 用法:
 *   node scripts/run-tests.cjs           # 跑全部
 *   node scripts/run-tests.cjs --watch   # watch 模式
 */
'use strict'
const { readdirSync, statSync } = require('fs')
const { join, relative, sep } = require('path')

const ROOT = join(__dirname, '..')
const SCAN_DIRS = [
  join(ROOT, 'test'),
  join(ROOT, 'src', 'utils'),
  join(ROOT, 'src', 'ui', 'server'),
]
const PATTERNS = /\.(test|spec)\.(mjs|js|ts)$/

function walk(dir, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch (e) {
    return acc
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      walk(p, acc)
    } else if (PATTERNS.test(name)) {
      acc.push(p)
    }
  }
  return acc
}

const files = SCAN_DIRS.flatMap(d => walk(d))
if (!files.length) {
  console.log('[run-tests] 未找到任何测试文件')
  process.exit(0)
}

console.log(`[run-tests] 找到 ${files.length} 个测试文件:`)
files.forEach(f => console.log('  - ' + relative(ROOT, f).split(sep).join('/')))

const watch = process.argv.includes('--watch')
const args = ['--test', ...(watch ? ['--watch'] : []), ...files]
const { spawn } = require('child_process')
const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))