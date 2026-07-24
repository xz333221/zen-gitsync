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
// src/cli/ai/images.js 单元测试。
// 不覆盖 readClipboardImage(依赖真实剪贴板与平台工具,CI 上不可控),
// 只测纯函数与本地文件逻辑。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatBytes, checkImageFile, imageToDataUrl } from './images.js'

// 最小合法 PNG(1x1 透明像素),base64 编码共 68 字节
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('formatBytes: B / KB / MB 三档', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(undefined), '0 B')
})

test('checkImageFile: 不存在的路径返回 null', async () => {
  assert.equal(await checkImageFile(path.join(os.tmpdir(), 'g-ai-no-such-file.png')), null)
})

test('checkImageFile: 不支持的扩展名返回 null', async () => {
  const f = path.join(os.tmpdir(), `g-ai-test-${Date.now()}.txt`)
  await fsp.writeFile(f, 'hello')
  try {
    assert.equal(await checkImageFile(f), null)
  } finally {
    await fsp.unlink(f)
  }
})

test('checkImageFile: 合法 PNG 返回路径与字节数', async () => {
  const f = path.join(os.tmpdir(), `g-ai-test-${Date.now()}.png`)
  const pngBuf = Buffer.from(PNG_1X1_B64, 'base64')
  await fsp.writeFile(f, pngBuf)
  try {
    const r = await checkImageFile(f)
    assert.ok(r, '应识别 PNG')
    assert.equal(r.path, f)
    assert.equal(r.bytes, pngBuf.length)
  } finally {
    await fsp.unlink(f)
  }
})

test('checkImageFile: 空文件返回 null', async () => {
  const f = path.join(os.tmpdir(), `g-ai-test-empty-${Date.now()}.png`)
  await fsp.writeFile(f, '')
  try {
    assert.equal(await checkImageFile(f), null)
  } finally {
    await fsp.unlink(f)
  }
})

test('imageToDataUrl: 生成 data URL 且 base64 内容可还原', async () => {
  const f = path.join(os.tmpdir(), `g-ai-test-du-${Date.now()}.png`)
  const original = Buffer.from(PNG_1X1_B64, 'base64')
  await fsp.writeFile(f, original)
  try {
    const url = await imageToDataUrl(f)
    assert.ok(url.startsWith('data:image/png;base64,'), `应为 png data URL,实际前缀: ${url.slice(0, 30)}`)
    const b64 = url.slice('data:image/png;base64,'.length)
    assert.ok(Buffer.from(b64, 'base64').equals(original), 'base64 应能还原原文件')
  } finally {
    await fsp.unlink(f)
  }
})

test('imageToDataUrl: jpg 扩展名映射到 image/jpeg', async () => {
  const f = path.join(os.tmpdir(), `g-ai-test-du-${Date.now()}.jpg`)
  await fsp.writeFile(f, Buffer.from('fake-jpeg-bytes'))
  try {
    const url = await imageToDataUrl(f)
    assert.ok(url.startsWith('data:image/jpeg;base64,'))
  } finally {
    await fsp.unlink(f)
  }
})
