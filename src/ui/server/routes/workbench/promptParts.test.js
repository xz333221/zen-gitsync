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
// prompt 正文拼装的单测。
//
// 回归目标：主 Agent 派发建的简单任务（title = desc 首行）曾把同一句话拼两遍进 prompt ——
// 实测 job.prompt 是「帮我拉取一下代码\n\n帮我拉取一下代码」。
// 这里把"什么算重复、什么不算"钉死，避免以后又把用户手填的标题误删、或漏掉截断情形。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composePromptBody } from './promptParts.js';

test('单行指令：title 与 desc 逐字相同时只出现一次', () => {
  const out = composePromptBody('', '帮我拉取一下代码', '帮我拉取一下代码');
  assert.equal(out, '帮我拉取一下代码');
  // 反例锚点：这正是修复前的产物
  assert.notEqual(out, '帮我拉取一下代码\n\n帮我拉取一下代码');
});

test('多行描述：title 就是首行时只留描述全文（首行不重复）', () => {
  const out = composePromptBody('', '重构登录', '重构登录\n把错误处理抽成 composable');
  assert.equal(out, '重构登录\n把错误处理抽成 composable');
});

test('派发路径的截断：title 是超长首行的前 120 字时仍判为重复', () => {
  const firstLine = 'A'.repeat(200);
  const title = firstLine.slice(0, 120); // 与 dispatch 路由的 slice(0,120) 同口径
  const desc = `${firstLine}\n第二行`;
  assert.equal(composePromptBody('', title, desc), desc);
});

test('标题被描述完整包含（后接其它文字）也算重复 —— 描述已含标题的全部信息', () => {
  const out = composePromptBody('', '拉取代码', '拉取代码（顺便更新依赖）');
  assert.equal(out, '拉取代码（顺便更新依赖）');
});

test('用户手填的标题与描述不同：两段都要保留', () => {
  const out = composePromptBody('', '修复登录白屏', '用户反馈登录页点确定后白屏，帮我定位');
  assert.equal(out, '修复登录白屏\n\n用户反馈登录页点确定后白屏，帮我定位');
});

test('标题只是描述中间出现过的词，不算重复（不做子串匹配）', () => {
  const out = composePromptBody('', '登录', '修复登录白屏');
  // '修复登录白屏' 的首行不以 '登录' 开头 → 两段都在
  assert.equal(out, '登录\n\n修复登录白屏');
});

test('模板 + 不重复的标题/描述：三段按序拼接', () => {
  const out = composePromptBody('请用中文回答', '重构登录', '把错误处理抽成 composable');
  assert.equal(out, '请用中文回答\n\n重构登录\n\n把错误处理抽成 composable');
});

test('模板不参与去重：与标题相同也不删', () => {
  const out = composePromptBody('重构登录', '重构登录', '把错误处理抽成 composable');
  assert.equal(out, '重构登录\n\n重构登录\n\n把错误处理抽成 composable');
});

test('空段一律不占位，不产生多余空行', () => {
  assert.equal(composePromptBody('', '', '仅描述'), '仅描述');
  assert.equal(composePromptBody('', '仅标题', ''), '仅标题');
  assert.equal(composePromptBody('模板', '', ''), '模板');
  assert.equal(composePromptBody('', '', ''), '');
  assert.equal(composePromptBody('   ', '  ', '\n'), '');
});

test('判定用 trim 值，但拼进 prompt 的是原值（缩进与结尾换行保持原样）', () => {
  const desc = '  缩进的描述\n';
  assert.equal(composePromptBody('', '  缩进的描述\n', desc), desc);
});
