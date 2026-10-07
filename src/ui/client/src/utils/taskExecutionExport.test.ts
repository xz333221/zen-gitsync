// 「复制执行内容」导出文本的单测。
//
// 这里只测**拼装口径**，不测剪贴板（那是 WorkbenchView 的 copyToClipboard，已在别处覆盖）：
// 导出文本是用户会直接粘到别的地方去的东西，错的不是崩溃而是"悄悄多了一段/少了一段"。

import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lang/static', () => ({
  // 最简 i18n：剥掉命名空间前缀 + 具名插值。
  // zh 表里这些 key 的值就是"去掉前缀的 key 本身"，所以这样足够真实，
  // 断言里能直接读到渲染后的句子（而不是 `@WORKBENCH:第 {n} 轮`）。
  $t: (key: string, params?: Record<string, string | number>) => {
    const text = key.replace(/^@[A-Z0-9]+:/, '')
    return params
      ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), text)
      : text
  },
}))

import { buildTaskExecutionText, localStamp } from './taskExecutionExport'
import type { Job } from '@/types/workbench'

/** 全部时间用**本地时间构造**，断言与运行机器时区无关（同 relativeTime.test.ts） */
const localIso = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(y, mo - 1, d, h, mi).toISOString()

function job(partial: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    taskId: 't1',
    subId: 't1__simple',
    title: 't',
    status: 'done',
    output: '',
    pid: null,
    startedAt: localIso(2026, 9, 30, 14, 0),
    endedAt: null,
    exitCode: 0,
    error: null,
    ...partial,
  }
}

const NOW = new Date(2026, 8, 30, 14, 22)

describe('localStamp', () => {
  test('输出本地时间 YYYY-MM-DD HH:mm', () => {
    expect(localStamp(localIso(2026, 9, 30, 9, 5))).toBe('2026-09-30 09:05')
  })

  test('非法时间返回空串（宁可不写，也不要 NaN）', () => {
    expect(localStamp('not-a-date')).toBe('')
  })
})

describe('buildTaskExecutionText', () => {
  test('一轮完整内容：标题 / 项目 / 各分节按顺序出现', () => {
    const text = buildTaskExecutionText([
      job({ prompt: '把 README 补一下', thinking: '先看看现有内容', output: '已补好' }),
    ], { title: '补文档', projectName: 'zen-gitsync', now: NOW })

    expect(text).toBe([
      '# 补文档',
      '',
      '- 项目：zen-gitsync',
      '- 导出时间：2026-09-30 14:22',
      '',
      '---',
      '',
      '## 第 1 轮',
      '',
      '*Claude Code · 已完成 · 2026-09-30 14:00*',
      '',
      '### 用户提示词',
      '',
      '把 README 补一下',
      '',
      '### Claude 思考',
      '',
      '先看看现有内容',
      '',
      '### 模型返回',
      '',
      '已补好',
      '',
    ].join('\n'))
  })

  test('注入块被剥掉：导出的是用户原话，不是整段注入过的 prompt', () => {
    const prompt = [
      '[运行环境 · 由 zen-gitsync 多项目编排台自动注入，不是用户输入的内容]',
      '',
      '当前任务所在项目: zen-gitsync',
      '',
      '---',
      '',
      '## 跨会话记忆库',
      '',
      '索引在 ~/.zen-gitsync/memory/INDEX.md',
      '',
      '---',
      '',
      '帮我看下这个报错',
      '',
      '---',
      '本任务包含 1 个附件（请按文件路径读取，不要让用户重新提供）：',
      '',
      '  1. [image/png] C:\\tmp\\a.png',
      '',
      '续接 #3',
    ].join('\n')

    const text = buildTaskExecutionText([job({ prompt })], { title: 'T', now: NOW })

    expect(text).toContain('帮我看下这个报错')
    // 三块注入内容一个都不能漏出去 —— 导出的文本是用户会粘回续聊框的上游
    expect(text).not.toContain('[运行环境 ·')
    expect(text).not.toContain('跨会话记忆库')
    expect(text).not.toContain('本任务包含 1 个附件')
    expect(text).not.toContain('续接 #3')
  })

  test('模型一句话没说、只调了工具时照样导出（否则这一轮整段消失）', () => {
    const text = buildTaskExecutionText([
      job({
        output: '',
        thinking: '',
        toolCalls: [
          { id: 'a', name: 'Bash', argsPreview: 'ls -la', result: 'a.js\nb.js', status: 'done' },
        ],
      }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('### 工具调用')
    expect(text).toContain('1. **Bash** — `ls -la`')
    expect(text).toContain('a.js\nb.js')
    expect(text).not.toContain('### 模型返回')
  })

  test('工具出错的调用给 error，不给空 result', () => {
    const text = buildTaskExecutionText([
      job({
        output: '放弃了',
        toolCalls: [
          { id: 'a', name: 'Read', argsPreview: 'src/missing.ts', status: 'error', error: 'File does not exist.' },
        ],
      }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('File does not exist.')
  })

  test('结果里带 ``` 时围栏加长，粘出去不会被从中间截断', () => {
    const text = buildTaskExecutionText([
      job({
        output: '看这里',
        toolCalls: [
          { id: 'a', name: 'Bash', argsPreview: 'cat x.md', result: '```js\nconst a = 1\n```', status: 'done' },
        ],
      }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('````\n```js\nconst a = 1\n```\n````')
  })

  test('多轮之间用 --- 分隔，且轮次号按原始顺序（空轮次不留标题也不重编号）', () => {
    const text = buildTaskExecutionText([
      job({ id: 'j1', prompt: '第一轮', output: '好的' }),
      // 排了队就被取消的一轮：一个字都没有 → 不导出，但也不该让它后面的"第 3 轮"变成"第 2 轮"
      job({ id: 'j2', status: 'cancelled', prompt: '', output: '', thinking: '' }),
      job({ id: 'j3', prompt: '第三轮', output: '又是好的', startedAt: localIso(2026, 9, 30, 14, 10) }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('## 第 1 轮')
    expect(text).toContain('## 第 3 轮')
    expect(text).not.toContain('## 第 2 轮')
    // 头部后一条 + 两轮之间一条
    expect(text.match(/^---$/gm)?.length).toBe(2)
  })

  test('一轮内容都没有时返回空串（调用方据此提示"暂无执行内容"）', () => {
    expect(buildTaskExecutionText([], { title: 'T', now: NOW })).toBe('')
    expect(buildTaskExecutionText([job({ prompt: '', output: '', thinking: '' })], { title: 'T', now: NOW })).toBe('')
  })

  test('任务没有标题时回落「未命名任务」；没有项目时不写项目行', () => {
    const text = buildTaskExecutionText([job({ output: 'x' })], { title: '   ', now: NOW })
    expect(text.startsWith('# 未命名任务\n')).toBe(true)
    expect(text).not.toContain('- 项目：')
  })

  test('协议层失败（exitCode 0 但 agentError 有值）单列「出错」一节', () => {
    const text = buildTaskExecutionText([
      job({ status: 'error', agentError: 'turn.failed: rate limited', output: '' }),
    ], { title: 'T', now: NOW })

    expect(text).toContain('### 出错')
    expect(text).toContain('turn.failed: rate limited')
  })

  test('brief 范围：去掉思考与工具调用，只留提示词 + 模型回复', () => {
    const jobs = [job({
      prompt: '改一下',
      thinking: '先看看现有实现',
      output: '改好了',
      toolCalls: [{ id: 'a', name: 'Bash', argsPreview: 'ls -la', result: 'a.js', status: 'done' }],
    })]
    const full = buildTaskExecutionText(jobs, { title: 'T', now: NOW })
    const brief = buildTaskExecutionText(jobs, { title: 'T', now: NOW }, { scope: 'brief' })

    // 默认（full）仍然带思考 / 工具调用 —— 老行为不能被 brief 顺手改掉
    expect(full).toContain('### Claude 思考')
    expect(full).toContain('### 工具调用')

    expect(brief).toContain('### 用户提示词')
    expect(brief).toContain('### 模型返回')
    expect(brief).not.toContain('### Claude 思考')
    expect(brief).not.toContain('### 工具调用')
    expect(brief.length).toBeLessThan(full.length)
  })

  test('brief 范围下「出错」仍保留（否则只失败没正文的一轮会整轮消失）', () => {
    const brief = buildTaskExecutionText([
      job({ status: 'error', prompt: '', output: '', thinking: '', agentError: 'turn.failed: rate limited' }),
    ], { title: 'T', now: NOW }, { scope: 'brief' })

    expect(brief).toContain('### 出错')
    expect(brief).toContain('turn.failed: rate limited')
  })
})
