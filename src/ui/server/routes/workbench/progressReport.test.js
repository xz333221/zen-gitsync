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
  buildRunningFacts,
  buildReportPrompt,
  describeCallResult,
  formatDuration,
  generateProgressReport,
  normalizePercent,
  parseProgressHeader,
  MAX_FACT_TASKS,
  MAX_REPORT_TOKENS,
  MAX_REPORT_TOKENS_RETRY,
  SYSTEM_PROMPT_ZH,
  SYSTEM_PROMPT_EN,
} from './progressReport.js';
// 这两个常量随 tailLine / describeToolMix 一起搬到了 jobActivity.js（定义处即引用处）
import { TOOL_MIX_WINDOW, SILENT_NOTABLE_MS } from './jobActivity.js';
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

test('buildRunningFacts 带上思考 / 工具分布 / 静默（只看输出看不出这些）', () => {
  const facts = buildRunningFacts({
    jobs: [runningJob({
      output: '',
      thinking: '先看目录结构\n再确认 index.js 里的路由注册顺序',
      toolCalls: [{ name: 'Bash' }, { name: 'Bash' }, { name: 'Read' }],
      lastActivityAt: '2026-09-28T09:55:00.000Z', // 距 NOW 6 分钟
    })],
    tasks: TASKS,
    now: NOW,
  });
  assert.equal(facts[0].lastThought, '再确认 index.js 里的路由注册顺序');
  assert.equal(facts[0].toolMix, 'Bash×2 · Read');
  assert.equal(facts[0].silentMs, 6 * 60 * 1000);
});

test('buildRunningFacts 跑得最久的排最前（用户最可能想知道哪个卡住了）', () => {  const jobs = [
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

/**
 * 回归：真实报告里出现过"最新输出为空，无法判断是在改代码还是反复读文件"，
 * 而那句话说的那个任务**思考一直在产出**（2026-09-29，截图那条）。
 * 思考不进 prompt，模型只能靠"输出是空的"猜 —— 这条钉住"思考必须喂进去"。
 */
test('一句正文都没写、只有工具调用与思考的任务：prompt 里读得到它的思考', () => {
  const facts = buildRunningFacts({
    jobs: [runningJob({
      output: '',
      thinking: '用户在问工具调用的收起为什么不起作用\n先从 useWorkbenchSimpleConversation 查起',
      toolCalls: Array.from({ length: 119 }, () => ({ name: 'Bash' })),
      lastActivityAt: '2026-09-28T09:52:00.000Z', // 距 NOW 9 分钟
    })],
    tasks: TASKS,
    now: NOW,
  });
  const prompt = buildReportPrompt(facts, 'zh');
  assert.ok(prompt.includes('先从 useWorkbenchSimpleConversation 查起'));
  assert.ok(prompt.includes('最近思考'));
  // 119 次调用全在 Bash —— 报告要能看出"在原地打转"，而不是只知道调了很多次
  // （分布是最近 20 次窗口内的计数，所以写 20 不写 119）
  assert.ok(prompt.includes('Bash×20'));
  assert.ok(prompt.includes('静默：9 分 0 秒'));
  // 依据不足时的不许编造那条还在
  assert.ok(prompt.includes('不要编造'));
});

test('英文模板同样给思考 / 工具分布 / 静默', () => {
  const facts = buildRunningFacts({
    jobs: [runningJob({
      output: '',
      thinking: 'check the collapse handler first',
      toolCalls: [{ name: 'Bash' }, { name: 'Bash' }],
      lastActivityAt: '2026-09-28T10:01:00.000Z',
    })],
    tasks: TASKS,
    now: NOW + SILENT_NOTABLE_MS,
  });
  const prompt = buildReportPrompt(facts, 'en-US');
  assert.ok(prompt.includes('Latest thinking:'));
  assert.ok(prompt.includes('check the collapse handler first'));
  assert.ok(prompt.includes('Tool mix (last'));
  assert.ok(prompt.includes('Bash×2'));
  assert.ok(prompt.includes('Silent for: 1m 0s'));
});

// ── generateProgressReport ──────────────────────────────────────────────

/** 假流式调用：按 delta 序列回调，再给出终态 */
function fakeStream(deltas, { aborted = false, error = null, finishReason = '', usage = null } = {}) {
  return async (_model, _prompt, onDelta) => {
    if (error) throw error;
    for (const d of deltas) onDelta(d);
    return { content: deltas.map(d => d.content || '').join(''), aborted, finishReason, usage };
  };
}

const MODEL = { baseURL: 'http://x', model: 'm', apiKey: 'k' };

// 注：本函数对"没任务在跑"依然能生成一条空事实记录，但**调用方已经不落盘它了** ——
// routes/workbench/index.js 的 runProgressReport 在 facts 为空时直接 return null，
// 历史里不会再出现"当时没有任务在执行"这种零信息量的记录（见 orchestratorStore 的
// readReports 过滤 + orchestratorStore.progressReport.test.js）。
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

test('模型报错 → LLM_FAILED 并留住原因；空正文记成 LLM_EMPTY', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const failed = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([], { error: new Error('HTTP 401') }),
  });
  assert.equal(failed.errorCode, 'LLM_FAILED');
  assert.equal(failed.errorDetail, 'HTTP 401');

  // 空正文与"报错"分开记：成因不同（这个是模型答了但没写正文），处理办法也不同
  const empty = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '   ' }]),
  });
  assert.equal(empty.errorCode, 'LLM_EMPTY');
  assert.equal(empty.text, '');
  // detail 里必须留下可以查的东西 —— 老实现这里是空串，界面上只有一句"生成失败"，
  // 盘上也查不出原因（2026-09-30 那三条失败报告就是这么埋掉的）
  assert.match(empty.errorDetail, /finish_reason=/);
});

// ── 空正文：预算被思考吃光（2026-09-30 用户报的"有时候生成失败"）──────────
//
// 复现过的形态：推理模型的 `max_tokens` 是**思考 + 正文共用**的，思考写满预算时
// 正文一个字都没写出来，HTTP 还是 200。900 的老预算下实测思考 2708 字符 / content 0。
// 这三条守的是"预算够用 + 截断了会自己重试一次 + 重试也没用时不假装成功"。

test('生成预算够装下思考与正文（900 那个老值会被推理模型吃光）', () => {
  assert.ok(MAX_REPORT_TOKENS >= 2000, `MAX_REPORT_TOKENS=${MAX_REPORT_TOKENS}`);
  assert.ok(MAX_REPORT_TOKENS_RETRY > MAX_REPORT_TOKENS, '重试预算必须比常规预算大');
});

test('第一次被截断（finish_reason=length）且正文为空 → 加预算重试一次并拿到正文', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const budgets = [];
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: async (_m, _p, onDelta, opts) => {
      budgets.push(opts.maxTokens);
      if (budgets.length === 1) return { content: '', aborted: false, finishReason: 'length' };
      onDelta({ content: 'PROGRESS: 40\nTASKS: 40\n第二次拿到了汇报正文。' });
      return { content: '...', aborted: false, finishReason: 'stop' };
    },
  });
  assert.equal(report.errorCode, '');
  assert.equal(report.text, '第二次拿到了汇报正文。');
  assert.equal(report.percent, 40);
  assert.equal(budgets.length, 2, '必须恰好重试一次');
  assert.ok(budgets[1] > budgets[0], `预算没加大：${budgets.join(' -> ')}`);
});

test('空正文但没被截断（模型自己 stop 了）→ 不重试，加预算也没用', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  let calls = 0;
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: async () => { calls++; return { content: '', aborted: false, finishReason: 'stop' }; },
  });
  assert.equal(calls, 1);
  assert.equal(report.errorCode, 'LLM_EMPTY');
  assert.match(report.errorDetail, /finish_reason=stop/);
});

test('重试也没拿到正文时，errorDetail 里留下 finish_reason 与思考用量', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  let calls = 0;
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: async () => {
      calls++;
      return {
        content: '',
        aborted: false,
        finishReason: 'length',
        usage: { completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 7980 } },
      };
    },
  });
  assert.equal(calls, 2, '被截断时两轮都该跑');
  assert.equal(report.errorCode, 'LLM_EMPTY');
  // 这一串就是"下次不用再翻网关日志"的全部意义
  assert.match(report.errorDetail, /finish_reason=length/);
  assert.match(report.errorDetail, /reasoning_tokens=7980/);
  assert.match(report.errorDetail, /max_tokens=8000/);
});

test('超时不重试（90 秒没回来，再来一次大概率还是 90 秒）', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  let calls = 0;
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: async () => { calls++; return { content: '', aborted: true, finishReason: 'length' }; },
  });
  assert.equal(calls, 1);
  assert.equal(report.errorCode, 'LLM_TIMEOUT');
  assert.match(report.errorDetail, /aborted/);
});

test('describeCallResult 认不出的字段不写，整串有上限', () => {
  assert.equal(describeCallResult(null, 900), 'max_tokens=900 finish_reason=unknown');
  assert.equal(
    describeCallResult({ finishReason: 'stop' }, 3000),
    'max_tokens=3000 finish_reason=stop'
  );
  assert.ok(describeCallResult({ finishReason: 'x'.repeat(600) }, 1).length <= 300);
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
  // 思考也是另一个模型写的话、也进了 prompt —— 不可信数据的清单必须带上它，
  // 漏了就等于"思考里写的指令可以照做"（2026-09-29 补思考时同步改的）
  assert.ok(SYSTEM_PROMPT_ZH.includes('思考'));
  assert.ok(SYSTEM_PROMPT_EN.includes('untrusted data'));
  assert.ok(SYSTEM_PROMPT_EN.includes('ignore'));
  assert.ok(SYSTEM_PROMPT_EN.includes('task thinking'));
});

test('trigger 只认 auto，其余（含脏值）一律记成 manual', async () => {
  const auto = await generateProgressReport({ facts: [], trigger: 'auto' });
  const weird = await generateProgressReport({ facts: [], trigger: '什么鬼' });
  assert.equal(auto.trigger, 'auto');
  assert.equal(weird.trigger, 'manual');
});

// ── 进度百分比（模型在正文之前交的那两行数字）──────────────────────────
//
// 这一串断言守的是**同一件事**：报告里那个百分比只能是模型说的。
// 解析太松会把正文吞掉 / 把序号当进度，太严又会白白丢掉模型真给的值 ——
// 而这三种错在界面上都只是"进度条不对"，没人会去想是解析写错了。

test('parseProgressHeader 把标记行摘掉，正文与百分比各归各', () => {
  const r = parseProgressHeader('PROGRESS: 62\nTASKS: 70, 30\nzen-gitsync 正在改登录模块。');
  assert.equal(r.percent, 62);
  assert.deepEqual(r.taskPercents, [70, 30]);
  assert.equal(r.text, 'zen-gitsync 正在改登录模块。');
});

test('标记行的各种写法都认（加粗 / 全角冒号 / 列表符号 / 百分号 / 顿号 / 带序号）', () => {
  assert.deepEqual(
    parseProgressHeader('**PROGRESS：62%**\n- TASKS: 70、?、40\n正文'),
    { percent: 62, taskPercents: [70, null, 40], text: '正文' }
  );
  // `1=70` 这种带序号的写法：别把序号 1 当成进度
  assert.deepEqual(parseProgressHeader('TASKS: 1=70, 2=30\n正文').taskPercents, [70, 30]);
});

test('认不出来的标记行**留在正文里**，不吞内容', () => {
  const r = parseProgressHeader('进度：还没法判断\n正文第一句。');
  assert.equal(r.percent, null);
  assert.equal(r.text, '进度：还没法判断\n正文第一句。');
});

test('整体没给、各任务给了：整体取已知任务的平均值（模型自己的数字的均值）', () => {
  const r = parseProgressHeader('TASKS: 60, ?, 30\n正文');
  assert.equal(r.percent, 45);
  // 全估不出来（`TASKS: ?`）时整体也是 null —— 不能因为"给了几个问号"就编一个 0
  assert.equal(parseProgressHeader('TASKS: ?\n正文').percent, null);
  assert.equal(parseProgressHeader('TASKS: ?\n正文').text, '正文');
});

test('越界 / 脏值一律当没给，不夹到 0 或 100', () => {
  assert.equal(normalizePercent(130), null);
  assert.equal(normalizePercent(-5), null);
  assert.equal(normalizePercent('abc'), null);
  assert.equal(normalizePercent(undefined), null);
  // 落盘写的就是 `percent: null`（模型没给），读回来必须还是 null ——
  // `Number(null)` 是 0，漏了那一挡就会变成一条 0% 的进度条
  assert.equal(normalizePercent(null), null);
  assert.equal(normalizePercent(''), null);
  assert.equal(normalizePercent(62.4), 62);
  assert.equal(normalizePercent('62'), 62);
  assert.equal(normalizePercent(0), 0);
});

test('正文外面裹的 ``` 围栏被剥掉（模型偶尔把整个回答写成代码块）', () => {
  assert.equal(parseProgressHeader('```\nPROGRESS: 50\nTASKS: 50\n正文\n```').text, '正文');
});

test('prompt 要求模型先交两行数字，并说清这两个数字会被画成进度条', () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const zh = buildReportPrompt(facts, 'zh');
  assert.ok(zh.includes('PROGRESS:'));
  assert.ok(zh.includes('TASKS:'));
  assert.ok(zh.includes('进度条'));
  // 任务清单带序号 —— `TASKS:` 那一行靠它跟任务对齐，没序号必然错位
  assert.ok(zh.includes('【任务 1】'));

  const en = buildReportPrompt(facts, 'en-US');
  assert.ok(en.includes('PROGRESS:') && en.includes('TASKS:'));
  assert.ok(en.includes('[Task 1]'));
  assert.ok(en.includes('progress bar'));
});

test('模型按格式交回：正文摘干净，百分比落到报告与每个任务上', async () => {
  const facts = buildRunningFacts({
    jobs: [runningJob(), runningJob({ id: 'j2', taskId: 't2' })],
    tasks: TASKS,
    now: NOW,
  });
  assert.deepEqual(facts.map(f => f.taskId), ['t1', 't2']);
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    // 标记行故意拆在两个 delta 里：解析必须发生在**拼好的整段**上，
    // 谁要是改成边流边解析，这条会先挂
    callStream: fakeStream([{ content: 'PROGRESS: 62\nTAS' }, { content: 'KS: 70, 30\nzen-gitsync 正在改登录模块。' }]),
  });
  assert.equal(report.text, 'zen-gitsync 正在改登录模块。');
  assert.equal(report.percent, 62);
  assert.deepEqual(report.tasks.map(t => t.percent), [70, 30]);
});

test('模型没给百分比（老模型 / 不听话）：percent 是 null，正文一字不动', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const report = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: '一切照旧，正在改登录模块。' }]),
  });
  assert.equal(report.percent, null);
  assert.equal(report.tasks[0].percent, null);
  assert.equal(report.text, '一切照旧，正在改登录模块。');
});

test('失败 / 超时的报告没有百分比（不许拿时长糊一个出来）', async () => {
  const facts = buildRunningFacts({ jobs: [runningJob()], tasks: TASKS, now: NOW });
  const failed = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([], { error: new Error('HTTP 401') }),
  });
  assert.equal(failed.percent, null);
  // 超时那份连标记行都吐出来了，照样不给百分比：半份报告上的数字是残次品
  const timeout = await generateProgressReport({
    facts,
    model: MODEL,
    callStream: fakeStream([{ content: 'PROGRESS: 62\n刚写到这里就断了' }], { aborted: true }),
  });
  assert.equal(timeout.percent, null);
  assert.equal(timeout.text, '');
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
