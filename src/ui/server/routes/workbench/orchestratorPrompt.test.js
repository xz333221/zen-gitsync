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
// 派发默认提示词的解析与归一单测。
//
// 这一层最贵的错误不是"没附加"，而是**附加到错误的项目上** —— 全局规则本来只该
// 出现在 A 项目，却因为路径写法不一致（`D:/ws/a` vs `d:\ws\a`）落到了 B 项目的
// 提示词上，用户从任务描述里根本看不出这句话是从哪来的。所以断言重心在
// 归一化命中与"不该命中的时候坚决不命中"。
//
// 全程不碰磁盘：resolveDispatchPrompt / normalizeOrchestrator 都是纯函数。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDispatchPrompt, normalizeOrchestrator, withInstructionPreview } from './orchestratorStore.js';
import { MAX_DEFAULT_PROMPT_CHARS, INSTRUCTION_PREVIEW_CHARS } from './shared.js';

/** 造一份最小可用的编排状态（字段与 normalizeOrchestrator 的输出对齐） */
function stateWith({ defaultPrompt = '', projectPrompts = {} } = {}) {
  return { version: 1, active: true, updatedAt: null, instructions: [], defaultPrompt, projectPrompts };
}

const KEY = 'd:\\ws\\alpha';

function projectEntry(prompt) {
  return { [KEY]: { path: 'D:\\ws\\alpha', prompt, updatedAt: null } };
}

test('什么都没设置时不附加任何东西', () => {
  const r = resolveDispatchPrompt(stateWith(), 'D:\\ws\\alpha');
  assert.equal(r.text, '');
  assert.equal(r.source, '');
});

test('只有全局提示词：所有项目都附加，来源记 global', () => {
  const r = resolveDispatchPrompt(stateWith({ defaultPrompt: '回答用中文' }), 'D:\\ws\\alpha');
  assert.equal(r.text, '回答用中文');
  assert.equal(r.source, 'global');
});

test('只有项目提示词：来源记 project', () => {
  const r = resolveDispatchPrompt(stateWith({ projectPrompts: projectEntry('用 pnpm') }), 'D:\\ws\\alpha');
  assert.equal(r.text, '用 pnpm');
  assert.equal(r.source, 'project');
});

test('两者都有：全局在前、项目在后，中间空行分隔', () => {
  const state = stateWith({ defaultPrompt: '回答用中文', projectPrompts: projectEntry('用 pnpm') });
  const r = resolveDispatchPrompt(state, 'D:\\ws\\alpha');
  assert.equal(r.text, '回答用中文\n\n用 pnpm');
  assert.equal(r.source, 'both');
});

test('项目路径写法不同（斜杠 / 大小写）仍然命中同一条项目提示词', () => {
  const state = stateWith({ projectPrompts: projectEntry('用 pnpm') });
  // 前端传过来的是项目清单里的原始写法，可能是正斜杠；存储键是归一化后的形式
  for (const p of ['D:/ws/alpha', 'D:\\WS\\ALPHA', 'd:/ws/alpha']) {
    const r = resolveDispatchPrompt(state, p);
    assert.equal(r.text, '用 pnpm', `路径写法 ${p} 应当命中`);
    assert.equal(r.source, 'project');
  }
});

test('别的项目有自己的提示词，不应被附加到本项目', () => {
  const state = stateWith({ projectPrompts: { 'd:\\ws\\beta': { path: 'D:\\ws\\beta', prompt: '只属于 beta' } } });
  const r = resolveDispatchPrompt(state, 'D:\\ws\\alpha');
  assert.equal(r.text, '');
  assert.equal(r.source, '');
});

test('落点为空（还没定项目）时只有全局生效，项目级那条不猜', () => {
  const state = stateWith({ defaultPrompt: '回答用中文', projectPrompts: projectEntry('用 pnpm') });
  const r = resolveDispatchPrompt(state, '');
  assert.equal(r.text, '回答用中文');
  assert.equal(r.source, 'global');
});

test('全局与项目级内容一模一样时只留一条，来源记为 global', () => {
  const same = '改完必须跑测试';
  const state = stateWith({ defaultPrompt: same, projectPrompts: projectEntry(same) });
  const r = resolveDispatchPrompt(state, 'D:\\ws\\alpha');
  assert.equal(r.text, same);
  assert.equal(r.source, 'global');
});

test('纯空白等同没设置（"清空"与"没填过"必须是同一个状态）', () => {
  const state = stateWith({ defaultPrompt: '   \n  ', projectPrompts: projectEntry('  ') });
  const r = resolveDispatchPrompt(state, 'D:\\ws\\alpha');
  assert.equal(r.text, '');
  assert.equal(r.source, '');
});

test('拼出来的正文永远不会超过任务提示词字段的上限', () => {
  const full = 'x'.repeat(MAX_DEFAULT_PROMPT_CHARS);
  const state = stateWith({ defaultPrompt: full, projectPrompts: projectEntry(full + 'y') });
  const r = resolveDispatchPrompt(state, 'D:\\ws\\alpha');
  assert.equal(r.text.length, MAX_DEFAULT_PROMPT_CHARS);
});

// ── 归一化：磁盘上的脏数据不能让编排台打不开 ──────────────────────────

test('normalizeOrchestrator：字段全缺时给出空提示词与空表', () => {
  const s = normalizeOrchestrator({ active: true, instructions: [] });
  assert.equal(s.defaultPrompt, '');
  assert.deepEqual(s.projectPrompts, {});
});

test('normalizeOrchestrator：非对象 / 数组一律当没设置', () => {
  for (const dirty of [null, 'nope', 42, [], { projectPrompts: [] }]) {
    const s = normalizeOrchestrator(dirty);
    assert.equal(s.defaultPrompt, '');
    assert.deepEqual(s.projectPrompts, {});
  }
});

test('normalizeOrchestrator：空提示词的条目直接丢掉，不留空壳', () => {
  const s = normalizeOrchestrator({
    projectPrompts: {
      'd:\\ws\\alpha': { path: 'D:\\ws\\alpha', prompt: '   ' },
      'd:\\ws\\beta': { path: 'D:\\ws\\beta', prompt: '保留' },
      'd:\\ws\\gamma': null,
    },
  });
  assert.deepEqual(Object.keys(s.projectPrompts), ['d:\\ws\\beta']);
  assert.equal(s.projectPrompts['d:\\ws\\beta'].path, 'D:\\ws\\beta');
});

test('normalizeOrchestrator：超长提示词按上限截断', () => {
  const s = normalizeOrchestrator({
    defaultPrompt: 'x'.repeat(MAX_DEFAULT_PROMPT_CHARS + 500),
    projectPrompts: projectEntry('y'.repeat(MAX_DEFAULT_PROMPT_CHARS + 500)),
  });
  assert.equal(s.defaultPrompt.length, MAX_DEFAULT_PROMPT_CHARS);
  assert.equal(s.projectPrompts[KEY].prompt.length, MAX_DEFAULT_PROMPT_CHARS);
});

test('normalizeOrchestrator：指令的 promptSource 只认白名单，脏值归空串', () => {
  const s = normalizeOrchestrator({
    instructions: [
      { id: 'a', text: '一', promptSource: 'both' },
      { id: 'b', text: '二', promptSource: 'global' },
      { id: 'c', text: '三', promptSource: '瞎写的' },
      { id: 'd', text: '四' },
    ],
  });
  assert.deepEqual(s.instructions.map(i => i.promptSource), ['both', 'global', '', '']);
});

// ── 指令流水的「下发预览」截断（2026-09-29）────────────────────────────
//
// 指令上限从 4000 放宽到 100000 之后，唯一会先崩的是**5s 轮询**：
// /api/workbench/orchestrator 每轮下发 state.instructions 整份（200 条上限），
// 不截就是 200 × 100000 = 20MB 一轮。
//
// 关键在"截哪一份"：落盘那份（orchestrator.json）与任务正文（task.desc）必须完整 ——
// 指令流水的意义就是"我说过什么"能被翻到，而 Agent 侧的真相源清单指着那个文件。
// 所以这里守的是"只截下发、且如实标出被截过"。

test('withInstructionPreview：超长正文截到预览上限并标出已截断', () => {
  const long = 'x'.repeat(INSTRUCTION_PREVIEW_CHARS + 500);
  const r = withInstructionPreview({ id: 'a', text: long, status: 'accepted' });
  assert.equal(r.text.length, INSTRUCTION_PREVIEW_CHARS);
  assert.equal(r.textTruncated, true);
  // 其余字段一个都不能丢：前端要靠 status / projectPath / targetSource 渲染这行
  assert.equal(r.id, 'a');
  assert.equal(r.status, 'accepted');
});

test('withInstructionPreview：没超长时原样返回，且不误标截断', () => {
  const short = '一句话指令';
  const r = withInstructionPreview({ id: 'a', text: short });
  assert.equal(r.text, short);
  assert.equal(r.textTruncated, false);
  // 恰好等于上限不算超（截断口是 >）
  const atLimit = withInstructionPreview({ id: 'b', text: 'y'.repeat(INSTRUCTION_PREVIEW_CHARS) });
  assert.equal(atLimit.textTruncated, false);
  assert.equal(atLimit.text.length, INSTRUCTION_PREVIEW_CHARS);
});

test('withInstructionPreview：不改传入的记录（落盘那份必须还是完整的）', () => {
  const long = 'z'.repeat(INSTRUCTION_PREVIEW_CHARS + 10);
  const original = { id: 'a', text: long };
  withInstructionPreview(original);
  assert.equal(original.text.length, INSTRUCTION_PREVIEW_CHARS + 10, '截断只发生在返回的新对象上');
});

test('withInstructionPreview：脏输入不炸（缺 text / null / 非对象）', () => {
  assert.deepEqual(withInstructionPreview({ id: 'a' }), { id: 'a', text: '', textTruncated: false });
  assert.equal(withInstructionPreview(null).text, '');
  assert.equal(withInstructionPreview(undefined).text, '');
  assert.equal(withInstructionPreview({ text: 123 }).text, '');
});
