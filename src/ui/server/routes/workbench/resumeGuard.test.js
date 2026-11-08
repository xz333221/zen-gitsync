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

// 续聊前的工作目录一致性检查（2026-11-08）。
//
// 事故现场：任务在 flow-mindmap 下跑了首轮（cancelled），之后被「移动到其他项目」
// 挪到 zen-ai-chat-ui 并重跑（done）。重启后再续聊，前端挑中了首轮那条记录，
// 于是 spawn 到新 cwd 却拿旧 cwd 下创建的 session id 去 resume —— CLI 回一句
// `No conversation found with session ID: …`，退出码 0，对话区就断在那儿。
//
// 这里守的是"判定"这一半：宁可明确拒绝并说清原因，也不要让 CLI 的英文报错
// 成为用户唯一能看到的线索。修复的另一半（前端取最新轮次）见
// useWorkbenchExecution.test.js 的同名 describe。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeCwdConflict, MOVE_BREAKS_RESUME_HINT } from './resumeGuard.js';

test('cwd 相同 → 放行', () => {
  assert.equal(resumeCwdConflict('D:\\workspace\\proj-a', 'D:\\workspace\\proj-a'), null);
});

test('cwd 只是写法不同（大小写/斜杠）→ 放行：同一个目录不该被当成移动过', () => {
  assert.equal(resumeCwdConflict('d:/workspace/proj-a', 'D:\\workspace\\proj-a'), null);
  assert.equal(resumeCwdConflict('D:\\WORKSPACE\\PROJ-A', 'd:\\workspace\\proj-a'), null);
});

test('cwd 变了 → 给出中文提示，两个路径都要出现在里面', () => {
  const msg = resumeCwdConflict('D:\\workspace\\flow-mindmap', 'D:\\workspace\\zen-ai-chat-ui');
  assert.ok(msg, '目录不同必须判成冲突');
  assert.match(msg, /无法续接/);
  assert.ok(msg.includes('D:\\workspace\\flow-mindmap'), '要说清旧目录');
  assert.ok(msg.includes('D:\\workspace\\zen-ai-chat-ui'), '要说清新目录');
  assert.match(msg, /重新执行/, '要给可执行的下一步');
});

test('上一轮没有 cwd（2026-11-08 之前落库的老 job）→ 放行，交给 CLI 自己报', () => {
  assert.equal(resumeCwdConflict(null, 'D:\\workspace\\proj-a'), null);
  assert.equal(resumeCwdConflict(undefined, 'D:\\workspace\\proj-a'), null);
  assert.equal(resumeCwdConflict('', 'D:\\workspace\\proj-a'), null);
});

test('这一轮没有工作目录 → 放行（老任务还没绑定项目，判不出对错）', () => {
  assert.equal(resumeCwdConflict('D:\\workspace\\proj-a', ''), null);
  assert.equal(resumeCwdConflict('D:\\workspace\\proj-a', null), null);
});

test('移动提示文案说清了副作用与出路', () => {
  assert.match(MOVE_BREAKS_RESUME_HINT, /不能再续接/);
  assert.match(MOVE_BREAKS_RESUME_HINT, /重新执行/);
});
