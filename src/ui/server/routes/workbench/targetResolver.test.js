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
// 「指令该落到哪个项目」的纯函数单测。
//
// 这一层最贵的一次错误不是"没匹配上"，而是"匹配错了" —— 猜错的代价是把改动
// 做到错误的仓库里。所以断言重心在**不该匹配的时候坚决不匹配**：
// 同族名（claw-management / claw-management-api）、模型编造的路径、模型挂掉，
// 每一条都必须退到默认项目，而不是随手挑一个。
//
// 全程不碰网络：第 3 级靠 pickByAgent / callJson 注入点替换。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  indexOfToken,
  matchProjectMention,
  pickProjectByAgent,
  resolveInstructionTarget,
  TARGET_SOURCE,
  TARGET_SOURCES,
} from './targetResolver.js';

/** 清单里的 key 就是 canonicalProjectPath 的结果：盘符大写 + 斜杠归一 */
const PROJECTS = [
  { name: 'zen-gitsync', path: 'D:\\ws\\zen-gitsync', key: 'D:\\ws\\zen-gitsync' },
  { name: 'article-generator', path: 'D:\\ws\\article-generator', key: 'D:\\ws\\article-generator' },
  { name: 'claw-management', path: 'D:\\ws\\claw-management', key: 'D:\\ws\\claw-management' },
  { name: 'claw-management-api', path: 'D:\\ws\\claw-management-api', key: 'D:\\ws\\claw-management-api' },
  { name: 'claw-sdd', path: 'D:\\ws\\claw-sdd', key: 'D:\\ws\\claw-sdd' },
  { name: 'claw-sdd-project', path: 'D:\\ws\\claw-sdd-project', key: 'D:\\ws\\claw-sdd-project' },
];

const nameOf = (r) => r && r.project && r.project.name;

// ── indexOfToken：词边界 ────────────────────────────────────────────────

test('indexOfToken 只在"成词"处命中', () => {
  // claw-management 在 claw-management-api 里只是前半截，不算点名
  assert.equal(indexOfToken('改动 claw-management-api', 'claw-management'), -1);
  assert.equal(indexOfToken('改动 claw-management 的路由', 'claw-management'), 3);
  assert.equal(indexOfToken('改动 claw-management', 'claw-management'), 3);
  assert.equal(indexOfToken('Claw-Management', 'claw-management'), 0, '大小写不敏感');
  assert.equal(indexOfToken('', 'claw-management'), -1);
  assert.equal(indexOfToken('有内容', ''), -1);
});

// ── matchProjectMention：规则匹配 ───────────────────────────────────────

test('指名道姓的项目能被识别', () => {
  const m = matchProjectMention('给 article-generator 的导出加个进度条', PROJECTS);
  assert.equal(nameOf(m), 'article-generator');
  assert.equal(m.matched, 'article-generator');
});

test('同族名按词边界区分，绝不误伤邻居', () => {
  assert.equal(nameOf(matchProjectMention('修一下 claw-management-api', PROJECTS)), 'claw-management-api');
  assert.equal(nameOf(matchProjectMention('修一下 claw-management', PROJECTS)), 'claw-management');
  assert.equal(nameOf(matchProjectMention('看看 claw-sdd-project', PROJECTS)), 'claw-sdd-project');
  assert.equal(nameOf(matchProjectMention('看看 claw-sdd', PROJECTS)), 'claw-sdd');
});

test('完整路径优先于项目名', () => {
  const m = matchProjectMention(
    '把 D:\\ws\\article-generator 下的日志清一清，参考 zen-gitsync 的做法',
    PROJECTS,
  );
  assert.equal(nameOf(m), 'article-generator');
  assert.equal(m.matched, 'D:\\ws\\article-generator');
});

test('大小写不同的项目名也能认出来', () => {
  assert.equal(nameOf(matchProjectMention('重构 Article-Generator 的导出', PROJECTS)), 'article-generator');
});

test('没点名任何项目 -> null（不硬猜）', () => {
  assert.equal(matchProjectMention('把登录模块的错误处理重构一遍', PROJECTS), null);
  assert.equal(matchProjectMention('', PROJECTS), null);
  assert.equal(matchProjectMention('随便写点什么', []), null);
});

// ── pickProjectByAgent：模型返回值的校验 ─────────────────────────────────

test('pickProjectByAgent 只认清单里真实存在的路径', async () => {
  const model = { model: 'fake' };
  const ask = (reply) => pickProjectByAgent({
    text: '随便写点什么', projects: PROJECTS, model, callJson: async () => reply,
  });

  assert.equal(nameOf(await ask({ projectPath: 'D:\\ws\\article-generator' })), 'article-generator');
  // 盘符小写也要认（走 canonicalProjectPath 归一）
  assert.equal(nameOf(await ask({ projectPath: 'd:\\ws\\article-generator' })), 'article-generator');
  // 模型编出来的路径 -> 当作没判断出来，宁可退默认项目也不凭空造工作目录
  assert.equal(await ask({ projectPath: 'D:\\ws\\压根不存在的项目' }), null);
  assert.equal(await ask({ projectPath: '' }), null);
  assert.equal(await ask({}), null);
  assert.equal(await ask(null), null);
});

test('pickProjectByAgent 在没模型 / 没清单时直接放弃', async () => {
  assert.equal(await pickProjectByAgent({ text: 'x', projects: PROJECTS, model: null }), null);
  assert.equal(await pickProjectByAgent({ text: 'x', projects: [], model: { model: 'f' } }), null);
});

// ── resolveInstructionTarget：四级优先级 ────────────────────────────────

test('1. 显式指定永远压过指令内容', async () => {
  const r = await resolveInstructionTarget({
    text: '给 article-generator 加个功能',
    projects: PROJECTS,
    explicitPath: 'D:\\ws\\zen-gitsync',
    defaultPath: 'D:\\ws\\zen-gitsync',
  });
  assert.equal(r.source, TARGET_SOURCE.EXPLICIT);
  assert.equal(r.name, 'zen-gitsync');
});

test('2. 指令里点名 -> mention，且不为它多花一次模型调用', async () => {
  let asked = false;
  const r = await resolveInstructionTarget({
    text: '给 article-generator 加个进度条',
    projects: PROJECTS,
    defaultPath: 'D:\\ws\\zen-gitsync',
    getModel: async () => { asked = true; return { model: 'fake' }; },
  });
  assert.equal(r.source, TARGET_SOURCE.MENTION);
  assert.equal(r.name, 'article-generator');
  assert.equal(r.matched, 'article-generator');
  assert.equal(asked, false, '规则命中就不该再去读 config 问模型');
});

test('3. 规则没命中 -> 交给主 Agent 判断', async () => {
  let asked = false;
  const r = await resolveInstructionTarget({
    text: '把文章生成器的导出加个进度条',
    projects: PROJECTS,
    defaultPath: 'D:\\ws\\zen-gitsync',
    getModel: async () => { asked = true; return { model: 'fake' }; },
    pickByAgent: async ({ projects }) => ({
      project: projects.find(p => p.name === 'article-generator'),
      reason: '语义上指向文章生成器',
    }),
  });
  assert.equal(asked, true);
  assert.equal(r.source, TARGET_SOURCE.AGENT);
  assert.equal(r.name, 'article-generator');
  assert.equal(r.reason, '语义上指向文章生成器');
});

test('3b. 模型判断不出来 -> 退默认项目', async () => {
  const r = await resolveInstructionTarget({
    text: '随便改点什么',
    projects: PROJECTS,
    defaultPath: 'D:\\ws\\zen-gitsync',
    getModel: async () => ({ model: 'fake' }),
    pickByAgent: async () => null,
  });
  assert.equal(r.source, TARGET_SOURCE.DEFAULT);
  assert.equal(r.name, 'zen-gitsync');
});

test('3c. 模型抛错 -> 退默认项目，并把原因交给调用方（自己不抛）', async () => {
  let caught = null;
  const r = await resolveInstructionTarget({
    text: '随便改点什么',
    projects: PROJECTS,
    defaultPath: 'D:\\ws\\zen-gitsync',
    getModel: async () => ({ model: 'fake' }),
    pickByAgent: async () => { throw new Error('模型超时'); },
    onAgentError: (e) => { caught = e; },
  });
  assert.equal(r.source, TARGET_SOURCE.DEFAULT);
  assert.equal(r.name, 'zen-gitsync');
  assert.match(caught.message, /模型超时/);
});

test('3d. 没配模型 -> 直接退默认项目（不报错、不问模型）', async () => {
  let called = false;
  const r = await resolveInstructionTarget({
    text: '随便改点什么',
    projects: PROJECTS,
    defaultPath: 'D:\\ws\\zen-gitsync',
    getModel: async () => null,
    pickByAgent: async () => { called = true; return null; },
  });
  assert.equal(r.source, TARGET_SOURCE.DEFAULT);
  assert.equal(called, false);
});

test('4. 默认项目不在清单里也照用（原样返回，交给调用方去 stat）', async () => {
  const r = await resolveInstructionTarget({
    text: '',
    projects: PROJECTS,
    defaultPath: 'E:\\未注册的项目',
  });
  assert.equal(r.source, TARGET_SOURCE.DEFAULT);
  assert.equal(r.path, 'E:\\未注册的项目');
  assert.equal(r.name, '未注册的项目');
});

test('什么都没给 -> path 为空，由调用方决定怎么报错', async () => {
  const r = await resolveInstructionTarget({ text: 'x', projects: PROJECTS });
  assert.equal(r.path, '');
  assert.equal(r.source, TARGET_SOURCE.DEFAULT);
});

test('TARGET_SOURCES 是 UI 认得的四种来源（改这里要同步 lang/{zh,en}）', () => {
  assert.deepEqual([...TARGET_SOURCES].sort(), ['agent', 'default', 'explicit', 'mention']);
});
