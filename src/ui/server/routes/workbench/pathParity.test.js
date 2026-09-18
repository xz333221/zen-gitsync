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
// 前后端项目路径归一的**口径一致性**守卫。
//
// 为什么值得单独一个测试文件：canonicalProjectPath 在前后端各实现一遍
// （后端 routes/workbench/projectRegistry.js、前端 utils/path.ts），
// 而它是「同一目录算不算同一个项目」的唯一判据 —— 两侧只要差一点点，
// 同一个目录就会在两侧落到不同 key 上，表现为项目凭空分裂成两个。
// 这个坑在本仓库**已经踩过两次**（斜杠方向一次、目录段大小写一次），
// 两次的原因都不是逻辑写错，而是"改了一侧忘了另一侧"。
//
// 所以这里不验证行为（行为由 projectRegistry.test.js 覆盖），只验证
// **两份源码里的归一表达式长得一样**。断言故意把规则内容也钉住：
// 谁要改规则，就得同时改两侧、并来这里把期望值一起改掉 —— 这正是想要的效果。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_FILE = path.join(here, 'projectRegistry.js');
const CLIENT_FILE = path.join(here, '..', '..', '..', 'client', 'src', 'utils', 'path.ts');

/**
 * 从源码里抠出归一规则那条 `return` 语句。
 *
 * 只匹配到行尾就够 —— 这条规则必须是一行纯表达式。哪天有人把它写成多行，
 * 这里会直接断言失败，比"默默不同步"好得多。
 */
function extractRule(file, label) {
  const src = readFileSync(file, 'utf8');
  const anchor = src.indexOf('export function canonicalProjectPath');
  assert.ok(anchor >= 0, `${label}(${file}) 里找不到 canonicalProjectPath 的定义`);
  const m = src.slice(anchor).match(/return\s+s\.replace\([^\n]*/);
  assert.ok(m, `${label} 的 canonicalProjectPath 里找不到 return s.replace(...) 这条归一表达式`);
  // 去掉行尾分号与多余空白，让"分号写不写"这种无关差异不参与比较
  return m[0].replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();
}

test('前后端 canonicalProjectPath 的归一规则逐字一致（两侧分叉 = 项目会分裂成两个）', () => {
  const server = extractRule(SERVER_FILE, '后端');
  const client = extractRule(CLIENT_FILE, '前端');
  assert.equal(
    client,
    server,
    '前端 utils/path.ts 与后端 projectRegistry.js 的归一规则必须逐字一致；\n' +
    `  后端: ${server}\n  前端: ${client}`,
  );
});

test('归一规则里的"大小写"那一步被钉住（两侧一起改错也是分叉）', () => {
  const rule = extractRule(SERVER_FILE, '后端');
  // 只钉"大小写"这一步：它是这轮新加的、也是踩过坑的那一步。
  // 斜杠归一与 POSIX 不动这两条由 projectRegistry.test.js 的行为断言守
  // （那边能直接验 `D:/ws/y` === `D:\ws\y` 和 `/home/Me/A` 原样返回，
  //  比在源码文本上抠字符串可靠得多）。
  assert.match(rule, /toLowerCase\(\)/, '必须小写化，否则 C:\\Users\\x 与 c:\\users\\x 会裂成两个项目');
  assert.doesNotMatch(rule, /toUpperCase\(\)/, '不该再转大写（旧口径只转盘符，已证明治不住目录段）');
});
