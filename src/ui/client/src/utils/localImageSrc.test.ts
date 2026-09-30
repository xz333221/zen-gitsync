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
// 正文内嵌图片（localImageSrc.ts）单测。
//
// 这条链路只在"服务端端点 + 前端重写 + 组件库的 markdown 渲染"三件事同时成立时
// 才看得见图，而这层最容易出的错是**改多了**：把 http 链接、站内路径、代码围栏里的
// 示例一起改写掉。所以下面的用例一半在守"该转的转"，一半在守"不该动的一个字符都别动"。

import { describe, expect, test } from 'vitest'
import { isLocalImageSrc, jobImageUrl, resolveLocalImages } from './localImageSrc'

const JOB = 'mu1234abcd'
const url = (p: string) => `/api/workbench/jobs/${JOB}/image?path=${encodeURIComponent(p)}`

describe('isLocalImageSrc：只认"浏览器够不到的本机图片路径"', () => {
  test('本机路径（Windows 绝对 / 相对 / UNC / file:）判为真', () => {
    expect(isLocalImageSrc('c:\\ws\\repo\\docs\\a.png')).toBe(true)
    expect(isLocalImageSrc('C:/ws/repo/docs/a.PNG')).toBe(true)
    expect(isLocalImageSrc('docs/screenshots/a.jpg')).toBe(true)
    expect(isLocalImageSrc('\\\\nas\\share\\a.webp')).toBe(true)
    expect(isLocalImageSrc('file:///C:/ws/a.png')).toBe(true)
  })

  test('够得到的地址一律不动', () => {
    for (const src of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      'data:image/png;base64,AAAA',
      'blob:http://localhost/xyz',
      '//cdn.example.com/a.png',
      '/assets/a.png',
      '/api/workbench/attachments/x/raw'
    ]) {
      expect(isLocalImageSrc(src), src).toBe(false)
    }
  })

  test('后缀不在图片白名单里的不当图（`/api/foo/bar` 这类站内地址也因此被挡）', () => {
    for (const src of ['c:\\ws\\a.txt', 'c:\\ws\\a.md', 'docs/readme', 'c:\\ws\\a.png.bak']) {
      expect(isLocalImageSrc(src), src).toBe(false)
    }
  })
})

describe('resolveLocalImages：重写正文里的本机图片', () => {
  test('Windows 绝对路径 → 后端端点（路径整段编码，反斜杠不成问题）', () => {
    const out = resolveLocalImages('看这张：\n\n![浅色主题](c:\\ws\\repo\\docs\\screenshots\\a.png)\n', JOB)
    expect(out).toContain(`![浅色主题](${url('c:\\ws\\repo\\docs\\screenshots\\a.png')})`)
    expect(out).toContain('看这张：')
  })

  test('相对路径与 file:// 同样能转（模型常按 cwd 写相对路径）', () => {
    expect(resolveLocalImages('![a](docs/a.png)', JOB)).toBe(`![a](${url('docs/a.png')})`)
    expect(resolveLocalImages('![a](file:///C:/ws/a.png)', JOB)).toBe(`![a](${url('file:///C:/ws/a.png')})`)
  })

  test('尖括号包裹的路径（含空格）识别为地址，title 原样保留', () => {
    expect(resolveLocalImages('![a](<c:\\my dir\\a.png>)', JOB)).toBe(`![a](${url('c:\\my dir\\a.png')})`)
    expect(resolveLocalImages('![a](c:\\ws\\a.png "截图")', JOB)).toBe(`![a](${url('c:\\ws\\a.png')} "截图")`)
  })

  test('一行里的多张图都转', () => {
    const out = resolveLocalImages('![a](c:\\1.png) 和 ![b](c:\\2.png)', JOB)
    expect(out).toBe(`![a](${url('c:\\1.png')}) 和 ![b](${url('c:\\2.png')})`)
  })

  test('外部链接 / data URL / 站内路径一个都不动', () => {
    const text = [
      '![a](https://example.com/a.png)',
      '![b](data:image/png;base64,AAAA)',
      '![c](/assets/a.png)',
      '![d](/api/workbench/attachments/x/raw)'
    ].join('\n')
    expect(resolveLocalImages(text, JOB)).toBe(text)
  })

  test('代码围栏里的示例不动（模型爱用它贴"路径长这样"）', () => {
    const text = [
      '这样写就行：',
      '```markdown',
      '![说明](c:\\ws\\repo\\docs\\a.png)',
      '```',
      '',
      '![真图](c:\\ws\\repo\\docs\\b.png)'
    ].join('\n')
    const out = resolveLocalImages(text, JOB)
    // 围栏里原样，围栏外转掉
    expect(out).toContain('![说明](c:\\ws\\repo\\docs\\a.png)')
    expect(out).toContain(`![真图](${url('c:\\ws\\repo\\docs\\b.png')})`)
  })

  test('未闭合的围栏（流式输出到一半）同样不转，避免渲染中途闪出 URL', () => {
    const text = '```markdown\n![a](c:\\ws\\a.png)'
    expect(resolveLocalImages(text, JOB)).toBe(text)
  })

  test('普通链接（非图片语法）不碰 —— 那是给用户点的，转了就坏', () => {
    const text = '[打开截图](c:\\ws\\a.png)'
    expect(resolveLocalImages(text, JOB)).toBe(text)
  })

  test('没有 jobId 时不改：拼出来的端点必然 404，不如留着原路径让人看得见', () => {
    const text = '![a](c:\\ws\\a.png)'
    expect(resolveLocalImages(text, '')).toBe(text)
    expect(resolveLocalImages(text, null)).toBe(text)
    expect(resolveLocalImages(text, undefined)).toBe(text)
  })

  test('空文本 / 无图片语法的长文本原样返回（快路径）', () => {
    expect(resolveLocalImages('', JOB)).toBe('')
    expect(resolveLocalImages(undefined as unknown as string, JOB)).toBe('')
    const plain = '一句普通的回答，没有任何图片。\n第二行。'
    expect(resolveLocalImages(plain, JOB)).toBe(plain)
  })

  test('jobImageUrl 对 id 与路径都做编码（路径里的 & 不会截断查询串）', () => {
    expect(jobImageUrl('a b', 'c:\\x&y.png')).toBe('/api/workbench/jobs/a%20b/image?path=c%3A%5Cx%26y.png')
  })
})
