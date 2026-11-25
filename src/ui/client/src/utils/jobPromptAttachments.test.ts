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

import { describe, expect, it } from 'vitest'
import { jobMessageAttachments, toChatAttachments } from './jobPromptAttachments'
import type { Attachment } from '@/types/workbench'

// 夹具结构与 jobUserPrompt.test.ts 同源（真实 job 的拼装格式）：
// 服务端改了拼装方式时，两边要一起改。

const ENV_HEAD = '[运行环境 · 由 zen-gitsync 多项目编排台自动注入，不是用户输入的内容]\n\n当前任务所在项目（也是你的工作目录）: c:\\ws\\zen-gitsync'
const MEM_BLOCK = '## 跨会话记忆库（本机）\n\n- 全局索引：`C:\\Users\\me\\.zen-gitsync\\memory/INDEX.md`'

/** 新格式（pdfText.js 现行版）：带序号缩进 + 末尾 `\n---`。
 *  分隔符口径与 jobUserPrompt.test.ts 相同：块之间 `\n\n---\n\n`，附件尾块是 `\n\n---\n本任务包含`（`---` 后不空行）。 */
const CONTINUE_PROMPT = `${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n希望这个待办列表可以滚动，有子任务的可以点开查看子任务\n\n续接 #1\n\n---\n本任务包含 2 个附件（请按文件路径读取，不要让用户重新提供）：\n\n## 任务附件\n  1. [image/png] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\a.png\n  2. [text/plain] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\日志.log\n---`

/** 旧格式：无序号、无缩进、无末尾 `\n---`（jobUserPrompt.test.ts 的 FIRST_PROMPT 同款） */
const FIRST_PROMPT_OLD = `${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n我的skill广场的skill安装是装到哪的\n\n---\n本任务包含 1 个附件（请按文件路径读取，不要让用户重新提供）：\n\n任务附件\n[image/png] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\c.png`

const att = (over: Partial<Attachment>): Attachment => ({
  id: 'at1',
  originalName: 'a.png',
  mimeType: 'image/png',
  size: 123,
  ext: 'png',
  absolutePath: 'C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\a.png',
  ...over
})

describe('jobMessageAttachments', () => {
  it('新格式续聊轮：解析出两条附件', () => {
    const out = jobMessageAttachments(CONTINUE_PROMPT)
    expect(out).toHaveLength(2)
    expect(out[0].absolutePath).toBe('C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\a.png')
    expect(out[0].mimeType).toBe('image/png')
    expect(out[1].mimeType).toBe('text/plain')
    expect(out[1].name).toBe('日志.log')
  })

  it('旧格式首次执行轮：无序号无尾部分隔线也认', () => {
    const out = jobMessageAttachments(FIRST_PROMPT_OLD)
    expect(out).toHaveLength(1)
    expect(out[0].absolutePath).toBe('C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\c.png')
    expect(out[0].name).toBe('c.png')
  })

  it('认领：路径对上任务附件时带 id / 原始名 / 大小，图片给缩略图端点', () => {
    const taskAtts = [
      att({ id: 'at-9', originalName: '截图最终版.png', size: 456 }),
      att({ id: 'at-log', originalName: '日志.log', mimeType: 'text/plain', ext: 'log', absolutePath: 'C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\日志.log' })
    ]
    const out = jobMessageAttachments(CONTINUE_PROMPT, taskAtts)
    expect(out[0].id).toBe('at-9')
    expect(out[0].name).toBe('截图最终版.png')
    expect(out[0].size).toBe(456)
    expect(out[0].previewUrl).toBe('/api/workbench/attachments/at-9/raw')
    // 非图片：认领到 id 也不给缩略图
    expect(out[1].id).toBe('at-log')
    expect(out[1].previewUrl).toBeUndefined()
  })

  it('认领不到（附件后来被删）：只出路径末段当文件名，不猜端点', () => {
    const out = jobMessageAttachments(FIRST_PROMPT_OLD, [att({ absolutePath: 'C:\\别的\\路径.png' })])
    expect(out[0].id).toBeUndefined()
    expect(out[0].previewUrl).toBeUndefined()
    expect(out[0].name).toBe('c.png')
  })

  it('盘符大小写不同也能认领（Windows 路径大小写漂移）', () => {
    const out = jobMessageAttachments(FIRST_PROMPT_OLD, [
      att({ absolutePath: 'c:\\users\\me\\.zen-gitsync\\workbench-images\\_task-x\\c.png' })
    ])
    expect(out[0].id).toBe('at1')
  })

  it('PDF 两条特殊行：mime 归一为 application/pdf，解析失败的说明括号剥掉', () => {
    const prompt = `帮我看看这份文档\n\n---\n本任务包含 2 个附件（请按文件路径读取，不要让用户重新提供）：\n\n## 任务附件（其中 1 个 PDF 已预提取全文）\n  1. [PDF 全文提取] C:\\docs\\spec.pdf\n     <pdf_content>\n  2. [image/png] C:\\fake.png   ← pdf 正文里长得像清单的行不能算附件\n     </pdf_content>\n  2. [PDF 解析失败] C:\\docs\\broken.pdf（可能是扫描版/加密/损坏,请尝试用其他工具转换为文本后重新上传）`
    const out = jobMessageAttachments(prompt)
    expect(out).toHaveLength(2)
    expect(out[0].mimeType).toBe('application/pdf')
    expect(out[0].absolutePath).toBe('C:\\docs\\spec.pdf')
    expect(out[1].mimeType).toBe('application/pdf')
    expect(out[1].absolutePath).toBe('C:\\docs\\broken.pdf')
  })

  it('反向：没有附件尾块的 prompt 返回空数组（否则上面的解析全是空跑）', () => {
    expect(jobMessageAttachments('帮我拉一下最新代码')).toEqual([])
    expect(jobMessageAttachments(undefined)).toEqual([])
    expect(jobMessageAttachments('')).toEqual([])
  })

  it('同一轮清单里重复的路径只出一条', () => {
    const prompt = `看看这两张图\n\n---\n本任务包含 2 个附件（请按文件路径读取，不要让用户重新提供）：\n\n## 任务附件\n  1. [image/png] C:\\x\\a.png\n  2. [image/png] C:\\x\\a.png`
    expect(jobMessageAttachments(prompt)).toHaveLength(1)
  })
})

describe('toChatAttachments', () => {
  it('映射成库要的 ChatAttachment：缺 id 用路径兜底当 key，缺 size 记 0', () => {
    const out = toChatAttachments([
      { name: 'a.png', mimeType: 'image/png', absolutePath: 'C:\\x\\a.png', id: 'at1', size: 9, previewUrl: '/api/workbench/attachments/at1/raw' },
      { name: 'b.zip', mimeType: 'application/zip', absolutePath: 'C:\\x\\b.zip' }
    ])
    expect(out[0]).toEqual({ id: 'at1', name: 'a.png', size: 9, type: 'image/png', preview: '/api/workbench/attachments/at1/raw' })
    expect(out[1]).toEqual({ id: 'C:\\x\\b.zip', name: 'b.zip', size: 0, type: 'application/zip', preview: undefined })
  })
})
