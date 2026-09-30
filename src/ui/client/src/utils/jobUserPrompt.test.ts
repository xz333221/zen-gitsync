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
import { userFacingPrompt } from './jobUserPrompt'

// 夹具的**结构**逐字来自真实 job（2026-09-30，job munuoabh-n33dan = 续聊第 3 轮、
// muns9o3i-at50rj = 首次执行轮），只把两块注入块的正文按省略号压短、把附件路径换成
// 通用路径 —— 这个函数依赖的锚点（首行前缀、`\n\n---\n\n` 分隔符、附件块与 `续接 #N`
// 的位置）全部保持原样。改了服务端的拼装格式，这里要跟着改。

const ENV_HEAD = '[运行环境 · 由 zen-gitsync 多项目编排台自动注入，不是用户输入的内容 · 续聊轮精简刷新，完整项目清单与用户偏好见本会话前文]\n\n当前任务所在项目（也是你的工作目录）: c:\\ws\\zen-gitsync\n\n看板任务概览：全部项目合计 80 条 —— 待处理 2 / 进行中 1 / 已完成 77，正在执行 1 个'
const MEM_BLOCK = '## 跨会话记忆库（本机）\n\n本机有一份长期经验库……\n\n- 全局索引：`C:\\Users\\me\\.zen-gitsync\\memory/INDEX.md`\n- **本项目索引：`…/projects/<slug>/INDEX.md`** ← 先读这个\n\n**怎么读（别烧 token）**：……'
const ATTS = '1. [image/png] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\a.png\n  2. [image/png] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\b.png'

/** 续聊轮：[环境块][记忆块][用户那句话 + 续接 #N][附件清单] */
const CONTINUE_PROMPT = `${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n这个skill是装到项目里，不是全局是么，为啥要装到.claude？我这个zen-gitsync并不依赖claude\n\n续接 #3\n\n---\n本任务包含 2 个附件（请按文件路径读取，不要让用户重新提供）：\n\n## 任务附件\n  ${ATTS}\n---`

/** 首次执行轮：环境块/记忆块同样是**完整**版，正文是「标题 + 描述」（见 promptParts.js） */
const FIRST_PROMPT = `${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n我的skill广场的skill安装是装到哪的\n\n顺便看看 MCP 装到哪\n\n---\n本任务包含 1 个附件（请按文件路径读取，不要让用户重新提供）：\n\n任务附件\n[image/png] C:\\Users\\me\\.zen-gitsync\\workbench-images\\_task-x\\c.png`

describe('userFacingPrompt', () => {
  it('续聊轮：只留用户那句话，环境块/记忆块/续接标记/附件清单全去掉', () => {
    expect(userFacingPrompt(CONTINUE_PROMPT))
      .toBe('这个skill是装到项目里，不是全局是么，为啥要装到.claude？我这个zen-gitsync并不依赖claude')
  })

  it('首次执行轮：只留标题/描述，注入块一样去掉', () => {
    expect(userFacingPrompt(FIRST_PROMPT)).toBe('我的skill广场的skill安装是装到哪的\n\n顺便看看 MCP 装到哪')
  })

  it('反向：原始 prompt 里确实带着环境块与记忆块（否则上面两条是空测试）', () => {
    expect(CONTINUE_PROMPT).toContain('[运行环境 ·')
    expect(CONTINUE_PROMPT).toContain('## 跨会话记忆库')
    expect(CONTINUE_PROMPT).toContain('本任务包含 2 个附件')
  })

  it('只裁首尾：用户自己粘进正文的注入块一个字符都不动', () => {
    const pasted = `${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n我测试好像还是有重复的\n${ENV_HEAD}\n\n拿这个举例大概是这样\n\n续接 #1\n\n---\n本任务包含 1 个附件（请按文件路径读取，不要让用户重新提供）：\n\n任务附件\n[image/png] C:\\a.png`
    const out = userFacingPrompt(pasted)
    expect(out.startsWith('我测试好像还是有重复的\n[运行环境 ·')).toBe(true)
    expect(out.endsWith('拿这个举例大概是这样')).toBe(true)
  })

  it('任务关掉 envContext / memoryContext 时，正文原样返回', () => {
    const plain = '帮我拉一下最新代码\n\n---\n本任务包含 1 个附件（请按文件路径读取，不要让用户重新提供）：\n\n任务附件\n[image/png] C:\\a.png'
    expect(userFacingPrompt(plain)).toBe('帮我拉一下最新代码')
    expect(userFacingPrompt('帮我拉一下最新代码')).toBe('帮我拉一下最新代码')
  })

  it('空值兜底（老 job / 没有 prompt 的记录）', () => {
    expect(userFacingPrompt(undefined)).toBe('')
    expect(userFacingPrompt('')).toBe('')
  })

  it('只有前导环境块、没有记忆块时不会多切一刀', () => {
    expect(userFacingPrompt(`${ENV_HEAD}\n\n---\n\n只说这一句`)).toBe('只说这一句')
  })

  it('正文里出现 `---` 分隔线不会被当成注入块边界', () => {
    const body = '第一段\n\n---\n\n第二段'
    expect(userFacingPrompt(`${ENV_HEAD}\n\n---\n\n${MEM_BLOCK}\n\n---\n\n${body}`)).toBe(body)
  })
})
