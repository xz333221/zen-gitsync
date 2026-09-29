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
// 派发任务时注入给 Agent 的「记忆指针块」—— 让被派出去的 agent 知道
// 本机有一份跨会话经验库、以及**怎么按预算的方式去读它**。
//
// ── 与 envContext 的关系（同一个位置，两件事）────────────────────────
// envContext.js 讲的是"这台机器此刻的现场"（项目清单 / 看板 / 真相源路径），
// 快照语义、每次都变；这里讲的是"这个仓库踩过的坑"，长期累积、很少变。
// 两者都在 taskRunner.js 拼 prompt 时前置，注入失败都不该挡住任务执行。
//
// ── 为什么用"指针"而不是把索引内容塞进 prompt ───────────────────────
// 把 INDEX.md 全文塞进 prompt 是最省事也最糟的做法：索引会随记忆增长线性膨胀，
// 而**每次派发都要为每一条不相关的历史经验付 token**。塞路径 + 塞纪律（各 5~8 行），
// 剩下的交给 Agent 自己的 read 工具按需取 —— 这正是"索引式摘要"这个需求的核心。
//
// ⚠️ 文案可以硬编码中文（与 envContext.js 同一口径）：这里是喂给模型的 prompt
// 内容，不经过前端 $t()、不显示在界面上，也不该跟着界面语言变。
//
// 纯函数：只吃入参、不读文件、不做 IO。这样单测不用碰真实用户数据 ——
// 与 envContext.js / promptParts.js 同一个理由。取数在 store.js。

/** 指针块自身的体积上限（字节）。超了就是文案写飘了，Agent 读它比查索引还贵。 */
export const MEMORY_BLOCK_MAX_BYTES = 2048;

/** 状态标签：给 UI / 日志判断"这次注入了几层信息"，不参与 prompt 语义 */
export const MEMORY_BLOCK_LEVEL = {
  /** 记忆库不可用（目录不存在且铺种子失败）—— 完全不注入 */
  NONE: 'none',
  /** 库在，但没有本项目目录 —— 只给全局路径 */
  GLOBAL_ONLY: 'global-only',
  /** 库在且本项目目录在 —— 给全局 + 本项目两个路径 */
  PROJECT: 'project',
};

/**
 * 拼记忆指针块。
 *
 * @param {object}   input
 * @param {string}   input.memoryDir  记忆库根目录（~/<pkg>/memory 的绝对路径）
 * @param {string}   [input.projectIndexFile] 本项目索引绝对路径；空/不存在 → 只给全局那层
 * @param {boolean}  [input.capture=true] 是否附上"收尾时怎么记"那一段。
 *                    续聊轮可以关掉（同一场对话里第二、三轮再讲一遍捕获纪律是噪音）。
 * @param {string}   [input.locale] 暂未使用；预留让文案随界面语言走（中文硬编码是
 *                    当前口径，见文件头注释）
 * @returns {{ block: string, level: string }} block 为 '' 表示不注入
 */
export function buildMemoryPointerBlock(input = {}) {
  const {
    memoryDir = '',
    projectIndexFile = '',
    capture = true,
  } = input;

  if (!memoryDir) return { block: '', level: MEMORY_BLOCK_LEVEL.NONE };

  const lines = [
    '## 跨会话记忆库（本机）',
    '',
    `本机有一份长期经验库，是**之前在这个仓库干活的 agent 留下的坑**。开工前先查，别重复踩：`,
    '',
    `- 全局索引：\`${memoryDir}/INDEX.md\`（项目清单 + 通用坑主题词）`,
  ];

  let level = MEMORY_BLOCK_LEVEL.GLOBAL_ONLY;
  if (projectIndexFile) {
    lines.push(`- **本项目索引：\`${projectIndexFile}\`** ← 先读这个`);
    level = MEMORY_BLOCK_LEVEL.PROJECT;
  } else {
    lines.push('- 本项目还没有记忆库条目（首次在本仓库干活时会被自动建好）');
  }

  lines.push(
    '',
    '**怎么读（别烧 token）**：',
    '',
    '1. 用 read 工具读上面那个索引；',
    '2. 索引里某条的关键词和当前任务**真正相关**时，才去读它指向的 `lessons/<topic>.md`；',
    '3. 没命中就别读。**不要预加载全部 lessons，也不要读 `archive/`** —— ',
    '   索引是给你做取舍的，不是让你通读的。',
  );

  if (capture) {
    lines.push(
      '',
      '**收尾时（做完了、准备回复之前）自检一次**，四条里任意一条为"是"就记一条：',
      '',
      '1. 本轮卡住 ≥3 分钟，或走了 A→放弃→B→放弃→C 的反复路径；',
      '2. 用错了工具 / 写错了文件 / grep 命中被构建产物淹没 / 探针假绿；',
      '3. 用户纠正了你的方向、用法或命名；',
      '4. 发现"看似绕路但更快"或"反直觉但正确"、且被验证有效的做法。',
      '',
      '记的时候：',
      '',
      '- 写"**以后怎么做**"，不写"我做了什么"（后者是 commit message 的活）；',
      '- 单条 ≤25 行，形状 ` lessons/<topic>.md`：`# 一句话讲清坑是什么` / 现象根因 / `**How to apply:**`；',
      '- 同主题**追加/改写已有文件**，不要新建近似重复的（先 read 一眼）；',
      '- 跨仓库都成立 → 写 `${memoryDir}/GLOBAL.md`；只跟本仓库有关 → 写本项目 `lessons/`；',
      `- 写完**必须在对应 INDEX.md 补一行** \`- [标题](lessons/<file>.md) — ≤100 字摘要\`。**没索引的记忆等于不存在。**`,
      '- 四条全否 → 一条都别写。不要为沉淀而沉淀。',
    );
  }

  let block = lines.join('\n');

  // 文案哪天写飘了也不许把 prompt 撑大：超预算就砍掉捕获段（最长的可省部分），
  // 召回指针本身必须留着 —— 那是这个块存在的全部理由。
  if (Buffer.byteLength(block, 'utf8') > MEMORY_BLOCK_MAX_BYTES && capture) {
    lines.length = lines.findIndex((l) => l.includes('收尾时'));
    block = lines.join('\n').trimEnd();
  }

  return { block, level };
}
