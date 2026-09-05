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
// findDshExecutable 回归测试(2026-09-05)
// 旧实现只查 %APPDATA%\npm + npm prefix -g,在 nvm4w 用户(全局包在
// C:\nvm4w\nodejs\) 上"未安装"误报。改用 where.exe dsh 优先后,这里守住
// "返回的路径必须真实存在"这条契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { findDshExecutable } from './fileOpen.js'

test('findDshExecutable: Windows 上返回 string 或 null,且非 null 时路径必须存在', async () => {
  const result = await findDshExecutable()
  if (process.platform !== 'win32') {
    // 非 win32 平台走 commandExists('dsh') 路径:要么是 'dsh'(which 命中),
    // 要么是 null。不强求特定值,只断言类型。
    assert.ok(result === null || typeof result === 'string')
    return
  }
  if (result !== null) {
    assert.equal(typeof result, 'string')
    // 核心契约:返回的路径必须真实存在且是文件。
    // 这正是这次修复要解决的:不允许再出现"返回看似合法但 fs.stat 不到的路径"
    // (旧实现里 APPDATA/npm/dsh.cmd + npm prefix -g 拼出的废地址都是 fs.stat 不到的)。
    const stat = await fs.stat(result)
    assert.equal(stat.isFile(), true, `${result} 不是文件`)
  }
})