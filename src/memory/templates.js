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
// 记忆库种子文件。**键是相对 MEMORY_DIR 的路径**，值是首次运行时铺进去的内容。
//
// 为什么要"随包带种子"而不是"运行时拼字符串":
//   · 种子本身要能被 review —— 它是每个用户都会看到的东西，写在代码里
//     散在几处 `if (!exists) write(...)` 里没人看得出全貌；
//   · 文案改动走 i18n 之外的单测（内容断言）比散落拼接好维护；
//   · 往后想加 RULES.md / 模板示例，只是多一个键。
//
// ⚠️ 铺种子的语义是 **only-if-missing**（见 store.js 的 ensureMemoryStore）：
// 用户和 Agent 在这些文件里写的内容永远不会被重置。
//
// ⚠️ 这里**不预填任何一条经验**。空库是合法状态 —— 产品不能替用户编造
// "经验"，只能把记账的目录和格式准备好。

/** @type {Record<string, string>} 相对 MEMORY_DIR 的路径 → 文件内容 */
export const MEMORY_SEED_FILES = {
  'INDEX.md': [
    '# 记忆索引 · 全局',
    '',
    '> **本文件是唯一默认进上下文的东西。** 正文一律懒加载。',
    '> 预算：≤30 行。超了就把细节下沉到各项目 lessons/。',
    '',
    '## 项目',
    '',
    '_（还没有项目条目。派发第一个任务时会自动补上。）_',
    '',
    '## 全局',
    '',
    '- [跨项目经验](GLOBAL.md) — 本机环境事实 · 沙箱工具边界 · 通用坑',
    '',
    '## 约定',
    '',
    '- 条目只写"先查什么 / 以后怎么做"，**不写"我做了什么"**（那是 commit message 的活）。',
    '- 单条 lesson ≤25 行；超过说明它是文档不是记忆 → 写进项目 `docs/`。',
    '- 项目索引 >40 条 或 30 天没整理 → 强制整理（同类合并 / 过时移 `archive/`）。',
    '',
  ].join('\n'),

  'GLOBAL.md': [
    '# 跨项目经验（热档）',
    '',
    '> 预算：≤40 行 / ≤3KB。只收"跟具体仓库无关、换个项目照样成立"的结论。',
    '> 项目特定的进 `projects/<slug>/INDEX.md`，别往这里塞。',
    '',
    '## 本机环境',
    '',
    '_（空。首次踩到"换台机器也成立"的坑时写这里。）_',
    '',
    '## 通用坑',
    '',
    '_（空。搜索命中被构建产物淹没、探针假绿、默认值测试假绿……这类先写这里。）_',
    '',
  ].join('\n'),

  'RULES.md': [
    '# 记忆库规范（完整版）',
    '',
    '> 这是**权威版本**。派发任务时注入 Agent 的是精简版（见 routes/workbench/memoryContext.js），',
    '> 两者口径一致；改规则先改这里。',
    '',
    '## 目录形状',
    '',
    '```',
    'memory/',
    '├── INDEX.md      全局索引 · 唯一默认进上下文的东西',
    '├── GLOBAL.md     跨项目经验正文 · ≤40 行 · 按需读',
    '├── RULES.md      本文件',
    '└── projects/<slug>/',
    '    ├── INDEX.md      本项目索引 · ≤40 条 / 每条 ≤100 字',
    '    ├── lessons/<topic>.md   正文 · 单条 ≤25 行 · 命中才读',
    '    └── archive/      冻结历史 · 永不读',
    '```',
    '',
    '`<slug>` = 仓库绝对路径 → 小写 → 非 `[a-z0-9_]` 的连续串压成一个 `-`。',
    '',
    '## 召回（开工时）',
    '',
    '1. 读全局 `INDEX.md`',
    '2. 当前仓库在「项目」段 → 读它的 `INDEX.md`，**到此为止**',
    '3. 索引某条关键词与当前任务相关 → 才 Read 对应的 `lessons/<topic>.md`',
    '4. 索引没命中但怀疑是通用坑 → 读 `GLOBAL.md`',
    '',
    '**不做**：不预加载全部 lessons、不读 `archive/`、不在没命中时硬读。',
    '',
    '## 捕获（收尾时）',
    '',
    '四问自检，**全为否就不写**：',
    '',
    '1. 本轮卡住 ≥3 分钟，或走了 A→取消→B→取消→C 的反复路径？',
    '2. 用错工具 / 写错文件 / grep 命中被构建产物淹没 / 探针假绿？',
    '3. 用户纠正过方向 / 用法 / 命名？',
    '4. 发现"看似绕路但更快"或"反直觉但正确"且被验证的做法？',
    '',
    '- 写成"以后怎么做"，不写"我做了什么"。',
    '- 一个主题一个文件；同主题**追加/改写**，不新建近似重复的。',
    '- 写完**必须**在对应 `INDEX.md` 补一行 —— 没索引的记忆等于不存在。',
    '',
  ].join('\n'),
};
