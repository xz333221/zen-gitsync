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
// 系统提示词里「远程仓库 CLI」那一段的**口径一致性**守卫。
//
// 为什么需要：同一段能力说明在四个地方各写一遍 ——
//   CLI 端 agent.js 的 zh / en，Web 端 agentChat.js 的 zh / en。
// 这个仓库为"改了一侧忘了另一侧"专门吃过亏（见同目录 pathParity.test.js 的注释：
// 路径归一规则分叉，同一个目录裂成两个项目）。提示词的失效方式更隐蔽：
// 少写一条**不会报错**，只会让模型在某些入口下做出错误行为 ——
// 比如漏掉「Gitee 未登录时退出码仍是 0」，Web 端就会一口咬定用户已登录。
//
// 所以这里不验证模型行为（没法验），只钉住"四条口径必须覆盖同样的事实"。
// 断言故意把关键事实钉死：谁要删一条，就得同时删四处、并来这里改期望值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 两个提示词文件分处两棵树：CLI 端在 src/cli/ai/，Web 端在 src/ui/server/。
// 测试落在 Web 端这一侧，只是因为同目录已有同族的 pathParity.test.js。
const PROMPT_FILES = [
  { label: 'CLI 端 agent.js', file: path.join(here, '..', '..', '..', '..', 'cli', 'ai', 'agent.js') },
  { label: 'Web 端 agentChat.js', file: path.join(here, 'agentChat.js') },
];

const HEADER_ZH = '# 远程仓库(GitHub / Gitee)';
const HEADER_EN = '# Remote repositories (GitHub / Gitee)';

/**
 * 抠出某个 header 到下一个 `# ` 标题之间的正文。
 *
 * 用"下一个一级标题"当右边界，而不是匹配到文件尾：提示词后面还有
 * 权限 / 工作方式 / 交互 / 输出若干段，一起卷进来会把"这一段覆盖了什么"
 * 的断言变得没有意义（别处的字样会让断言假通过）。
 */
function extractSection(src, header, label) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `${label} 里找不到提示词段落 ` + '`' + header + '`');
  const rest = src.slice(start + header.length);
  const end = rest.search(/\n# /);
  return end >= 0 ? rest.slice(0, end) : rest;
}

/** 每个文件必须中文、英文各一段 —— 少一段说明有人删了或换了标题写法。 */
test('四个入口的提示词里都带着「远程仓库」段落（CLI/Web × 中/英）', () => {
  for (const { label, file } of PROMPT_FILES) {
    const src = readFileSync(file, 'utf8');
    for (const header of [HEADER_ZH, HEADER_EN]) {
      assert.ok(
        src.includes(header),
        `${label} 缺少 ${header} 段落；新增 CLI 能力说明时必须四个入口一起加`,
      );
    }
  }
});

/**
 * 四条口径必须覆盖同样的事实。
 *
 * 用 `commands` 做的是**跨语言**的对齐检查：命令串和 JSON 字段名是中英共用的，
 * 所以"中文写了 gh auth status、英文漏了"这种最容易犯的错会在这里暴露。
 */
const FACTS = [
  {
    what: '本项目远端走 git remote -v（不依赖 CLI 的兜底路径）',
    zh: ['git remote -v'],
    en: ['git remote -v'],
    commands: ['git remote -v'],
  },
  {
    what: 'GitHub 列仓库用 gh repo list',
    zh: [/gh repo list/],
    en: [/gh repo list/],
    commands: ['gh repo list --limit 50'],
  },
  {
    what: 'Gitee 列仓库用 gitee repo list',
    zh: [/gitee repo list/],
    en: [/gitee repo list/],
    commands: ['gitee repo list'],
  },
  {
    what: '两个平台的登录态检查命令',
    zh: [/gh auth status/, /gitee auth status/],
    en: [/gh auth status/, /gitee auth status/],
    commands: ['gh auth status', 'gitee auth status'],
  },
  {
    // 这条是踩过的坑：gitee CLI 未登录时退出码是 0（实测 v0.3.1），
    // 只看退出码会永远认为"已登录"。提示词里必须留一句，否则模型会误报。
    what: 'Gitee 未登录时退出码仍是 0 这个反直觉行为',
    zh: [/退出码/],
    en: [/exit code is still 0/],
    commands: [],
  },
  {
    // 装完没重启服务时 CLI 不在 PATH 里，模型此时最危险的动作是
    // "换个写法再试"和"凭印象编仓库名" —— 两句都要明确禁掉。
    what: 'CLI 找不到时的处置：不重试、不编造',
    zh: [/不要换写法反复重试/, /不要凭印象编/],
    en: [/do NOT retry with a different spelling/, /do NOT invent/],
    commands: [],
  },
  {
    what: '不许索要 / 粘贴 token（凭据由 CLI 自己保管）',
    zh: [/绝不向用户索要 token/],
    en: [/Never ask the user for a token/],
    commands: [],
  },
  {
    // 用户明确提过的偏好：让 AI 克隆仓库时优先 SSH。走 https 会弹 Git Credential Manager，
    // 把任务停在半路等人输账号密码（实测）。四个入口都得守同一条，否则从某个入口克隆
    // 又会退回去走 https —— 这类"少写一条不报错"的失效方式正是本文件存在的理由。
    what: '克隆 / 加远端优先 SSH（https 先换算，无密钥才退回）',
    zh: [/优先用 SSH/, /git@github\.com:owner\/repo\.git/, /Permission denied \(publickey\)/],
    en: [/prefer SSH/, /git@github\.com:owner\/repo\.git/, /Permission denied \(publickey\)/],
    commands: ['git@github.com:owner/repo.git', 'git@gitee.com:owner/repo.git', 'git remote set-url origin'],
  },
];

test('四条提示词覆盖同样的事实，命令串逐字一致（跨语言对齐）', () => {
  const sections = [];
  for (const { label, file } of PROMPT_FILES) {
    const src = readFileSync(file, 'utf8');
    sections.push({ label: `${label} · zh`, text: extractSection(src, HEADER_ZH, label) });
    sections.push({ label: `${label} · en`, text: extractSection(src, HEADER_EN, label) });
  }
  assert.equal(sections.length, 4, '恰好四个入口：CLI/Web × 中/英');

  for (const fact of FACTS) {
    for (const section of sections) {
      const isEn = section.label.endsWith('· en');
      for (const pattern of (isEn ? fact.en : fact.zh)) {
        const hit = typeof pattern === 'string' ? section.text.includes(pattern) : pattern.test(section.text);
        assert.ok(
          hit,
          `${section.label} 里缺少「${fact.what}」；该事实在四个入口必须一致，` +
            `缺一条不会报错，只会让某个入口下的模型行为变错`,
        );
      }
    }
    // 命令串与字段名跨语言共用 —— 这一层能抓住"中文写了、英文漏了"
    for (const cmd of fact.commands) {
      for (const section of sections) {
        assert.ok(
          section.text.includes(cmd),
          `${section.label} 里缺少命令 \`${cmd}\`（「${fact.what}」）；中英两版必须用同一条命令`,
        );
      }
    }
  }
});

test('段落里不得暗示可以绕过凭据（不出现 token 输入类指引）', () => {
  for (const { label, file } of PROMPT_FILES) {
    const src = readFileSync(file, 'utf8');
    for (const header of [HEADER_ZH, HEADER_EN]) {
      const section = extractSection(src, header, label);
      assert.doesNotMatch(
        section,
        /(粘|粘贴|输入|提供)\s*(一个)?\s*token/i,
        `${label} 的段落里出现"让用户提供 token"类表述：凭据必须由 CLI 自己保管`,
      );
      assert.doesNotMatch(
        section,
        /paste\s+(a\s+)?token/i,
        `${label} 的段落里出现 "paste a token" 类表述：凭据必须由 CLI 自己保管`,
      );
    }
  }
});
