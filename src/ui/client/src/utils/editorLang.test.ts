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
// 语言映射的回归点：这几种扩展名在 Monaco 里曾经退化成了 plaintext ——
// 因为 MonacoEditor / MonacoDiffViewer 各自手写的那份 if 链只覆盖了 24 种，
// 而 editorLang 的表有 40+ 种。统一之后这些必须都能认出来。

import { describe, expect, test } from 'vitest'
import { getLanguageByExt, getLanguageFromPath } from './editorLang'

describe('getLanguageFromPath', () => {
  test.each([
    ['src/app.ts', 'typescript'],
    ['src/app.mjs', 'javascript'],
    ['config/settings.toml', 'ini'],
    ['db/schema.sql', 'sql'],
    ['src/Main.kt', 'kotlin'],
    ['lib/task.rb', 'ruby'],
    ['public/index.php', 'php'],
    ['src/native.c', 'c'],
    ['src/native.cc', 'cpp'],
    ['src/native.hpp', 'cpp'],
    ['assets/logo.svg', 'xml'],
    ['scripts/deploy.bash', 'shell'],
    ['api/schema.graphql', 'graphql'],
    ['README.md', 'markdown'],
    ['notes.txt', 'plaintext'],
  ])('%s → %s', (filePath, expected) => {
    expect(getLanguageFromPath(filePath)).toBe(expected)
  })

  test('大小写与无扩展名都不炸', () => {
    expect(getLanguageFromPath('SRC/APP.TS')).toBe('typescript')
    expect(getLanguageFromPath('Dockerfile')).toBe('plaintext')
    expect(getLanguageFromPath('')).toBe('plaintext')
    expect(getLanguageFromPath(undefined as unknown as string)).toBe('plaintext')
  })

  test('与 getLanguageByExt 同源', () => {
    expect(getLanguageByExt('toml')).toBe(getLanguageFromPath('a.toml'))
    expect(getLanguageByExt('sql')).toBe(getLanguageFromPath('a.sql'))
  })
})
