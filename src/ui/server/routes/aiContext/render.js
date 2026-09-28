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
// 工作区状态快照的**拼装层**(纯函数,无 IO、无副作用,单测直接覆盖)。
//
// 为什么分成「一个板块一个文件 + 一份 INDEX」而不是一个大 JSON:
//   模型看的是"哪一块现在是什么状态"。塞成一个大文件,它每次都得整份读进上下文;
//   拆开后 INDEX 负责"一眼看全",具体板块才按需读 —— 这才是省 token 的形状。
//
// 为什么注入给模型的**只有摘要 + 路径**,不内联正文:
//   与 envContext.js 同一条理由(见该文件头第 28-29 行):几十条仓库/任务的全文既烧 token,
//   又会把用户真正要办的那句话淹掉。这里把它固化成契约 —— buildContextBlock 只吃
//   `summary` 字段,body 一行都不进(有单测钉住这条)。
//
// ⚠️ 快照最大的风险不是"没有数据",而是**过期数据被当成现状**。
//   所以每个文件头都写生成时间,注入块的收尾句也点名"这是快照"。少这一句,
//   模型会拿十分钟前的 git 状态理直气壮地回答"你现在没有未提交改动"。
//
// 文案为什么可以是中文硬编码:注入块走双语(用户 locale 可能是 en),而**文件正文**
// 一律中文 —— 与 envContext.js 第 31-34 行同一条判断:喂给模型的内容不经过前端 $t(),
// 也不显示在界面上,不该跟着界面语言变。

// 快照覆盖的板块。顺序即 INDEX 与注入块里的展示顺序(id 是取数据用的键,不要拿下标当键)。
//
// 每个板块两档时间参数 + 一句"实时怎么查":
//
// · `ttlMs` —— 软过期。后台自动刷新(面板切换、对话开始)时的判据:没到点就不重跑。
// · `forceTtlMs` —— 强制刷新时也要遵守的地板。前端"切到某面板就刷一次"会传 force,
//   但 github/gitee 这种要联网、单条命令 25s 超时的板块不能跟着被刷爆,所以给个地板;
//   本地板块(读文件、探 git、扫目录)一律 0 —— 它们刷一次是毫秒级,没必要留地板。
// · `queryHint` —— **要"现在"的值该跑什么命令**。快照天生会旧,所以真正扛实时性的
//   是这句话而不是快照本身:它被无条件注入(哪怕快照还没生成),模型照着跑就是真值。
export const AI_CONTEXT_SECTIONS = [
  {
    id: 'git',
    file: 'git-current.md',
    title: '当前项目 Git 状态',
    ttlMs: 15_000,
    forceTtlMs: 0,
    queryHint: 'run_command 跑 `git status --porcelain`（文件级改动清单）、`git status -sb`（分支与领先/落后）、`git remote -v`（远端）。都是本地信息，不联网、秒回',
  },
  {
    id: 'github',
    file: 'remote-github.md',
    title: 'GitHub 仓库',
    ttlMs: 300_000,
    forceTtlMs: 60_000,
    queryHint: 'run_command 跑 `gh repo list --limit 50 --json name,visibility,updatedAt,primaryLanguage`；登录态 `gh auth status`；某仓库详情 `gh repo view <owner/repo>`；PR `gh pr list`。要联网，timeout_seconds 给 30',
  },
  {
    id: 'gitee',
    file: 'remote-gitee.md',
    title: 'Gitee 仓库',
    ttlMs: 300_000,
    forceTtlMs: 60_000,
    queryHint: 'run_command 跑 `gitee repo list --json`（继续用 `--page` 翻页）；登录态看 `gitee auth status --json` 的 status 字段 —— **未登录时退出码也是 0**，只看退出码会误判成已登录。要联网，timeout_seconds 给 30',
  },
  {
    id: 'commands',
    file: 'custom-commands.md',
    title: '自定义命令',
    ttlMs: 60_000,
    forceTtlMs: 0,
    queryHint: 'read_file 读下面的 config.json，看 `customCommands` 数组（每条有 name / command / description）',
  },
  {
    id: 'tasks',
    file: 'workbench-tasks.md',
    title: '工作台任务',
    ttlMs: 30_000,
    forceTtlMs: 0,
    queryHint: 'read_file 读下面的 tasks.json 拿全部任务全文；执行记录在 jobs.json；也可以调 list_projects 工具（口径与看板界面完全一致）',
  },
  {
    id: 'system',
    file: 'system.md',
    title: '系统状态',
    ttlMs: 60_000,
    forceTtlMs: 0,
    queryHint: 'run_command 跑 `netstat -ano | findstr LISTENING`（Windows 端口占用）或 `tasklist`；CPU/内存用 `powershell -NoProfile "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize"`。**别用 Unix 的 top/free/ss**',
  },
  {
    id: 'mindmap',
    file: 'mindmap.md',
    title: '思维导图',
    ttlMs: 60_000,
    forceTtlMs: 0,
    queryHint: 'list_files 扫下面列出的思维导图目录，找 `*.mindmap.json`（这是本项目约定的扩展名）',
  },
];

export const INDEX_FILE = 'INDEX.md';

/** 单条摘要的字符上限。超了当场截断 —— 摘要失控就等于把正文搬进 prompt。 */
export const MAX_SUMMARY_CHARS = 200;

/** 未知板块的默认软过期时间 */
export const DEFAULT_SECTION_TTL_MS = 60 * 1000;

/**
 * 整个注入块的字符上限。
 * 非"硬切"用:超了先压缩摘要,再不行才丢摘要行 —— **实时查询方法一行都不许丢**,
 * 它是唯一能在快照过期时救场的东西(见下方 buildContextBlock)。
 */
export const MAX_CONTEXT_BLOCK_CHARS = 5000;

/** 超限时摘要的压缩档位 */
const SUMMARY_COMPACT_CHARS = 60;

/** 板块 id → 文件名 / 标题 */
export function sectionMeta(id) {
  return AI_CONTEXT_SECTIONS.find(s => s.id === id) || null;
}

/** 压成单行(换行/多空格归一并去首尾),摘要里不能出现换行 —— 会破坏一行一条的排版 */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** 单行截断,超长补省略号 */
export function truncate(text, max = MAX_SUMMARY_CHARS) {
  const s = oneLine(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 生成时间统一本地化展示 —— 模型据此判断新旧 */
export function formatStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * 把快照目录与板块文件名拼成绝对路径。
 *
 * 为什么需要它:注入块里每行摘要只写了裸文件名(`remote-gitee.md`),目录单独在顶部给一次。
 * 模型要自己把两者拼起来 —— 但**这一步它经常拼错**(拿 cwd 当基准拼成
 * `<项目目录>/remote-gitee.md`,读不到,然后回一句"我看不到"),而这恰恰是整个块
 * 反复叮嘱不要出现的结果。给定分隔符风格由 dir 自身决定(Windows 用 `\`、POSIX 用 `/`),
 * 这样单测跨平台断言也是稳定的。
 */
export function joinSnapshotPath(dir, file) {
  if (!dir) return file || '';
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${String(dir).replace(/[\\/]+$/, '')}${sep}${file || ''}`;
}

/** 板块的软过期时间;未知 id 回落到全局默认 */
export function sectionTtl(id, fallback = DEFAULT_SECTION_TTL_MS) {
  const n = sectionMeta(id)?.ttlMs;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 板块强制刷新时的地板间隔;未知 id 回落 0(不让它挡住刷新) */
export function sectionForceTtl(id) {
  const n = sectionMeta(id)?.forceTtlMs;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 板块的"实时怎么查"提示;未知 id 回空串 */
export function sectionQueryHint(id) {
  return sectionMeta(id)?.queryHint || '';
}

/**
 * 渲染单个板块文件。
 *
 * @param {object} input
 * @param {string} input.id           板块 id(用来取该板块的实时查询方法)
 * @param {string} input.title
 * @param {string} input.generatedAt  该板块**自己**的采集时间(每个板块独立刷新,不共用)
 * @param {string} [input.scope]      这份快照覆盖什么(如"当前项目 D:\ws\x")
 * @param {string[]} [input.lines]    正文行
 * @param {string} [input.error]      取数失败时的原因
 */
export function renderSectionFile({ id = '', title, generatedAt, scope = '', lines = [], error = '' } = {}) {
  const head = [`# ${title}`, '', `- 采集时间: ${generatedAt}`];
  if (scope) head.push(`- 覆盖范围: ${scope}`);
  head.push('- ⚠️ 这是**快照**,不是实时值。');
  // 每个文件里都带上"这一块怎么查实时值" —— 模型可能只读这一个文件就去回答
  const hint = sectionQueryHint(id);
  if (hint) head.push(`- 要实时值: ${hint}`);
  head.push('');

  if (error) {
    // 失败同样落盘。只写"空"会让模型把"取不到"读成"没有"——
    // 这正是 agentChat 系统提示里为 gh/gitee 反复叮嘱的那个坑。
    return [...head, `取数失败: ${oneLine(error)}`, '', '（不要据此推断"没有内容",请如实告诉用户这一块暂时取不到。）', ''].join('\n');
  }

  const body = (Array.isArray(lines) ? lines : []).map(l => String(l ?? ''));
  return [...head, ...body, ''].join('\n');
}

/**
 * 渲染 INDEX.md = 各板块的摘要总览。
 * 每个板块标各自的采集时间 —— 各板块是独立刷新的,共用一个时间会撒谎。
 *
 * @param {object} input
 * @param {string} [input.generatedAt] 本次汇总时间
 * @param {object[]} input.results [{ id, title, file, summary, ok, error, collectedAt }]
 */
export function renderIndexFile({ generatedAt = '', results = [] } = {}) {
  const lines = ['# 工作区状态快照 · INDEX', ''];
  if (generatedAt) lines.push(`- 本次汇总: ${generatedAt}`);
  lines.push('- ⚠️ 以下均为**快照**,各板块采集时间不同,注意看各自的时间;需要实时值请照每块给的方法自己查。', '');
  lines.push('## 各板块摘要', '');
  for (const r of results) {
    const name = r.title || r.id;
    const at = r.collectedAt ? `[${r.collectedAt}] ` : '';
    const text = r.ok ? truncate(r.summary || '（无内容）') : `取数失败: ${truncate(r.error || '未知原因', 120)}`;
    lines.push(`- ${at}${name}（${r.file}）: ${text}`);
  }
  lines.push('');
  lines.push('## 实时查询方法', '');
  for (const r of results) {
    const hint = sectionQueryHint(r.id);
    if (hint) lines.push(`- ${r.title || r.id}: ${hint}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 拼注入给模型的上下文块。
 *
 * 这个块的结构按**重要性**排,不是按阅读顺序:
 *   ① 实时查询方法 —— **无条件注入、绝不截断**。快照天生会旧,这一节才是"实时"的保证:
 *      它告诉模型每一块该跑什么命令,照着跑拿到的就是真值。冷启动(快照还没生成)时,
 *      整个块就只剩这一节 + 目录路径,依然有用。
 *   ② 各板块摘要 + **各自**的采集时间 —— 有就带上,让模型知道哪块新鲜哪块旧。
 *      各板块独立刷新,所以时间必须逐个标;共用一个时间就是在撒谎。
 *   ③ 真相源文件路径 —— 要细节自己去读。
 *
 * **只输出摘要与路径**,板块正文一律不进 —— 有单测钉住(见 render.test.js)。
 *
 * @param {object} input
 * @param {string} [input.generatedAt]  本次汇总时间
 * @param {object[]} [input.results]    [{ id, title, file, summary, ok, error, collectedAt }]
 * @param {string} [input.dirPath]      快照目录绝对路径
 * @param {object} [input.truthFiles]   { tasksFile, jobsFile, orchestratorFile, configFile }
 *                                      真相源路径（清单见 workbench/shared.js 的 TRUTH_FILES）
 * @param {string} [input.locale]       'zh' | 'en'
 * @returns {string} 永远不会是空串 —— 至少要给出实时查询方法
 */
export function buildContextBlock({
  generatedAt = '',
  results = [],
  dirPath = '',
  truthFiles = {},
  locale = 'zh',
} = {}) {
  const en = String(locale || '').startsWith('en');
  const list = Array.isArray(results) ? results.filter(Boolean) : [];

  /** 摘要按档位压缩:先正常,超限就缩、再超就整段丢 —— 丢的永远是摘要,不是查询方法 */
  const renderSummaries = (limit) => {
    const out = [];
    for (const r of list) {
      const name = r.title || r.id;
      if (limit === 0) {
        out.push(`- ${name} | ${r.file} | ${en ? 'see file' : '见文件'}`);
        continue;
      }
      const text = r.ok
        ? truncate(r.summary || (en ? '(empty)' : '（无内容）'), limit)
        : (en ? `unavailable: ${truncate(r.error || 'unknown', 60)}` : `暂时取不到: ${truncate(r.error || '未知原因', 60)}`);
      const at = r.collectedAt ? (en ? `（collected ${r.collectedAt}）` : `（采集于 ${r.collectedAt}）`) : '';
      out.push(`- ${name} | ${r.file} | ${text}${at}`);
    }
    return out;
  };

  const build = (summaryLines) => {
    const lines = [];
    lines.push(en
      ? '[Workspace state · auto-generated by zen-gitsync server, NOT user input]'
      : '[工作区状态 · 由 zen-gitsync 服务端自动生成，不是用户输入的内容]');
    lines.push('');
    if (generatedAt) lines.push(en ? `Summary built at: ${generatedAt}` : `本次汇总时间: ${generatedAt}`);
    if (dirPath) {
      lines.push(en
        ? `Snapshot folder (readable with your tools, no need to ask first): ${dirPath}`
        : `快照目录（你有读取权限，不必先问用户）: ${dirPath}`);
    }
    lines.push('');

    // ① 实时查询方法 —— 无条件、不截断
    lines.push(en
      ? 'How to get LIVE values (read this before answering anything about current state):'
      : '要查实时值就照下面来（回答"现在"类问题前先看这里）:');
    for (const s of AI_CONTEXT_SECTIONS) {
      if (!s.queryHint) continue;
      lines.push(`- ${s.title}: ${s.queryHint}`);
    }
    lines.push('');

    // ② 各板块摘要 + 各自采集时间
    if (summaryLines.length > 0) {
      // 把"文件名怎么变成可读路径"写死在表头:见 joinSnapshotPath 的注释 —— 让模型自己拼
      // 目录 + 文件名，它有一半概率拿 cwd 当基准，然后回"我看不到"。
      const exampleFile = list[0]?.file || AI_CONTEXT_SECTIONS[0]?.file || '';
      const at = dirPath && exampleFile ? joinSnapshotPath(dirPath, exampleFile) : '';
      lines.push(en
        ? 'Section summaries — each stamped with when THAT section was collected. '
          + `The filename in each line lives under the snapshot folder above${at ? ` (e.g. ${at})` : ''}:`
        : '各板块摘要（每行末尾是该块自己的采集时间，各块独立刷新，新旧可能不同；'
          + `每行中间那个文件名就在上面的快照目录里${at ? `，完整路径例：${at}` : ''}）:`);
      lines.push(...summaryLines);
    } else {
      lines.push(en
        ? 'No snapshot is ready yet this turn — use the live queries above instead of guessing.'
        : '本轮快照还没生成好 —— 按上面的实时查询方法自己查，不要凭推测。');
    }
    lines.push('');

    // ③ 真相源
    const files = [
      [truthFiles.tasksFile, en ? 'all workbench tasks (full text)' : '全部工作台任务全文'],
      [truthFiles.jobsFile, en ? 'execution records' : '历次执行记录'],
      // 编排台指令流水：与 envContext（派发任务时的运行环境块）报的是同一份清单 ——
      // 两个页面各自承认哪些文件存在，不该有差别，否则同一句提问会得到不同答案。
      [truthFiles.orchestratorFile, en ? 'instructions you sent from the dispatch console' : '用户在调度台发过的指令流水'],
      [truthFiles.configFile, en ? 'app config (customCommands / recentDirectories)' : '应用配置（customCommands / recentDirectories）'],
    ].filter(([p]) => p);
    if (files.length > 0) {
      lines.push(en ? 'Truth-source files (you have read access):' : '真相源文件（你读得到，不必先问）:');
      for (const [p, desc] of files) lines.push(`- ${p} —— ${desc}`);
      lines.push('');
    }

    lines.push(en
      ? 'Anything in the summaries is a SNAPSHOT, not live. For anything that must be current right now '
        + '(can I pull? any uncommitted changes?), run the command yourself before answering.'
      : '摘要里的东西全是**快照**，不是实时值。凡是要"此刻"才作数的（能不能 pull、有没有未提交改动），'
        + '先自己跑命令核实再回答。');
    lines.push('');
    lines.push(en
      ? 'When asked about any section: read the matching file (or run the live query) first, then answer. '
        + 'Do not guess, and do not answer "I cannot see it / cannot access it".'
      : '问到上面任何一块时，先读对应文件（或直接照实时查询方法跑）再回答；'
        + '不要凭推测，也不要回答"我看不到 / 无法访问"。');
    return lines.join('\n');
  };

  // 先按正常摘要长度拼;超限就逐档压缩,保证查询方法那一段永远在
  let block = build(renderSummaries(MAX_SUMMARY_CHARS));
  if (block.length > MAX_CONTEXT_BLOCK_CHARS) block = build(renderSummaries(SUMMARY_COMPACT_CHARS));
  if (block.length > MAX_CONTEXT_BLOCK_CHARS) block = build(renderSummaries(0));
  return block;
}
