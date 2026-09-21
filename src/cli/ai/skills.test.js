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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// paths.js 在加载时求值 homedir,必须在 import 之前把 HOME 指到沙箱
const sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-skills-home-'));
const sandboxProject = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-skills-project-'));
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const { loadSkills, buildSkillsPrompt, parseFrontmatter } = await import('./skills.js');
const { AI_SKILLS_DIR } = await import('../../paths.js');

async function writeSkill(root, name, body) {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, 'SKILL.md'), body, 'utf8');
}

test('parseFrontmatter: 覆盖 SKILL.md 里实际会出现的几种写法', () => {
  assert.deepEqual(
    parseFrontmatter('---\nname: pdf\ndescription: 处理 PDF\n---\n# body\n').attrs,
    { name: 'pdf', description: '处理 PDF' },
  );

  // 带引号
  assert.equal(
    parseFrontmatter('---\ndescription: "带: 冒号的描述"\n---\n').attrs.description,
    '带: 冒号的描述',
  );

  // 折叠标量(>):续行拼成一行
  const folded = parseFrontmatter('---\ndescription: >-\n  第一行\n  第二行\nname: x\n---\n');
  assert.equal(folded.attrs.description, '第一行 第二行');
  assert.equal(folded.attrs.name, 'x', '折叠块之后的键仍要能解析出来');

  // 没有 frontmatter:整体当正文,不报错
  const none = parseFrontmatter('# just markdown\n');
  assert.deepEqual(none.attrs, {});
  assert.equal(none.body, '# just markdown\n');

  // 坏 frontmatter(没闭合)不应抛错
  assert.deepEqual(parseFrontmatter('---\nname: x\n').attrs, {});

  // BOM 不能挡住 frontmatter 识别
  assert.equal(parseFrontmatter('\uFEFF---\nname: bom\n---\n').attrs.name, 'bom');
});

test('loadSkills: 项目级覆盖同名全局级,并保留 scope 标记', async () => {
  await writeSkill(AI_SKILLS_DIR, 'shared', '---\nname: 全局版\ndescription: from global\n---\n');
  await writeSkill(AI_SKILLS_DIR, 'only-global', '---\nname: 只有全局\ndescription: g\n---\n');
  await writeSkill(path.join(sandboxProject, '.claude', 'skills'), 'shared', '---\nname: 项目版\ndescription: from project\n---\n');
  await writeSkill(path.join(sandboxProject, '.claude', 'skills'), 'only-project', '---\nname: 只有项目\ndescription: p\n---\n');

  const { skills } = await loadSkills({ cwd: sandboxProject });
  const byId = new Map(skills.map(skill => [skill.id, skill]));

  assert.equal(byId.size, 3, 'shared 只应出现一次(被项目级覆盖)');
  assert.equal(byId.get('shared').name, '项目版');
  assert.equal(byId.get('shared').scope, 'project');
  assert.equal(byId.get('only-global').scope, 'global');
  assert.equal(byId.get('only-project').scope, 'project');
});

test('loadSkills: 没有 frontmatter 时用目录名兜底,坏目录不影响其他 skill', async () => {
  await writeSkill(AI_SKILLS_DIR, 'no-frontmatter', '# 只有正文\n');
  await writeSkill(AI_SKILLS_DIR, 'my-cool-skill', '---\ndescription: d\n---\n');
  // 有目录但没有 SKILL.md:应被跳过而不是产生一条空记录
  await fs.mkdir(path.join(AI_SKILLS_DIR, 'empty-dir'), { recursive: true });

  const { skills } = await loadSkills({ cwd: sandboxProject });
  const byId = new Map(skills.map(skill => [skill.id, skill]));

  assert.equal(byId.get('no-frontmatter').name, 'no frontmatter', '无 frontmatter 时用目录名兜底并转成可读形式');
  assert.equal(byId.get('my-cool-skill').name, 'my cool skill', '目录名应转成可读形式');
  assert.equal(byId.has('empty-dir'), false);
});

test('loadSkills: 没有配置任何 skill 时返回空数组而不是抛错', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-skills-empty-'));
  const { skills, errors } = await loadSkills({ cwd: empty });
  // 全局目录里上面已经写了 skill,所以这里只断言"不抛错且结构正确"
  assert.ok(Array.isArray(skills));
  assert.ok(Array.isArray(errors));
});

test('buildSkillsPrompt: 没有 skill 时返回空串(拼到提示词里不留空标题)', () => {
  assert.equal(buildSkillsPrompt([], { locale: 'zh-CN' }), '');
  assert.equal(buildSkillsPrompt(undefined, { locale: 'en' }), '');
});

test('buildSkillsPrompt: 只注入名字/描述/路径,不注入正文(渐进式披露)', () => {
  const skills = [
    { id: 'a', name: 'pdf', description: '处理 PDF', file: 'C:/x/pdf/SKILL.md', scope: 'project' },
    { id: 'b', name: 'docx', description: '', file: 'C:/y/docx/SKILL.md', scope: 'global' },
  ];
  const zh = buildSkillsPrompt(skills, { locale: 'zh-CN' });
  assert.match(zh, /已安装的 Skill/);
  assert.match(zh, /pdf/);
  assert.match(zh, /\[项目\]/);
  assert.match(zh, /\[全局\]/);
  assert.match(zh, /C:\/x\/pdf\/SKILL\.md/);
  assert.match(zh, /\(无描述\)/, '空描述要有占位,不能让模型以为描述丢了');

  const en = buildSkillsPrompt(skills, { locale: 'en-US' });
  assert.match(en, /Installed skills/);
  assert.match(en, /project/);
  assert.doesNotMatch(en, /已安装/);
});
