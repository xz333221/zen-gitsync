// 测试 runner 自己的守卫：并发上限被谁顺手删掉，npm test 会重新变回「跑不完」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(path.join(ROOT, 'scripts', 'run-tests.cjs'), 'utf8')

// 注释里也会出现 --test-concurrency 这个词，先剥掉再断言，否则删了实现也能假绿。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function hasBoundedConcurrency(src) {
  const code = stripComments(src)
  return /--test-concurrency=\$\{CONCURRENCY\}/.test(code)
    && /process\.env\.ZEN_TEST_CONCURRENCY/.test(code)
    && /Math\.max\(1,/.test(code)
}

test('runner 必须给 node --test 传并发上限，且允许用环境变量覆盖', () => {
  assert.equal(hasBoundedConcurrency(SOURCE), true,
    'scripts/run-tests.cjs 缺少 --test-concurrency / ZEN_TEST_CONCURRENCY')
})

test('反样本：注释里写了并发上限、实际 spawn 参数没有，也必须判红', () => {
  const tampered = [
    '// --test-concurrency=${CONCURRENCY}',
    "const args = ['--test', ...files]",
    'const child = spawn(process.execPath, args, { stdio: "inherit" })',
  ].join('\n')
  assert.equal(hasBoundedConcurrency(tampered), false)
})

test('默认并发落在安全区间内（32 核机器上 31 路会挂死）', () => {
  const code = stripComments(SOURCE)
  const match = code.match(/Number\(process\.env\.ZEN_TEST_CONCURRENCY\)\s*\|\|\s*(\d+)/)
  assert.ok(match, '找不到默认并发值')
  const value = Number(match[1])
  assert.ok(value >= 1 && value <= 8, `默认并发 ${value} 超出安全区间 1..8`)
})
