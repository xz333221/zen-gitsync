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
// 静默看门狗的断言重心是**它不乱动**：这个模块是唯一一个会自动改任务状态的地方，
// 而它唯一的输入是另一个模型的自由文本。所以每条测试问的都不是"判得准不准"
// （那取决于模型），而是"判不准的时候会不会出事"：
//   · 静默不够久 / 时间戳推不出来 → 一次都不许问（问了就是白烧额度）
//   · 模型答得含糊、答错格式、调用失败 → 一个字段都不许动
//   · 判定期间任务又活了 → 不许拿上一次的结论去改现在的状态
//   · 判成完成 → **不许编造 exitCode**（进程没退就没有退出码）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_STALL_CHECKS,
  SILENT_DONE_CHECK_MS,
  applyStallVerdict,
  buildStallFact,
  buildStallPrompt,
  judgeStalledJob,
  parseStallVerdict,
  pickStalledJobs,
  shouldCheckStall,
  stallCheckState,
} from './stallWatchdog.js';

const NOW = Date.parse('2026-10-01T02:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

/** 一条"跑了 1 小时、静默 12 分钟"的 job（默认就在该判的区间里） */
function stalledJob(over = {}) {
  return {
    id: 'j1',
    taskId: 't1',
    status: 'running',
    pid: 45796,
    startedAt: iso(NOW - 60 * 60 * 1000),
    lastActivityAt: iso(NOW - 12 * 60 * 1000),
    output: '',
    thinking: '',
    toolCalls: [],
    ...over,
  };
}

const TASK = { id: 't1', title: '这块模型感觉都比较老了', projectPath: 'C:\\ws\\flowdash-ai-radar-demo' };
const MODEL = { baseURL: 'http://x', model: 'm', apiKey: 'k' };

// ── shouldCheckStall / pickStalledJobs ──────────────────────────────────

test('静默不到 10 分钟不判（9 分 59 秒也不行）', () => {
  const justUnder = stalledJob({ lastActivityAt: iso(NOW - SILENT_DONE_CHECK_MS + 1000) });
  assert.equal(shouldCheckStall(justUnder, NOW), false);
  const justOver = stalledJob({ lastActivityAt: iso(NOW - SILENT_DONE_CHECK_MS) });
  assert.equal(shouldCheckStall(justOver, NOW), true);
});

test('只有 running 才判：pending 是排队、终态是已经有结论了', () => {
  for (const status of ['pending', 'done', 'error', 'cancelled']) {
    assert.equal(shouldCheckStall(stalledJob({ status }), NOW), false, status);
  }
  assert.equal(shouldCheckStall(stalledJob({ status: 'running' }), NOW), true);
});

test('推不出静默时长就不判（老记录没有 lastActivityAt，宁可什么都不做）', () => {
  assert.equal(shouldCheckStall(stalledJob({ lastActivityAt: null }), NOW), false);
  assert.equal(shouldCheckStall(stalledJob({ lastActivityAt: '不是时间' }), NOW), false);
  assert.equal(shouldCheckStall(null, NOW), false);
});

test('同一段静默里只问一次：判过之后要再等一个 10 分钟', () => {
  const asked = stalledJob({ stallCheck: { at: iso(NOW - 60 * 1000), checks: 1 } });
  assert.equal(shouldCheckStall(asked, NOW), false);
  const old = stalledJob({ stallCheck: { at: iso(NOW - SILENT_DONE_CHECK_MS), checks: 1 } });
  assert.equal(shouldCheckStall(old, NOW), true);
});

test(`答了 ${MAX_STALL_CHECKS} 次"还没完"之后就别再问了（卡死 8 小时不该烧 48 次额度）`, () => {
  const many = stalledJob({ stallCheck: { at: iso(NOW - 60 * 60 * 1000), checks: MAX_STALL_CHECKS } });
  assert.equal(shouldCheckStall(many, NOW), false);
  const oneLess = stalledJob({ stallCheck: { at: iso(NOW - 60 * 60 * 1000), checks: MAX_STALL_CHECKS - 1 } });
  assert.equal(shouldCheckStall(oneLess, NOW), true);
});

test('stallCheck 脏值按"从没判过"处理，而不是把整条 job 判死', () => {
  assert.deepEqual(stallCheckState(null), { checks: 0, at: null });
  assert.deepEqual(stallCheckState({ stallCheck: { checks: -2, at: 42 } }), { checks: 0, at: null });
  assert.deepEqual(stallCheckState({ stallCheck: { checks: '3', at: iso(NOW) } }), { checks: 3, at: iso(NOW) });
});

test('pickStalledJobs 只挑该判的（其余原样留在池子里）', () => {
  const jobs = [
    stalledJob({ id: 'a' }),
    stalledJob({ id: 'b', lastActivityAt: iso(NOW - 60 * 1000) }),
    stalledJob({ id: 'c', status: 'done' }),
  ];
  assert.deepEqual(pickStalledJobs(jobs, NOW).map(j => j.id), ['a']);
  assert.deepEqual(pickStalledJobs(null, NOW), []);
});

// ── parseStallVerdict ───────────────────────────────────────────────────

test('只有明确的 true 才算完成', () => {
  assert.equal(parseStallVerdict({ done: true }).done, true);
  assert.equal(parseStallVerdict({ done: 'true' }).done, true);
  assert.equal(parseStallVerdict({ done: 'YES' }).done, true);
  assert.equal(parseStallVerdict({ done: '是' }).done, true);
});

test('含糊 / 脏值一律不算完成（每一处宽松都等于允许误标一条还在跑的任务）', () => {
  for (const done of [false, null, undefined, 0, 1, '1', 'maybe', 'no', {}, []]) {
    assert.equal(parseStallVerdict({ done }).done, false, JSON.stringify(done));
  }
  assert.equal(parseStallVerdict({}).done, false, '缺字段');
  assert.equal(parseStallVerdict(null).done, false);
  assert.equal(parseStallVerdict('').done, false);
});

test('模型忽略 json_object 直接吐文本时也能认；认不下来标 parsed=false', () => {
  const ok = parseStallVerdict('{"done": true, "reason": "它已经写完结论并在问要不要 push"}');
  assert.equal(ok.done, true);
  assert.equal(ok.parsed, true);
  assert.ok(ok.reason.includes('要不要 push'));

  // 截断 / 半截 JSON / 散文 —— 全部当"没答"，调用侧据此什么都不做
  assert.equal(parseStallVerdict('{"done": true, "reason":').parsed, false);
  assert.equal(parseStallVerdict('我觉得它已经完成了。').parsed, false);
  assert.equal(parseStallVerdict([{ done: true }]).parsed, false, '数组不是我们要的对象');
});

test('reason 折成一行并截断（它要进悬停提示和日志）', () => {
  const v = parseStallVerdict({ done: true, reason: '  第一行\n  第二行  ' });
  assert.equal(v.reason, '第一行 第二行');
  assert.equal(parseStallVerdict({ done: true, reason: 'x'.repeat(500) }).reason.length, 160);
  assert.equal(parseStallVerdict({ done: true }).reason, '');
  assert.equal(parseStallVerdict({ done: true, reason: null }).reason, '');
});

// ── buildStallFact / buildStallPrompt ───────────────────────────────────

test('buildStallFact 里的摘录比卡片那条长（收尾的总结与反问常常隔着几百字）', () => {
  const long = `${'前'.repeat(400)}总结：三处都改完了。要 push 吗？`;
  const fact = buildStallFact(stalledJob({ output: '\n'.repeat(3) + long, thinking: 'Let me write the code.' }), TASK, NOW);
  assert.equal(fact.jobId, 'j1', '带着 jobId —— 判定结果要回到这条 job 上改状态');
  assert.equal(fact.silentMs, 12 * 60 * 1000);
  assert.ok(fact.lastLine.endsWith('要 push 吗？'));
  assert.ok(fact.lastLine.length > 100, '长于卡片上的 MAX_REPLY_CHARS(100)');
});

test('prompt 里给全了判据：静默时长 / 思考 / 最后那段话 / 工具分布，且标明是不可信数据', () => {
  const job = stalledJob({
    thinking: '用户抱怨模型太老，我先去改筛选口径',
    output: '三处都改完了，要 push 吗？',
    toolCalls: [{ name: 'Edit' }, { name: 'Bash' }, { name: 'Bash' }],
  });
  const prompt = buildStallPrompt(buildStallFact(job, TASK, NOW), 'zh-CN');
  assert.ok(prompt.includes('这块模型感觉都比较老了'));
  assert.ok(prompt.includes('12 分钟'), '静默时长本身要写进去');
  assert.ok(prompt.includes('用户抱怨模型太老'));
  assert.ok(prompt.includes('要 push 吗？'));
  assert.ok(prompt.includes('Bash×2 · Edit'));
  assert.ok(prompt.includes('不可信数据'));
  // 这条是"不许猜"的硬要求 —— 少了它，模型倾向于顺着"跑这么久了应该完了吧"编一个 true
  assert.ok(prompt.includes('判据不足时必须说没完成'));
  assert.ok(prompt.includes('"done"'));
});

test('英文界面走英文模板', () => {
  const job = stalledJob({ output: 'All three spots are fixed. Should I push?' });
  const prompt = buildStallPrompt(buildStallFact(job, TASK, NOW), 'en-US');
  assert.ok(prompt.includes('untrusted data'));
  assert.ok(prompt.includes('12 minute(s)'));
  assert.ok(prompt.includes('Should I push?'));
  assert.ok(!prompt.includes('判据不足'));
});

test('静默时长为空时 prompt 不写假的 0 分钟', () => {
  const fact = { ...buildStallFact(stalledJob(), TASK, NOW), silentMs: null };
  const prompt = buildStallPrompt(fact, 'zh');
  assert.ok(prompt.includes('一段时间'));
  assert.ok(!prompt.includes('0 分钟'));
});

// ── judgeStalledJob（注入 callJson，不打真网络） ─────────────────────────

test('没配模型就不问，直接 NO_MODEL（与进度报告同一取舍）', async () => {
  let called = 0;
  const v = await judgeStalledJob({
    fact: buildStallFact(stalledJob(), TASK, NOW),
    model: null,
    callJson: async () => { called++; return { done: true }; },
  });
  assert.equal(called, 0);
  assert.equal(v.errorCode, 'NO_MODEL');
  assert.equal(v.done, false);
});

test('模型调用失败 / 返回认不下来 → 不抛错，done=false 带 errorCode', async () => {
  const fact = buildStallFact(stalledJob(), TASK, NOW);
  const boom = await judgeStalledJob({
    fact, model: MODEL,
    callJson: async () => { throw new Error('HTTP 502'); },
  });
  assert.equal(boom.done, false);
  assert.equal(boom.errorCode, 'LLM_FAILED');
  assert.ok(boom.errorDetail.includes('502'));

  const garbage = await judgeStalledJob({ fact, model: MODEL, callJson: async () => '我觉得它做完了' });
  assert.equal(garbage.done, false);
  assert.equal(garbage.errorCode, 'LLM_UNPARSABLE');
});

test('正常返回时把 done / reason 透传，并带上预算与 system prompt', async () => {
  let seen = null;
  const v = await judgeStalledJob({
    fact: buildStallFact(stalledJob(), TASK, NOW),
    model: MODEL,
    callJson: async (_m, prompt, opts) => {
      seen = { prompt, opts };
      return { done: true, reason: '它已经写完结论并在问要不要 push' };
    },
  });
  assert.equal(v.done, true);
  assert.equal(v.errorCode, '');
  assert.equal(v.reason, '它已经写完结论并在问要不要 push');
  assert.ok(seen.opts.maxTokens > 0, '推理模型的预算必须显式给，不能交给网关默认值');
  assert.ok(seen.opts.systemPrompt.includes('不可信数据'));
});

// ── applyStallVerdict ───────────────────────────────────────────────────

test('判没完成：只记账，状态一个字段都不动', () => {
  const job = stalledJob();
  const before = JSON.stringify({ ...job, stallCheck: undefined });
  const changed = applyStallVerdict(job, { at: iso(NOW), verdict: { done: false, reason: '还在读文件' } });
  assert.equal(changed, false);
  assert.equal(JSON.stringify({ ...job, stallCheck: undefined }), before, '除了记账不该有别的副作用');
  assert.equal(job.status, 'running');
  assert.equal(job.stallCheck.checks, 1);
  assert.equal(job.stallCheck.done, false);
  assert.equal(job.autoCompleted, undefined);
});

test('判完成：落成终态 + 写下依据，卡片据此从「进行中」挪到「已完成」', () => {
  const job = stalledJob({ output: '改完了，要 push 吗？' });
  const changed = applyStallVerdict(job, {
    at: iso(NOW),
    verdict: { done: true, reason: '已给出结论并反问用户' },
  });
  assert.equal(changed, true);
  assert.equal(job.status, 'done');
  assert.equal(job.endedAt, iso(NOW));
  assert.deepEqual(job.autoCompleted, {
    at: iso(NOW),
    reason: '已给出结论并反问用户',
    silentMs: 12 * 60 * 1000,
  });
  // 进程没退就没有退出码 —— 编一个 0 等于把"进程正常结束"写进档案，
  // 而这恰恰是这次判定**没有**依据的那件事
  assert.equal(job.exitCode, undefined);
  assert.equal(job.pid, 45796, 'PID 留着：真要 kill 还认得出是哪个进程');
});

test('判定期间任务又动了 → 记下这次判定但**不改状态**', () => {
  const job = stalledJob();
  // 模型往返的这几十秒里它又吐了字
  job.lastActivityAt = iso(NOW - 1000);
  const changed = applyStallVerdict(job, { at: iso(NOW), verdict: { done: true, reason: '看着像完了' } });
  assert.equal(changed, false);
  assert.equal(job.status, 'running');
  assert.equal(job.endedAt, undefined);
  assert.equal(job.stallCheck.checks, 1, '账还是要记（否则同一个窗口会被反复问）');
  assert.equal(job.stallCheck.done, true);
});

test('判定期间 job 已经被别的路径收掉（进程自己退了 / 用户点了停止）→ 让那个结果说了算', () => {
  for (const status of ['done', 'error', 'cancelled']) {
    const job = stalledJob({ status, endedAt: iso(NOW - 5000) });
    assert.equal(applyStallVerdict(job, { at: iso(NOW), verdict: { done: true } }), false, status);
    assert.equal(job.status, status);
    assert.equal(job.endedAt, iso(NOW - 5000), '不覆盖别人写的结束时刻');
    assert.equal(job.autoCompleted, undefined);
  }
});

test('checks 逐次累加，at 缺省时用当前时刻兜底（不能留一个 undefined 进记录）', () => {
  const job = stalledJob({ stallCheck: { at: iso(NOW - 20 * 60 * 1000), checks: 2 } });
  applyStallVerdict(job, { verdict: { done: false }, now: NOW });
  assert.equal(job.stallCheck.checks, 3);
  assert.equal(job.stallCheck.at, iso(NOW));
});

test('autoCompleted 里记的是**当时**的静默时长（不是 now - startedAt 那种别的口径）', () => {
  const job = stalledJob({ lastActivityAt: iso(NOW - 54 * 60 * 1000) });
  applyStallVerdict(job, { at: iso(NOW), verdict: { done: true } });
  assert.equal(job.autoCompleted.silentMs, 54 * 60 * 1000);
});

// ── 整条链路 ────────────────────────────────────────────────────────────
// 上面每条都只覆盖一段。这一段把四步串起来跑一遍（准入 → 抽事实 → 判定 → 落终态），
// 因为"每段都对、拼起来不通"正是这类功能的典型坏法：buildStallFact 给的字段
// judgeStalledJob 读不到、或者 applyStallVerdict 认的 done 不是 judge 返回的那个形状。

test('链路：静默 12 分钟 → 判定 → 落成终态（看板据此把卡片挪进「已完成」）', async () => {
  const job = stalledJob({
    thinking: '三处口径都改完了，要不要顺手把索引也更新了？',
    output: '改完了：\n1. 筛选口径\n2. 发布时间\n3. 排序\n\n要 push 吗？',
    toolCalls: [{ name: 'Edit' }, { name: 'Edit' }, { name: 'Bash' }],
  });

  assert.equal(shouldCheckStall(job, NOW), true, '第一步：准入');
  const fact = buildStallFact(job, TASK, NOW);
  assert.equal(fact.jobId, job.id, '事实要能指回这条 job');

  const verdict = await judgeStalledJob({
    fact,
    model: MODEL,
    // 假模型：按真实返回的形状给（callLlmJson 返回的是 parse 好的对象）
    callJson: async (_m, prompt) => {
      assert.ok(prompt.includes('要 push 吗？'), '收尾那句必须在 prompt 里，它是判据');
      return { done: true, reason: '已给出三条改动的总结并反问是否 push' };
    },
  });
  assert.equal(verdict.done, true);

  assert.equal(applyStallVerdict(job, { at: iso(NOW), verdict }), true, '第四步：落终态');
  assert.equal(job.status, 'done');
  assert.equal(job.endedAt, iso(NOW));
  assert.equal(job.autoCompleted.reason, '已给出三条改动的总结并反问是否 push');
  assert.equal(job.stallCheck.checks, 1);
});

test('链路：判定说"还没完"时一个字段都不动（等下一个窗口再问）', async () => {
  const job = stalledJob({ thinking: '正在读第 12 个文件', output: '', toolCalls: [{ name: 'Read' }] });
  const fact = buildStallFact(job, TASK, NOW);
  const verdict = await judgeStalledJob({
    fact, model: MODEL,
    callJson: async () => ({ done: false, reason: '还在读文件，没有收尾迹象' }),
  });
  assert.equal(applyStallVerdict(job, { at: iso(NOW), verdict }), false);
  assert.equal(job.status, 'running');
  assert.equal(job.autoCompleted, undefined);
  assert.equal(job.stallCheck.done, false);
});
