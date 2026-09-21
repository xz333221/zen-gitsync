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
// g ai 的 Skill 加载层。
//
// Skill 的形态就是「一个目录 + 内含 SKILL.md(YAML frontmatter: name / description)」,
// 与 Claude Code、Cursor 等工具共用同一套约定 —— 所以智能体页面里从广场装下来的
// skill 不需要任何转换就能被 g ai 直接读。
//
// 两级作用域(与安装目标一一对应):
//   - 项目级 <cwd>/.claude/skills/<id>/SKILL.md   仅该项目可见
//   - 全局级 ~/.zen-gitsync/ai/skills/<id>/SKILL.md  所有项目可见
// 同名时**项目级覆盖全局级**(与本仓库其他"项目配置优先"的口径一致)。
//
// 渐进式披露(progressive disclosure):
//   这里只把「名字 + 描述 + SKILL.md 路径」塞进系统提示词(每个 skill 约 30~50 token),
//   不注入正文。模型判断某个 skill 与当前任务相关时,自己用 read_file 去读那个路径。
//   这样装 50 个 skill 也不会把上下文撑爆,而且是本仓库已有工具集的零成本复用。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AI_SKILLS_DIR } from '../../paths.js';

// 单个 skill 目录下必须存在的入口文件名
export const SKILL_ENTRY = 'SKILL.md';

// 名字/描述的长度上限 —— 防止某个仓库里的 SKILL.md 写了 500 字的 description
// 把系统提示词挤爆。截断而不是丢弃,保证 skill 至少还能被看到。
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 400;
// 一次注入的最大 skill 数。超出的按 name 排序截断,并在提示词里说明还有多少个。
const MAX_SKILLS_IN_PROMPT = 60;

/**
 * 极简 frontmatter 解析。
 *
 * 只用支持 SKILL.md 里实际出现的形状:
 *   ---
 *   name: pdf
 *   description: "带引号的描述"
 *   description: 不带引号的描述
 *   description: >-
 *     折叠成一行
 *     的长描述
 *   ---
 * 刻意不引入 yaml 依赖(本包 dependencies 保持精简),
 * 也对不合法 frontmatter 保持宽容:解析不出来就退回空对象,由调用方用目录名兜底。
 *
 * @param {string} raw - 文件全文
 * @returns {{ attrs: Record<string,string>, body: string }}
 */
export function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { attrs: {}, body: text };

  const attrs = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim();

    // 折叠标量(> 或 >-):把后续所有缩进行用空格拼起来
    if (/^[>|][+-]?$/.test(value)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.join(value.startsWith('|') ? '\n' : ' ');
    } else {
      // 行内可能是个多行序列的开头(description: 后直接换行缩进),同样收进来
      const parts = [value];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(lines[i + 1])) {
        parts.push(lines[++i].trim());
      }
      value = parts.filter(Boolean).join(' ').trim();
    }

    // 去掉包裹的引号
    value = value.replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (value) attrs[key] = value;
  }
  return { attrs, body: text.slice(match[0].length) };
}

function clamp(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 目录名兜底转可读名:my-cool-skill → my cool skill
function prettifyDirName(dirName) {
  return String(dirName || '').replace(/[-_]+/g, ' ').trim();
}

/**
 * 读取一个 skills 根目录下的所有 skill。
 * 单个 skill 读失败只跳过它,不影响同目录下其他 skill(一个坏文件不该让整批消失)。
 *
 * @param {string} root - skills 根目录(其下每个子目录是一个 skill)
 * @param {'project'|'global'} scope
 * @returns {Promise<Array<object>>}
 */
async function readSkillRoot(root, scope) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const file = path.join(root, entry.name, SKILL_ENTRY);
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    const { attrs } = parseFrontmatter(raw);
    found.push({
      id: entry.name,
      name: clamp(attrs.name || prettifyDirName(entry.name) || entry.name, MAX_NAME_CHARS),
      description: clamp(attrs.description || '', MAX_DESCRIPTION_CHARS),
      dir: path.join(root, entry.name),
      file,
      scope,
    });
  }
  return found;
}

/**
 * 加载项目级 + 全局级 skill,项目级覆盖同名全局 skill。
 *
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ skills: Array<object>, errors: Array<{ root: string, message: string }> }>}
 */
export async function loadSkills({ cwd } = {}) {
  const roots = [];
  if (cwd) roots.push({ root: path.join(path.resolve(cwd), '.claude', 'skills'), scope: 'project' });
  roots.push({ root: AI_SKILLS_DIR, scope: 'global' });

  const skills = [];
  const errors = [];
  for (const { root, scope } of roots) {
    try {
      skills.push(...await readSkillRoot(root, scope));
    } catch (err) {
      errors.push({ root, message: err.message });
    }
  }

  // 项目级优先:全局的先放,项目级后放覆盖同 id 的
  const byId = new Map();
  for (const skill of skills) {
    const existing = byId.get(skill.id);
    if (!existing || skill.scope === 'project') byId.set(skill.id, skill);
  }
  const merged = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills: merged, errors };
}

/**
 * 把已安装的 skill 渲染成系统提示词片段。
 * 没有 skill 时返回空串,调用方直接拼接到提示词末尾即可(不会留下空标题)。
 *
 * @param {Array<object>} skills
 * @param {{ locale?: string }} [options]
 * @returns {string}
 */
export function buildSkillsPrompt(skills, { locale } = {}) {
  if (!Array.isArray(skills) || skills.length === 0) return '';
  const zh = !String(locale || '').startsWith('en');
  const shown = skills.slice(0, MAX_SKILLS_IN_PROMPT);
  const omitted = skills.length - shown.length;

  const lines = shown.map(skill => {
    const scope = skill.scope === 'project' ? (zh ? '项目' : 'project') : (zh ? '全局' : 'global');
    const desc = skill.description || (zh ? '(无描述)' : '(no description)');
    return `- **${skill.name}** [${scope}] — ${desc}\n  ${zh ? '说明书' : 'instructions'}: ${skill.file}`;
  });

  if (zh) {
    return `

# 已安装的 Skill(技能说明书)
用户可以随时给 g ai 装新的 Skill。下面是当前可用的清单,**只列出了名字、用途和说明书路径**。
当某个 Skill 明显贴合当前任务时,先用 read_file 读它的说明书,再严格按说明书的步骤执行 —— 不要凭名字猜测它的做法。
${lines.join('\n')}${omitted > 0 ? `\n(还有 ${omitted} 个 Skill 未列出,用户可以缩小范围或自行告知)` : ''}`
  }

  return `

# Installed skills
The user can install new skills for g ai at any time. Below is the current list — **name, purpose and the path to its instructions only**.
When a skill clearly matches the current task, read its instruction file with read_file first, then follow it literally. Never guess what a skill does from its name.
${lines.join('\n')}${omitted > 0 ? `\n(${omitted} more skills are not listed; the user can narrow it down or name one directly)` : ''}`
}

export default { loadSkills, buildSkillsPrompt, parseFrontmatter, SKILL_ENTRY };
