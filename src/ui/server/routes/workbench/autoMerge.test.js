// autoMerge 单测:模型判定/预检闸门/兜底逻辑,全用替身,不碰真 git。
//
// 最要紧的三条:
//   1. 预检是**硬闸门**:预检不过时模型说什么都合不了(自主权不越过安全边界);
//   2. 模型判"不合"就不合 —— 自主合并的"自主"包含"自主放弃";
//   3. 没配模型/判定失败 → 按预检结果直接合并:预检过了合并才无损,
//      这是"完全自主、无需申请"的底气(最坏一个 git reset 可撤)。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAndAutoMerge, buildMergePrompt, parseMergeVerdict } from './autoMerge.js';

const TASK = { id: 't1', title: '测试任务', desc: '' };
const JOB = { worktree: { path: '/wt', branch: 'zen-gitsync/task-t1', base: 'abc', reused: false } };
const REPO = '/repo';
const STATUS = {
  exists: true, path: '/wt', branch: 'zen-gitsync/task-t1', base: 'abc',
  changedCount: 2, changedFiles: ['a.txt', 'b.txt'],
};
const OK_PRECHECK = { ok: true, mergeFiles: ['a.txt', 'b.txt'], dirtyFiles: [], overlap: [], conflictFiles: [] };

const baseDeps = () => ({
  task: { ...TASK },
  job: { ...JOB },
  repoPath: REPO,
  model: null,
  worktreeStatusFn: async () => ({ ...STATUS }),
  precheckMergeFn: async () => ({ ...OK_PRECHECK }),
  mergeFn: async () => ({ commit: 'f1x', files: ['a.txt', 'b.txt'] }),
  discardFn: async () => {},
  callJson: async () => { throw new Error('不该被调用'); },
  logger: { warn: () => {} },
});

test('没开 worktree / 任务关了自动合并 → skipped', async () => {
  let called = 0;
  const r1 = await evaluateAndAutoMerge({ ...baseDeps(), job: { ...JOB, worktree: null }, mergeFn: async () => { called++; } });
  assert.equal(r1.outcome, 'skipped');
  const r2 = await evaluateAndAutoMerge({ ...baseDeps(), task: { ...TASK, autoMerge: false }, mergeFn: async () => { called++; } });
  assert.equal(r2.outcome, 'skipped');
  assert.equal(called, 0);
});

test('worktree 里没有改动 → 清空树,不做合并判定', async () => {
  let merged = 0, discarded = 0;
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    worktreeStatusFn: async () => ({ ...STATUS, changedCount: 0 }),
    mergeFn: async () => { merged++; },
    discardFn: async () => { discarded++; },
  });
  assert.equal(r.outcome, 'nothing');
  assert.equal(merged, 0);
  assert.equal(discarded, 1, '空的 worktree 要顺手清掉');
});

test('预检不过 → blocked,模型和合并都不会被碰(硬闸门)', async () => {
  let modelCalled = 0, merged = 0;
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    model: { baseURL: 'http://x', model: 'm', apiKey: 'k' },
    precheckMergeFn: async () => ({ ok: false, reason: '工作区改动与合并重叠:a.txt' }),
    callJson: async () => { modelCalled++; return { merge: true, reason: 'x' }; },
    mergeFn: async () => { merged++; },
  });
  assert.equal(r.outcome, 'blocked');
  assert.ok(r.reason.includes('a.txt'));
  assert.equal(modelCalled, 0, '预检没过就不该烧判定');
  assert.equal(merged, 0);
});

test('模型判「不合」→ declined,worktree 原样保留', async () => {
  let merged = 0, discarded = 0;
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    model: { baseURL: 'http://x', model: 'm', apiKey: 'k' },
    callJson: async () => ({ merge: false, reason: '收尾里说还在实验中' }),
    mergeFn: async () => { merged++; },
    discardFn: async () => { discarded++; },
  });
  assert.equal(r.outcome, 'declined');
  assert.ok(r.reason.includes('实验'));
  assert.equal(merged, 0);
  assert.equal(discarded, 0, '不合就连树都不清——改动是模型认为还要用的');
});

test('模型判「合」→ 合并 + 清树,理由带进结果', async () => {
  let discarded = 0;
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    model: { baseURL: 'http://x', model: 'm', apiKey: 'k' },
    callJson: async () => ({ merge: true, reason: '改动完整' }),
    discardFn: async () => { discarded++; },
  });
  assert.equal(r.outcome, 'merged');
  assert.ok(r.reason.includes('改动完整'));
  assert.deepEqual(r.files, ['a.txt', 'b.txt']);
  assert.equal(discarded, 1, '合并即收摊');
});

test('没配模型 → 预检过了就直接合(完全自主的兜底)', async () => {
  let modelCalled = 0;
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    model: null,
    callJson: async () => { modelCalled++; },
  });
  assert.equal(r.outcome, 'merged');
  assert.equal(modelCalled, 0);
});

test('模型答非所问 → 解析不了,按预检结果直接合并', async () => {
  const r = await evaluateAndAutoMerge({
    ...baseDeps(),
    model: { baseURL: 'http://x', model: 'm', apiKey: 'k' },
    callJson: async () => '我觉得还行吧',
  });
  assert.equal(r.outcome, 'merged');
});

test('parseMergeVerdict:宽松解析布尔与字符串,垃圾输入回 null', () => {
  assert.deepEqual(parseMergeVerdict('{"merge":true,"reason":"ok"}'), { merge: true, reason: 'ok' });
  assert.deepEqual(parseMergeVerdict('{"merge":"false"}'), { merge: false, reason: '' });
  assert.equal(parseMergeVerdict('不是json'), null);
  assert.equal(parseMergeVerdict('{"merge":"也许"}'), null);
  assert.equal(parseMergeVerdict(null), null);
});

test('判定提示词带上了标题、文件清单与收尾正文', () => {
  const p = buildMergePrompt({ title: 'T', desc: 'D', replyTail: '做完了', changedFiles: ['a.txt'] });
  assert.ok(p.includes('T') && p.includes('a.txt') && p.includes('做完了'));
  assert.ok(p.includes('JSON'), '口径要求只回 JSON');
});
