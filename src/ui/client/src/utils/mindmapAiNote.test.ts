// 思维导图视图的 AI 上下文说明（面板与 dock 共用）—— 纯函数，锁住两条分支：
// 带不带 ```mindmap 输出约定，决定了模型会不会吐一个 dock 消费不了的代码块。
import { describe, expect, it } from 'vitest'
import { buildMindmapAiNote } from './mindmapAiNote'

describe('buildMindmapAiNote', () => {
  it('带输出约定（导图页面板用）：交代 mindmap 块怎么给', () => {
    const note = buildMindmapAiNote('D:/maps/demo.mindmap.json', 'zh-CN', { withConvention: true })
    expect(note).toContain('思维导图')
    expect(note).toContain('D:/maps/demo.mindmap.json')
    expect(note).toContain('```mindmap')
    expect(note).toContain('应用到当前导图')
  })

  it('不带输出约定（dock 用）：有文件说明、但没有 mindmap 块要求', () => {
    const note = buildMindmapAiNote('D:/maps/demo.mindmap.json', 'zh-CN', { withConvention: false })
    expect(note).toContain('D:/maps/demo.mindmap.json')
    expect(note).not.toContain('```mindmap')
  })

  it('没有打开文件时也交代"当前没有导图"', () => {
    const note = buildMindmapAiNote(null, 'zh-CN', { withConvention: false })
    expect(note).toContain('当前没有打开任何导图文件')
  })

  it('英文环境走英文文案', () => {
    const note = buildMindmapAiNote('D:/maps/demo.mindmap.json', 'en-US', { withConvention: true })
    expect(note).toContain('mind map')
    expect(note).not.toContain('思维导图')
  })
})
