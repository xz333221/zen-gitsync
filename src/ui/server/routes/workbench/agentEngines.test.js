// 引擎注册表单测。
//
// 最要紧的一条是**不新写清单**：外部三家必须与 config.js 的 TASK_EXECUTORS 同源。
// 本仓库为"同一份口径各写一遍"吃过亏（提示词四处、路径归一三处），分叉的失效方式是
// 「不报错，两个入口表现不一样」—— 加第四家 CLI 时若只改了工作台，这里就会静默漏掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ENGINES,
  BUILTIN_ENGINE,
  ENGINE_LABELS,
  EXTERNAL_ENGINES,
  engineLabel,
  isAgentEngine,
  isExternalEngine,
  normalizeAgentEngine,
} from './agentEngines.js';
import { TASK_EXECUTORS } from '../../../../config.js';

test('外部引擎清单与 config.js 同源（加第四家只该改一处）', () => {
  assert.deepEqual(EXTERNAL_ENGINES, TASK_EXECUTORS, '外部引擎必须直接复用 TASK_EXECUTORS');
  assert.equal(EXTERNAL_ENGINES, TASK_EXECUTORS, '应当是同一个数组引用，不是复制一份');
});

test('内置引擎排第一（前端下拉默认选首项）', () => {
  assert.equal(AGENT_ENGINES[0], BUILTIN_ENGINE);
  assert.equal(BUILTIN_ENGINE, 'gai');
  assert.equal(new Set(AGENT_ENGINES).size, AGENT_ENGINES.length, 'id 不能重复');
});

test('每个引擎都有展示名', () => {
  for (const id of AGENT_ENGINES) {
    assert.ok(ENGINE_LABELS[id], `${id} 缺展示名`);
  }
});

test('normalizeAgentEngine:非法值一律回落内置引擎（老前端不带这个字段）', () => {
  assert.equal(normalizeAgentEngine(undefined), 'gai');
  assert.equal(normalizeAgentEngine(null), 'gai');
  assert.equal(normalizeAgentEngine(''), 'gai');
  assert.equal(normalizeAgentEngine('  '), 'gai');
  assert.equal(normalizeAgentEngine('CLAUDE'), 'claude', '要容错大小写与首尾空格');
  assert.equal(normalizeAgentEngine(' claude '), 'claude');
  assert.equal(normalizeAgentEngine('gemini'), 'gai', '未知引擎回落，而不是报错');
  assert.equal(normalizeAgentEngine(42), 'gai');
});

test('isAgentEngine / isExternalEngine 的边界', () => {
  assert.equal(isAgentEngine('gai'), true);
  assert.equal(isAgentEngine('claude'), true);
  assert.equal(isAgentEngine('nope'), false);
  assert.equal(isAgentEngine(undefined), false);
  // gai 是内置的，不是外部引擎 —— 两条链路的分派全靠这个判据
  assert.equal(isExternalEngine('gai'), false);
  assert.equal(isExternalEngine('claude'), true);
  assert.equal(isExternalEngine('opencode'), true);
  assert.equal(isExternalEngine('codex'), true);
});

test('engineLabel:未知值回落内置引擎名（不显示 undefined）', () => {
  assert.equal(engineLabel('claude'), 'Claude Code');
  assert.equal(engineLabel('gai'), 'g ai');
  assert.equal(engineLabel('whatever'), 'g ai');
});
