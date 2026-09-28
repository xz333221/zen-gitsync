// aiContext/render.js 单元测试（纯函数）。
//
// 钉住两条核心契约：
//   1. 注入给模型的块里**只有摘要，板块正文一行都不能进** —— 破了不会报错，
//      只会静默烧 token 并把用户真正要办的那句话淹掉（envContext.js 头注释记的是同一个坑）。
//   2. **不论快照有没有生成，块里都必须有"七个板块各自怎么查实时值"** ——
//      快照天生会旧，"实时"这件事最终靠这句话兜底，所以它不许被截断、不许为空。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_CONTEXT_SECTIONS,
  MAX_CONTEXT_BLOCK_CHARS,
  MAX_SUMMARY_CHARS,
  buildContextBlock,
  formatStamp,
  joinSnapshotPath,
  oneLine,
  renderIndexFile,
  renderSectionFile,
  sectionForceTtl,
  sectionQueryHint,
  sectionTtl,
  truncate,
} from './render.js';

const okResult = (over = {}) => ({
  id: 'git',
  title: '当前项目 Git 状态',
  file: 'git-current.md',
  ok: true,
  summary: '分支 main，工作区干净',
  lines: ['- 分支: main'],
  error: '',
  collectedAt: '2026-09-28 10:15:32',
  ...over,
});

test('板块清单:文件带 .md 后缀且 id 唯一（文件名就是模型要读的路径）', () => {
  const ids = AI_CONTEXT_SECTIONS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const s of AI_CONTEXT_SECTIONS) {
    assert.match(s.file, /^[a-z0-9-]+\.md$/, `${s.id} 的文件名形状不对`);
    assert.ok(s.title, `${s.id} 缺标题`);
    assert.ok(s.queryHint && s.queryHint.length > 20, `${s.id} 缺"实时怎么查"的提示`);
    assert.ok(Number.isFinite(s.ttlMs) && s.ttlMs > 0, `${s.id} 缺 ttlMs`);
    assert.ok(Number.isFinite(s.forceTtlMs) && s.forceTtlMs >= 0, `${s.id} 缺 forceTtlMs`);
  }
});

test('板块时间参数:联网板块（github/gitee）必须留强制刷新地板，本地板块不必', () => {
  // 联网板块被前端"切面板就刷"打到会疯狂拉网络，必须有地板
  assert.ok(sectionForceTtl('github') >= 30_000, 'github 要有 force 地板');
  assert.ok(sectionForceTtl('gitee') >= 30_000, 'gitee 要有 force 地板');
  // 本地板块刷一次是毫秒级，不留地板
  for (const id of ['git', 'commands', 'tasks', 'system', 'mindmap']) {
    assert.equal(sectionForceTtl(id), 0, `${id} 不该有地板`);
  }
  // 软 TTL:git 必须比仓库列表短（本地状态变化快、取数便宜）
  assert.ok(sectionTtl('git') < sectionTtl('github'), 'git 的 TTL 该比仓库列表短');
  // 未知 id 的回落行为
  assert.equal(sectionForceTtl('nope'), 0);
  assert.ok(sectionTtl('nope') > 0);
  assert.equal(sectionQueryHint('nope'), '');
});

test('oneLine / truncate:压成单行并截断，摘要里绝不能出换行', () => {
  assert.equal(oneLine('  a\n\n b  '), 'a b');
  assert.equal(oneLine(null), '');
  const long = 'x'.repeat(MAX_SUMMARY_CHARS + 50);
  const cut = truncate(long);
  assert.equal(cut.length, MAX_SUMMARY_CHARS);
  assert.ok(cut.endsWith('…'));
  assert.equal(truncate('短'), '短');
});

test('renderSectionFile:文件头必须写采集时间、"这是快照"、以及该块怎么查实时值', () => {
  const text = renderSectionFile({
    id: 'git',
    title: '当前项目 Git 状态',
    generatedAt: '2026-09-28 10:15:32',
    scope: '当前项目 D:/ws/x',
    lines: ['- 分支: main'],
  });
  assert.match(text, /^# 当前项目 Git 状态/);
  assert.match(text, /采集时间: 2026-09-28 10:15:32/);
  assert.match(text, /快照/);
  assert.match(text, /要实时值: .*git status --porcelain/);
  assert.match(text, /- 分支: main/);
  assert.match(text, /覆盖范围: 当前项目 D:\/ws\/x/);
});

test('renderSectionFile:取数失败也要落盘并写明原因，不能只留一片空白', () => {
  const text = renderSectionFile({
    id: 'github',
    title: 'GitHub 仓库',
    generatedAt: '2026-09-28 10:15:32',
    error: 'gh CLI 未安装',
  });
  assert.match(text, /取数失败: gh CLI 未安装/);
  assert.match(text, /不要据此推断/);
});

test('buildContextBlock:摘要内联、正文不进 —— 这是整个设计最关键的一条', () => {
  const block = buildContextBlock({
    generatedAt: '2026-09-28 10:15:32',
    dirPath: 'C:/Users/x/.zen-gitsync/ai-context',
    results: [
      okResult({ lines: ['- BODY_MARKER_SHOULD_NOT_APPEAR'] }),
      okResult({ id: 'system', title: '系统状态', file: 'system.md', summary: 'CPU 7.7% · 内存 62.3%', lines: ['- BODY_MARKER_SHOULD_NOT_APPEAR'] }),
    ],
  });
  assert.ok(block.includes('分支 main，工作区干净'), '摘要必须在');
  assert.ok(block.includes('git-current.md'), '文件名必须在（模型据此去读）');
  assert.ok(block.includes('C:/Users/x/.zen-gitsync/ai-context'), '目录必须在');
  assert.ok(!block.includes('BODY_MARKER_SHOULD_NOT_APPEAR'), '正文一行都不许进来');
  assert.match(block, /不要回答"我看不到/);
});

test('buildContextBlock:每个板块带各自的采集时间（各块独立刷新，共用一个时间就是撒谎）', () => {
  const block = buildContextBlock({
    generatedAt: '2026-09-28 10:15:32',
    dirPath: '/tmp/x',
    results: [
      okResult({ collectedAt: '2026-09-28 10:15:30' }),
      okResult({ id: 'github', title: 'GitHub 仓库', file: 'remote-github.md', summary: '65 个仓库', collectedAt: '2026-09-28 10:05:00' }),
    ],
  });
  assert.match(block, /采集于 2026-09-28 10:15:30/);
  assert.match(block, /采集于 2026-09-28 10:05:00/);
});

test('joinSnapshotPath:按目录自身的分隔符风格拼接（单测跨平台稳定）', () => {
  assert.equal(joinSnapshotPath('C:\\Users\\x\\ai-context', 'git-current.md'), 'C:\\Users\\x\\ai-context\\git-current.md');
  assert.equal(joinSnapshotPath('/home/x/ai-context', 'git-current.md'), '/home/x/ai-context/git-current.md');
  assert.equal(joinSnapshotPath('/home/x/ai-context/', 'git-current.md'), '/home/x/ai-context/git-current.md', '尾部斜杠不许重复');
  assert.equal(joinSnapshotPath('', 'git-current.md'), 'git-current.md', '没目录时退化成裸文件名');
});

test('buildContextBlock:表头要给出"目录 + 文件名"的绝对路径示例', () => {
  // 为什么钉这条:摘要行里只有裸文件名,模型要自己拼目录。它有一半概率拿 cwd 当基准
  // 拼成 <项目目录>/git-current.md,读不到,然后回一句"我看不到" —— 而这正是整个块
  // 结尾反复叮嘱不要出现的结果。给全示例就没有这层推断。
  const block = buildContextBlock({
    generatedAt: 'x',
    dirPath: 'C:\\Users\\x\\.zen-gitsync\\ai-context',
    results: [okResult()],
  });
  assert.match(block, /完整路径例：C:\\Users\\x\\.zen-gitsync\\ai-context\\git-current\.md/);
});

test('buildContextBlock:冷启动没有摘要行时不该出现半截的表头', () => {
  const block = buildContextBlock({ dirPath: '/tmp/x', results: [] });
  assert.ok(!block.includes('完整路径例'), '没有摘要就不该留下孤零零的路径示例');
});

test('buildContextBlock:冷启动（一份快照都没有）时仍要给出实时查询方法', () => {
  const block = buildContextBlock({
    dirPath: 'C:/Users/x/.zen-gitsync/ai-context',
    results: [],
  });
  assert.ok(block.length > 0, '空快照不等于空块 —— 实时查询方法必须还在');
  assert.match(block, /要查实时值就照下面来/);
  assert.match(block, /gh repo list/);
  assert.match(block, /gitee auth status --json/);
  assert.match(block, /git status --porcelain/);
  assert.match(block, /本轮快照还没生成好/);
  assert.match(block, /C:\/Users\/x\/\.zen-gitsync\/ai-context/);
});

test('buildContextBlock:摘要再长也不许把实时查询方法挤掉', () => {
  const results = Array.from({ length: 40 }, (_, i) => okResult({
    id: `s${i}`, title: `板块${i}`, file: `s${i}.md`, summary: '很长的摘要'.repeat(80),
  }));
  const block = buildContextBlock({ generatedAt: 'x', dirPath: '/tmp', results });
  assert.ok(block.length <= MAX_CONTEXT_BLOCK_CHARS, `块长 ${block.length} 超过上限`);
  assert.match(block, /要查实时值就照下面来/, '查询方法那一段永远不能被切掉');
  assert.match(block, /gh repo list/);
  assert.match(block, /不要回答"我看不到/, '收尾的约束也不能被切掉');
});

test('buildContextBlock:真相源文件路径要报给模型', () => {
  const block = buildContextBlock({
    generatedAt: 'x',
    dirPath: '/tmp/x',
    results: [okResult()],
    truthFiles: {
      tasksFile: 'C:/u/.zen-gitsync/tasks.json',
      jobsFile: 'C:/u/.zen-gitsync/jobs.json',
      // 编排台指令流水：与 envContext（派发任务时的运行环境块）报同一份清单。
      // 两个页面各自承认哪些文件存在不该有差别，所以这里也钉一条。
      orchestratorFile: 'C:/u/.zen-gitsync/orchestrator.json',
      configFile: 'C:/u/.zen-gitsync/config.json',
    },
  });
  assert.match(block, /tasks\.json/);
  assert.match(block, /jobs\.json/);
  assert.match(block, /orchestrator\.json/);
  assert.match(block, /config\.json/);
  assert.match(block, /真相源文件/);
});

test('buildContextBlock:truthFiles 缺哪条就少哪行（不写空路径）', () => {
  const block = buildContextBlock({
    generatedAt: 'x',
    dirPath: '/tmp/x',
    results: [okResult()],
    truthFiles: { tasksFile: 'C:/u/.zen-gitsync/tasks.json', orchestratorFile: '', configFile: '' },
  });
  assert.match(block, /tasks\.json/);
  assert.doesNotMatch(block, /- C:\/u\/\.zen-gitsync\/ ——/);
  assert.doesNotMatch(block, /undefined/);
});

test('buildContextBlock:失败的板块要写成"暂时取不到"而不是留空', () => {
  const block = buildContextBlock({
    generatedAt: '2026-09-28 10:15:32',
    dirPath: '/tmp/x',
    results: [okResult({ id: 'gitee', title: 'Gitee 仓库', file: 'remote-gitee.md', ok: false, error: '未检测到 gitee CLI' })],
  });
  assert.match(block, /暂时取不到: 未检测到 gitee CLI/);
});

test('buildContextBlock:英文 locale 用英文说明（文件正文仍为中文）', () => {
  const block = buildContextBlock({
    generatedAt: '2026-09-28 10:15:32',
    dirPath: '/tmp/x',
    locale: 'en',
    results: [okResult()],
  });
  assert.match(block, /Workspace state/);
  assert.match(block, /How to get LIVE values/);
  assert.match(block, /SNAPSHOT, not live/);
  assert.match(block, /Section summaries/);
});

test('renderIndexFile:列出每个板块并标明采集时间与失败项', () => {
  const text = renderIndexFile({
    generatedAt: '2026-09-28 10:20:00',
    results: [
      okResult(),
      okResult({ id: 'gitee', title: 'Gitee 仓库', file: 'remote-gitee.md', ok: false, error: '未登录', collectedAt: '2026-09-28 10:05:00' }),
    ],
  });
  assert.match(text, /- \[2026-09-28 10:15:32\] 当前项目 Git 状态（git-current.md）: 分支 main/);
  assert.match(text, /- \[2026-09-28 10:05:00\] Gitee 仓库（remote-gitee.md）: 取数失败: 未登录/);
  // 实时查询方法一节只列**这份 INDEX 里实际有的**板块（这里只有 git / gitee）
  assert.match(text, /## 实时查询方法/);
  assert.match(text, /git status --porcelain/);
  assert.match(text, /gitee auth status --json/);
  assert.ok(!text.includes('gh repo list'), '没采集到的板块不该出现在 INDEX 里');
});

test('formatStamp:补零到秒，模型靠它判断新旧', () => {
  assert.equal(formatStamp(new Date(2026, 8, 28, 9, 5, 3)), '2026-09-28 09:05:03');
});
