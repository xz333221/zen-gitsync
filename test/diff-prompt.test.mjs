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
// 测试: AI 生成提交信息时, diff 压缩与产物过滤逻辑
// 运行: node --test test/diff-prompt.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareDiffForPrompt,
  parseDiffByFile,
  isSkippedFile,
  filePriority,
  collectDiffForAi
} from '../src/ui/server/routes/config.js'

// 构造一个像样的 git diff 片段
function makeFileDiff(path, added, removed) {
  const addedLines = added.map(l => `+${l}`).join('\n')
  const removedLines = removed.map(l => `-${l}`).join('\n')
  return `diff --git a/${path} b/${path}
index 0000..1111 100644
--- a/${path}
+++ b/${path}
@@ -1,${removed.length} +1,${added.length} @@
${removedLines}
${addedLines}`
}

test('parseDiffByFile: 拆出每个文件的 path / added / removed', () => {
  const diff = [
    makeFileDiff('src/foo.ts', ['const a = 1', 'const b = 2'], ['const a = 0']),
    makeFileDiff('src/bar.ts', ['const x = 1'], ['const x = 0', 'const y = 0'])
  ].join('\n')

  const files = parseDiffByFile(diff)
  assert.equal(files.length, 2)
  assert.equal(files[0].path, 'src/foo.ts')
  assert.equal(files[0].added, 2)
  assert.equal(files[0].removed, 1)
  assert.equal(files[1].path, 'src/bar.ts')
  assert.equal(files[1].added, 1)
  assert.equal(files[1].removed, 2)
})

test('isSkippedFile: 产物/lock/二进制全部识别', () => {
  assert.ok(isSkippedFile('dist/bundle.js'))
  assert.ok(isSkippedFile('build/static/main.js'))
  assert.ok(isSkippedFile('package-lock.json'))
  assert.ok(isSkippedFile('yarn.lock'))
  assert.ok(isSkippedFile('src/assets/logo.png'))
  assert.ok(isSkippedFile('public/fonts/inter.woff2'))
  assert.ok(isSkippedFile('a/b/c.min.js'))
  assert.ok(isSkippedFile('a/b/c.map'))
  // 源码不应被跳过
  assert.ok(!isSkippedFile('src/index.ts'))
  assert.ok(!isSkippedFile('README.md'))
})

test('filePriority: 后端 > 前端 > 配置 > 文档 > 测试', () => {
  assert.ok(filePriority('src/server.ts') > filePriority('src/App.vue'))
  assert.ok(filePriority('src/App.vue') > filePriority('config.json'))
  assert.ok(filePriority('config.json') > filePriority('README.md'))
  assert.ok(filePriority('README.md') > filePriority('src/foo.test.ts'))
})

test('prepareDiffForPrompt: 大 bundle 文件被压缩成一行 stat', () => {
  // 模拟一个巨大的 bundle 改动
  const hugeAdded = Array.from({ length: 5000 }, (_, i) => `var x${i}=${i}`).join('\n')
  const diff = makeFileDiff('dist/bundle.js', [hugeAdded], [])
  const out = prepareDiffForPrompt(diff, ['M dist/bundle.js'])
  // 不应包含 patch 细节, 只应有一行 stat 总结
  assert.ok(out.includes('dist/bundle.js'), '文件名应保留')
  assert.ok(out.includes('已跳过产物/资源'), '应标记为跳过')
  assert.ok(!out.includes('var x100='), 'patch 内容不应出现')
})

test('prepareDiffForPrompt: 多文件混合, 产物跳过 + 源码保留', () => {
  const diff = [
    makeFileDiff('dist/bundle.js', Array.from({ length: 1000 }, (_, i) => `var a${i}`), []),
    makeFileDiff('src/server.ts', ['function foo() {', '  return 42', '}'], []),
    makeFileDiff('package-lock.json', ['# lock change'], ['# lock old'])
  ].join('\n')
  const out = prepareDiffForPrompt(diff, [])

  assert.ok(out.includes('dist/bundle.js'), 'bundle 应被提到')
  assert.ok(out.includes('已跳过'), 'bundle 应被标记跳过')
  assert.ok(out.includes('package-lock.json'), 'lock 文件应被提到')
  assert.ok(out.includes('src/server.ts'), '源码文件应保留')
  assert.ok(out.includes('function foo'), '源码 patch 应保留')
})

test('prepareDiffForPrompt: 总预算 6000 字符封顶', () => {
  // 构造 5 个文件, 每个 patch 2000 字符
  const diff = Array.from({ length: 5 }, (_, i) => {
    const lines = Array.from({ length: 100 }, (_, j) => `const v${i}_${j} = ${j};`)
    return makeFileDiff(`src/file${i}.ts`, lines, lines)
  }).join('\n')
  const out = prepareDiffForPrompt(diff, [])
  // 输出不应远超预算(允许一些 stat 头部 + 文件名)
  assert.ok(out.length < 6500, `输出 ${out.length} 字符, 应 < 6500`)
})

test('prepareDiffForPrompt: 单文件超长 patch 被截断', () => {
  const longPatch = Array.from({ length: 500 }, (_, i) => `+line_${i}_${'x'.repeat(20)}`).join('\n')
  const diff = makeFileDiff('src/big.ts', [longPatch], [])
  const out = prepareDiffForPrompt(diff, [])
  assert.ok(out.includes('[截断]'), '应标记截断')
  assert.ok(!out.includes('x'.repeat(50)), '完整 patch 不应出现')
})

test('prepareDiffForPrompt: 空 diff 走 fileList 推断', () => {
  const out = prepareDiffForPrompt('', ['M src/foo.ts', 'A src/bar.ts', 'M dist/bundle.js'])
  assert.ok(out.includes('src/foo.ts'))
  assert.ok(out.includes('src/bar.ts'))
  assert.ok(out.includes('dist/bundle.js'))
  assert.ok(out.includes('已跳过'), '产物应标记')
})

test('prepareDiffForPrompt: diff 和 fileList 都空, 返回空串', () => {
  assert.equal(prepareDiffForPrompt('', []), '')
  assert.equal(prepareDiffForPrompt('', null), '')
  assert.equal(prepareDiffForPrompt(undefined, []), '')
})

test('prepareDiffForPrompt: 按优先级排序, 源码文件先出现', () => {
  // README 和 server.ts 都改了, server.ts 应排在前面
  const diff = [
    makeFileDiff('README.md', ['# new readme'], []),
    makeFileDiff('src/server.ts', ['export const x = 1'], [])
  ].join('\n')
  const out = prepareDiffForPrompt(diff, [])
  const serverIdx = out.indexOf('src/server.ts')
  const readmeIdx = out.indexOf('README.md')
  assert.ok(serverIdx > 0 && readmeIdx > 0, '两个文件都应出现')
  assert.ok(serverIdx < readmeIdx, `server.ts(${serverIdx}) 应在 README.md(${readmeIdx}) 之前`)
})

// ============ collectDiffForAi 集成测试 ============

// Mock 一个 execGitCommand,模拟真实 git 输出
function makeMockGit(handlers) {
  return async (cmd) => {
    for (const [pattern, fn] of handlers) {
      if (pattern.test(cmd)) {
        return { stdout: fn(cmd) }
      }
    }
    return { stdout: '' }
  }
}

test('collectDiffForAi: 解析 untracked + modified 的 porcelain 状态', async () => {
  // 模拟 git status 输出: 一个 modified, 一个 untracked
  const statusOut = [
    ' M src/index.ts',       // 工作区有修改
    '?? test/new-file.test.ts'  // 未跟踪
  ].join('\n')

  const stagedOut = [
    'diff --git a/src/index.ts b/src/index.ts',
    'index 0000..1111 100644',
    '--- a/src/index.ts',
    '+++ b/src/index.ts',
    '@@ -1,3 +1,3 @@',
    '-const a = 1',
    '+const a = 2'
  ].join('\n')

  const mockExec = makeMockGit([
    [/status --porcelain/, () => statusOut],
    [/git add -N/, () => ''],
    [/git diff --staged/, () => stagedOut],
    [/git diff$/, () => '']
  ])

  const { diff, fileList } = await collectDiffForAi({
    execGitCommand: mockExec,
    getCurrentProjectPath: () => '/fake/path'
  })

  assert.equal(fileList.length, 2, '应识别 2 个文件')
  assert.ok(fileList.some(s => s.includes('src/index.ts')), 'modified 文件应出现')
  assert.ok(fileList.some(s => s.includes('test/new-file.test.ts')), 'untracked 文件应出现')
  assert.ok(diff.includes('diff --git a/src/index.ts'), 'diff 应包含 src/index.ts')
})

test('collectDiffForAi: 空仓库状态返回空值', async () => {
  const mockExec = makeMockGit([
    [/status --porcelain/, () => ''],
    [/git diff/, () => '']
  ])
  const { diff, fileList } = await collectDiffForAi({
    execGitCommand: mockExec,
    getCurrentProjectPath: () => '/fake'
  })
  assert.equal(diff, '')
  assert.deepEqual(fileList, [])
})

test('collectDiffForAi: untracked 批量添加且路径含空格', async () => {
  let addNCalled = 0
  const mockExec = async (cmd) => {
    if (/status --porcelain/.test(cmd)) {
      return { stdout: '?? "my file with spaces.ts"\n?? test/normal.ts' }
    }
    if (/git add -N/.test(cmd)) {
      addNCalled++
      // 验证引号转义存在
      assert.ok(cmd.includes('\\"'), '空格路径应被转义')
      return { stdout: '' }
    }
    return { stdout: '' }
  }

  await collectDiffForAi({
    execGitCommand: mockExec,
    getCurrentProjectPath: () => '/fake'
  })
  assert.ok(addNCalled >= 1, '应至少调用一次 git add -N')
})

test('collectDiffForAi: 同时合并 staged 和 unstaged diff', async () => {
  const mockExec = async (cmd) => {
    if (/status --porcelain/.test(cmd)) {
      return { stdout: 'MM src/foo.ts\n M src/bar.ts' }
    }
    if (/git diff --staged/.test(cmd)) {
      return { stdout: 'diff --git a/src/foo.ts b/src/foo.ts\n-index\n+index staged change' }
    }
    if (/git diff --no-color/.test(cmd)) {
      return { stdout: 'diff --git a/src/bar.ts b/src/bar.ts\n-bar\n+baz unstaged' }
    }
    return { stdout: '' }
  }

  const { diff } = await collectDiffForAi({
    execGitCommand: mockExec,
    getCurrentProjectPath: () => '/fake'
  })

  assert.ok(diff.includes('staged change'), 'staged diff 应包含')
  assert.ok(diff.includes('unstaged'), 'unstaged diff 应包含')
})

test('collectDiffForAi: execGitCommand 缺失时优雅降级', async () => {
  const { diff, fileList } = await collectDiffForAi({
    execGitCommand: null,
    getCurrentProjectPath: () => '/fake'
  })
  assert.equal(diff, '')
  assert.deepEqual(fileList, [])
})

// ============ 解析 untracked 文件的 diff 块 ============

test('parseDiffByFile: 解析含 new file 标记的 untracked diff', () => {
  // 模拟 git add -N 之后的 diff 输出(空内容但带 new file mode)
  const newFileDiff = [
    'diff --git a/test/new-file.test.ts b/test/new-file.test.ts',
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    '+++ b/test/new-file.test.ts',
    '@@ -0,0 +1,0 @@'
  ].join('\n')

  const files = parseDiffByFile(newFileDiff)
  assert.equal(files.length, 1)
  assert.equal(files[0].path, 'test/new-file.test.ts')
  assert.equal(files[0].added, 0)
  assert.equal(files[0].removed, 0)
})

test('prepareDiffForPrompt: untracked 新文件 + 源码修改混合', () => {
  // 模拟 git 真实输出: 一个空 new-file + 一个有 patch 的修改
  const newFileBlock = [
    'diff --git a/test/new.test.ts b/test/new.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/test/new.test.ts',
    '@@ -0,0 +0,0 @@'
  ].join('\n')

  const modifiedBlock = [
    'diff --git a/src/server.ts b/src/server.ts',
    '--- a/src/server.ts',
    '+++ b/src/server.ts',
    '@@ -1 +1 @@',
    '-const port = 3000',
    '+const port = 4000'
  ].join('\n')

  const combined = [newFileBlock, modifiedBlock].join('\n')
  const fileList = ['?? test/new.test.ts', ' M src/server.ts']

  const out = prepareDiffForPrompt(combined, fileList)

  assert.ok(out.includes('test/new.test.ts'), 'untracked 文件路径应出现')
  assert.ok(out.includes('src/server.ts'), 'modified 文件路径应出现')

  assert.ok(out.includes('const port = 4000'), 'modified patch should be preserved')
})
