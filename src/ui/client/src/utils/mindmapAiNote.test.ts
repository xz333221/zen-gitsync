// 思维导图视图的 AI 上下文说明（右下角 dock 用）—— 纯函数：
// 交代"在导图视图 + 当前文件是哪个"，不含任何输出约定（没人消费 ```mindmap 块）。
import { describe, expect, it } from 'vitest'
import { buildMindmapAiNote } from './mindmapAiNote'

describe('buildMindmapAiNote', () => {
  it('带上当前打开的导图路径', () => {
    const note = buildMindmapAiNote('D:/maps/demo.mindmap.json', 'zh-CN')
    expect(note).toContain('思维导图')
    expect(note).toContain('D:/maps/demo.mindmap.json')
    expect(note).not.toContain('```mindmap')
  })

  it('没有打开文件时也交代"当前没有导图"', () => {
    const note = buildMindmapAiNote(null, 'zh-CN')
    expect(note).toContain('当前没有打开任何导图文件')
  })

  it('英文环境走英文文案', () => {
    const note = buildMindmapAiNote('D:/maps/demo.mindmap.json', 'en-US')
    expect(note).toContain('mind map')
    expect(note).not.toContain('思维导图')
  })
})
