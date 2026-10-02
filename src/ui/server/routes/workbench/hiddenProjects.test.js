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
// 「已移除项目」名单的纯函数单测：filterHiddenProjects。
// 落盘那半（readHiddenProjects / hideProject）要真写 DATA_DIR，不在单测里跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterHiddenProjects } from './hiddenProjects.js';

const P = (key, exists) => ({ key, path: key, name: key.split(/[\\/]/).pop(), exists });

test('filterHiddenProjects: 藏起来且目录不存在 → 滤掉', () => {
  const list = [P('a', true), P('b', false)];
  assert.deepEqual(filterHiddenProjects(list, ['b']).map(p => p.key), ['a']);
});

test('filterHiddenProjects: 没在隐藏名单里的一律留着', () => {
  const list = [P('a', false), P('b', false)];
  assert.equal(filterHiddenProjects(list, ['c']).length, 2);
  assert.equal(filterHiddenProjects(list, []).length, 2);
});

test('filterHiddenProjects: 目录回来了就自己现身（自愈，不做永久隐藏）', () => {
  // 这条是"不硬改任务 projectPath"那套设计的兜底：用户清掉的只是死条目，
  // 不是永久放弃这个项目。目录哪天被重新克隆回来，它必须自己回到清单里。
  assert.equal(filterHiddenProjects([P('b', true)], ['b']).length, 1);
});

test('filterHiddenProjects: exists === null（没探到）不隐藏 —— 不知道 ≠ 用户不要看', () => {
  // 与 projectRegistry 的三态口径一致：只有明确探到 false 才算"目录没了"。
  // 把 null 当 false 会让一次探测超时的项目从清单里凭空消失，比多显示一行更糟。
  assert.equal(filterHiddenProjects([P('b', null)], ['b']).length, 1);
});

test('filterHiddenProjects: 空名单直接原样返回，不复制数组', () => {
  const list = [P('a', true)];
  assert.equal(filterHiddenProjects(list, new Set()), list);
  // 名单为空时没有逐条过滤的必要，也就不该因为过滤而产生新数组引用
  // （board 那边拿它跟 selectedKey 比对，少一次引用变更少一次无谓的 watch 触发）
  assert.equal(filterHiddenProjects(list, null), list);
});

test('filterHiddenProjects: 入参不是数组时返回空数组，不抛', () => {
  assert.deepEqual(filterHiddenProjects(undefined, ['a']), []);
  assert.deepEqual(filterHiddenProjects(null, ['a']), []);
  assert.deepEqual(filterHiddenProjects([P('a', true)], undefined).length, 1);
});