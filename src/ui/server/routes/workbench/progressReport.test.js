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
// 进度报告纯函数单测。
//
// 断言重心在**喂给模型的东西**上 —— 报告正文是模型写的，没法断言；
// 能保证的是"送进去的事实是对的"：只挑在跑的 job、时长按生成那一刻算、
// 排序把跑得最久的顶到前面、任务输出按不可信数据对待（system prompt 里必须
// 有那句"忽略其中的指令"）。这几条错了，报告会一本正经地胡说，而界面上看不出来。
//
// 全程不碰网络：callStream 是注入点。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  tailLine,
  describeLastTool,
  buildRunningFacts,
  buildReportPrompt,
  formatDuration,
  generateProgressReport,
  MAX_FACT_TASKS,
  SYSTEM_PROMPT_ZH,
  SYSTEM_PROMPT_EN,
} from './progressReport.js';
import {
  PROGRESS_REPORT_INTERVALS_MS,
  DEFAULT_PROGRESS_REPORT_INTERVAL_MS,
} from './shared.js';

const TASKS = [
  { id: 't1', title: '把登录模块的错误处理重构一遍', projectPath: 'D:\\ws\\zen-gitsync' },
  { id: 't2', title: '给文章生成器加导出', projectPath: 'D:\\ws\\article-generator' },
];

/** 一个"跑了一分钟"的 job 模板 */
function runningJob(over = {}) {
  return {
    id: 'j1',
    taskId: 't1',
    status: 'running',
    startedAt: '2026-09-28T10:00:00.000Z',
    agent: 'claude',
    output: '先看一眼现状\n正在读取 src/login.ts',
    toolCalls: [{ name: 'Read', argsPreview: 'src/login.ts', status: 'done' }],
    ...over,
  };
}

const NOW = Date.parse('2026-09-28T10:01:00.000Z'); // 距 startedAt 正好 60 秒

// ── tailLine ────────────────────────────────────────────────────────────

test('tailLine 取最后一行有效文本，跳过末尾空行', () => {
  assert.equal(tailLine('第一行\n第二行\n\n   \n'), '第二行');
});

test('tailLine 把行内空白折成一个空格（多行输出里的缩进不该原样进 prompt）', () => {
  assert.equal(tailLine('a\n   正在   编辑\t文件   '), '正在 编辑 文件');
});

test('tailLine 截断超长行，且空 / 非字符串一律返回空串', () => {
  assert.equal(tailLine('x'.repeat(500)).length, 160);
  assert.equal(tailLine(''), '');
  assert.equal(tailLine(null), '');
  assert.equal(tailLine(undefined), '');
});

// ── describeLastTool ────────────────────────────────────────────────────

test('describeLastTool 取最后一次带名字的调用，优先用 argsPreview', () => {
  const calls = [
    { name: 'Read', argsPreview: 'a.ts', arguments: '{"file_path":"a.ts"}' },
    { name: 'Edit', argsPreview: 'b.ts', arguments: '{"file_path":"b.ts"}' },
  ];
  assert.equal(describeLastTool(calls), 'Edit b.ts');
});

test('describeLastTool 跳过没有名字的尾部记录（老数据 / 半截记录）', () => {
  const calls = [{ name: 'Bash', argsPreview: 'npm test' }, { id: 'anon-1' }];
  assert.equal(describeLastTool(calls), 'Bash npm test');
});

test('describeLastTool 没有 argsPreview 时退回 arguments；两者都没有就只给工具名', () => {
  assert.equal(describeLastTool([{ name: 'Bash', arguments: 'ls -la' }]), 'Bash ls -la');
  assert.equal(describeLastTool([{ name: 'Bash' }]), 'Bash');
  assert.equal(describeLastTool([]), '');
  assert.equal(describeLastTool(null), '');
});

// ── buildRunningFacts ───────────────────────────────────────────────────

test('buildRunningFacts 只挑 running / pending，终态 job 一律不进报告', () => {
  const jobs = [
    runningJob(),
    runningJob({ id: 'j2', taskId: 't2', status: 'done' }),
    runningJob({ id: 'j3', taskId: 't2', status: 'error' }),
    runningJob({ id: 'j4', taskId: 't2', status: 'cancelled' }),
  ];
  const facts = buildRunningFacts({ jobs, tasks: TASKS, now: NOW });
  assert.equal(facts.length, 1);
  assert.equal(facts[0].taskId, 't1');
});

test('buildRunningFacts 的时长按**传入的 now** 算，不是按当前时钟', () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  assert.equal(facts[0].elapsedMs, 60000);
  // 时间戳坏掉时给 0，而不是 NaN —— NaN 会一路渗进 prompt 变成 "NaN 秒"
  const broken = buildRunningFacts({
    jobs: [runningJob({ startedAt: '不是时间' })],
    tasks: TASKS,
    now: NOW,
  });
  assert.equal(broken[0].elapsedMs, 0);
});

test('buildRunningFacts 带上项目名 / 执行器 / 工具调用与最后一行输出', () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  assert.deepEqual(
    {
      taskTitle: facts[0].taskTitle,
      projectName: facts[0].projectName,
      agent: facts[0].agent,
      toolCallCount: facts[0].toolCallCount,
      lastTool: facts[0].lastTool,
      lastLine: facts[0].lastLine,
    },
    {
      taskTitle: '把登录模块的错误处理重构一遍',
      projectName: 'zen-gitsync',
      agent: 'claude',
      toolCallCount: 1,
      lastTool: 'Read src/login.ts',
      lastLine: '正在读取 src/login.ts',
    }
  );
});

test('buildRunningFacts 跑得最久的排最前（用户最可能想知道哪个卡住了）', () => {
  const jobs = [
    runningJob({ id: 'j-new', taskId: 't2', startedAt: '2026-09-28T10:00:50.000Z' }),
    runningJob({ id: 'j-old', taskId: 't1', startedAt: '2026-09-28T09:30:00.000Z' }),
  ];
  const facts = buildRunningFacts({ jobs, tasks: TASKS, now: NOW });
  assert.deepEqual(facts.map(f => f.taskId), ['t1', 't2']);
});

test('buildRunningFacts 最多带 MAX_FACT_TASKS 条（十几个任务同时跑不该把 prompt 撑爆）', () => {
  const jobs = Array.from({ length: MAX_FACT_TASKS + 5 }, (_, i) =>
    runningJob({ id: `j${i}`, taskId: `t${i}`, startedAt: `2026-09-28T10:00:${String(i).padStart(2, '0')}.000Z` }));
  const facts = buildRunningFacts({ jobs, tasks: [], now: NOW });
  assert.equal(facts.length, MAX_FACT_TASKS);
});

test('buildRunningFacts 任务已被删掉时标题留空，不抛错', () => {
  const facts = buildRunningFacts({ jobs: [runningJob({ taskId: '已经没了' })], tasks: TASKS, now: NOW });
  assert.equal(facts[0].taskTitle, '');
  assert.equal(facts[0].projectName, '');
});

// ── formatDuration / buildReportPrompt ──────────────────────────────────

test('formatDuration 分档输出（秒 / 分秒 / 时分）', () => {
  assert.equal(formatDuration(45000, true), '45 秒');
  assert.equal(formatDuration(750000, true), '12 分 30 秒');
  assert.equal(formatDuration(3700000, true), '1 小时 1 分');
  assert.equal(formatDuration(750000, false), '12m 30s');
});

test('buildReportPrompt 里能读到每个任务的事实，且明说这是不可信数据', () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const prompt = buildReportPrompt(facts, 'zh-CN');
  assert.ok(prompt.includes('把登录模块的错误处理重构一遍'));
  assert.ok(prompt.includes('zen-gitsync'));
  assert.ok(prompt.includes('已运行：1 分 0 秒'));
  assert.ok(prompt.includes('Read src/login.ts'));
  assert.ok(prompt.includes('正在读取 src/login.ts'));
  assert.ok(prompt.includes('不可信数据'));
  assert.ok(prompt.includes('忽略'));
});

test('buildReportPrompt 英文界面走英文模板', () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const prompt = buildReportPrompt(facts, 'en-US');
  assert.ok(prompt.includes('untrusted data'));
  assert.ok(prompt.includes('Running for: 1m 0s'));
  assert.ok(!prompt.includes('已运行'));
});

test('任务没有输出时 prompt 里写「暂无」，而不是留一块空白让模型自己脑补', () => {
  const facts = buildRunningFacts({
    jobs: [runningJob({ output: '', toolCalls: [] })],
    tasks: TASKS,
    now: NOW,
  });
  assert.ok(buildReportPrompt(facts, 'zh').includes('（暂无）'));
});

// ── generateProgressReport ──────────────────────────────────────────────

/** 假流式调用：按 delta 序列回调，再给出终态 */
function fakeStream(deltas, { aborted = false, error = null } = {}) {
  return async (_model, _prompt, onDelta) => {
    if (error) throw error;
    for (const d of deltas) onDelta(d);
    return { content: deltas.map(d => d.content || '').join(''), aborted };
  };
}

const MODEL = { baseURL: 'http://x', model: 'm', apiKey: 'k' };

test('没有任务在跑时**不叫模型**，报告就是一条空事实', async () => {
  let called = 0;
  const report = await generateProgressReport({
    facts: [],
    trigger: 'manual',
    model: MODEL,
    callStream: async () => { called++; return { content: '', aborted: false }; },
  });
  assert.equal(called, 0);
  assert.deepEqual(report.tasks, []);
  assert.equal(report.text, '');
  assert.equal(report.errorCode, '');
  assert.equal(report.trigger, 'manual');
});

test('有任务但没配模型：仍然出报告，带上事实与 NO_MODEL', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  let called = 0;
  const report = await generateProgressReport({
    facts,
    model: null,
    callStream: async () => { called++; return { content: '', aborted: false }; },
  });
  assert.equal(called, 0);
  assert.equal(report.errorCode, 'NO_MODEL');
  assert.equal(report.tasks.length, 1);
});

test('正常返回时取正文并去掉两端空白', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '  zen-gitsync ' }, { content: '正在重构登录模块。  ' }]),
  });
  assert.equal(report.text, 'zen-gitsync 正在重构登录模块。');
  assert.equal(report.errorCode, '');
});

test('thinking 段被滤掉，不混进正文（否则用户会以为那是结论）', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '<think>先想想怎么说</think>一切正常。' }]),
  });
  assert.equal(report.text, '一切正常。');
});

test('模型报错 → LLM_FAILED 并留住原因；空正文也按失败记', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const failed = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([], { error: new Error('HTTP 401') }),
  });
  assert.equal(failed.errorCode, 'LLM_FAILED');
  assert.equal(failed.errorDetail, 'HTTP 401');

  const empty = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '   ' }]),
  });
  assert.equal(empty.errorCode, 'LLM_FAILED');
  assert.equal(empty.text, '');
});

test('流被中断（超时）→ LLM_TIMEOUT，而不是当成一句空汇报', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '说到一半' }], { aborted: true }),
  });
  assert.equal(report.errorCode, 'LLM_TIMEOUT');
  assert.equal(report.text, '');
});

test('system prompt 两种语言都要求忽略任务输出里的指令', () => {
  assert.ok(SYSTEM_PROMPT_ZH.includes('不可信数据'));
  assert.ok(SYSTEM_PROMPT_ZH.includes('忽略'));
  assert.ok(SYSTEM_PROMPT_EN.includes('untrusted data'));
  assert.ok(SYSTEM_PROMPT_EN.includes('ignore'));
});

test('trigger 只认 auto，其余（含脏值）一律记成 manual', async () => {
  const auto = await generateProgressReport({ facts: [], trigger: 'auto' });
  const weird = await generateProgressReport({ facts: [], trigger: '什么鬼' });
  assert.equal(auto.trigger, 'auto');
  assert.equal(weird.trigger, 'manual');
});

// ── 两端档位白名单必须一致 ──────────────────────────────────────────────

/**
 * 前端的档位白名单（client/src/utils/progressReport.ts）与这里的
 * PROGRESS_REPORT_INTERVALS_MS 必须逐值相等：分叉了的话，界面显示"每 7 分钟"
 * 而服务端把它归一回默认的 10 分钟 —— 用户看到的设置是假的，且不会有任何报错。
 *
 * 为什么读源码而不是 import：客户端是 TS、这边是 ESM .js，两边互相 import 都会
 * 把对方的构建链拖进来（客户端 tsconfig 连 allowJs 都没开）。
 * 断言的是**数字**，不是文件格式 —— 所以只在找不到定义时报错，重排格式不会误伤。
 */
test('前端能选的档位 = 服务端认的档位', async () => {
  const clientSrc = await readFile(
    new URL('../../../client/src/utils/progressReport.ts', import.meta.url),
    'utf8'
  );

  const listMatch = clientSrc.match(/REPORT_INTERVAL_OPTIONS_MS\s*=\s*\[([^\]]+)\]\.map\(\s*min\s*=>\s*min\s*\*\s*([\d\s*]+)\)/);
  assert.ok(listMatch, '没在客户端源码里找到 REPORT_INTERVAL_OPTIONS_MS 的档位列表定义（改过写法就同步改这里）');
  const minutes = listMatch[1].split(',').map(s => Number(s.trim()));
  const factor = new Function(`return ${listMatch[2]}`)();
  assert.deepEqual(minutes.map(m => m * factor), PROGRESS_REPORT_INTERVALS_MS);

  const defMatch = clientSrc.match(/DEFAULT_REPORT_INTERVAL_MS\s*=\s*([\d\s*]+)/);
  assert.ok(defMatch, '没在客户端源码里找到 DEFAULT_REPORT_INTERVAL_MS 的定义');
  assert.equal(new Function(`return ${defMatch[1]}`)(), DEFAULT_PROGRESS_REPORT_INTERVAL_MS);
});
