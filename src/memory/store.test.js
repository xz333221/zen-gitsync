// store.js 的单测。
//
// ⚠️ paths.js 在**模块加载时**由 os.homedir() 求值，所以 USERPROFILE/HOME 必须
// 在 import 之前改掉（与 agentRoutes.test.js / agentMarketplace.test.js 同一套），
// 否则这个文件会往用户真实的 ~/.zen-gitsync/memory 里写。
// Windows 上 os.homedir() 还走 HOMEDRIVE/HOMEPATH 另一条路径，**必须一起删**。
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-memory-store-'));
for (const k of ['HOMEDRIVE', 'HOMEPATH']) delete process.env[k];
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const { MEMORY_DIR, MEMORY_INDEX_FILE } = await import('../paths.js');
const {
  projectSlug,
  projectMemoryDir,
  projectIndexFile,
  ensureMemoryStore,
  ensureProjectMemory,
  renderProjectIndexHeader,
  readGlobalIndex,
  readProjectIndex,
  memoryAvailable,
} = await import('./store.js');
const { MEMORY_SEED_FILES } = await import('./templates.js');

after(() => fsp.rm(SANDBOX, { recursive: true, force: true }));

test('projectSlug：Windows 与 POSIX 盘符都落进同一套形状', () => {
  const a = projectSlug('C:\\workspace\\github_workspace\\xz333221\\zen-gitsync');
  assert.match(a, /^c-workspace-github_workspace-xz333221-zen-gitsync-[0-9a-f]{6}$/, a);
  assert.match(projectSlug('/home/u/proj'), /^home-u-proj-[0-9a-f]{6}$/);
});

test('projectSlug：同一仓库的两种写法（\\ 与 /）必须同一个 slug，否则同仓库裂成两份记忆', () => {
  assert.equal(projectSlug('C:\\ws\\zen'), projectSlug('C:/ws/zen'));
  assert.equal(projectSlug('C:\\WS\\Zen'), projectSlug('c:\\ws\\zen'));
});

test('⚠️ projectSlug：全中文路径不能互相碰撞（否则记忆跨项目串味，且不报错）', () => {
  const a = projectSlug('C:\\中文\\项目');
  const b = projectSlug('C:\\中文\\别的');
  const c = projectSlug('D:\\中文\\项目');
  assert.notEqual(a, b, '不同目录不能撞');
  assert.notEqual(a, c, '不同盘符不能撞');
  // 退化也不能含路径分隔符 —— 那会顺着 join 逃出 projects/ 目录
  for (const s of [a, b, c]) {
    assert.ok(s.length > 0);
    assert.ok(!s.includes('/') && !s.includes('\\'));
    assert.ok(!s.includes('..'));
  }
});

test('projectSlug：非法入参返回空串而不是抛错（派发时不该因路径怪就炸）', () => {
  assert.equal(projectSlug(''), '');
  assert.equal(projectSlug('   '), '');
  assert.equal(projectSlug(null), '');
  assert.equal(projectSlug(undefined), '');
  assert.equal(projectSlug(123), '');
});

test('projectMemoryDir / projectIndexFile 必须落在 projects/ 之内', () => {
  const dir = projectMemoryDir('C:\\a\\b');
  assert.ok(dir.startsWith(path.join(MEMORY_DIR, 'projects')));
  assert.ok(projectIndexFile('C:\\a\\b').startsWith(dir));
});

test('ensureMemoryStore 铺出全部种子，且 created 报得出建了什么', async () => {
  assert.equal(memoryAvailable(), false, '初始应不存在');
  const { created } = await ensureMemoryStore();
  assert.equal(memoryAvailable(), true);
  for (const rel of Object.keys(MEMORY_SEED_FILES)) {
    assert.ok(created.includes(rel), `${rel} 应报为新建`);
    await fsp.access(path.join(MEMORY_DIR, ...rel.split('/')));
  }
  await fsp.access(path.join(MEMORY_DIR, 'archive'));
});

test('⚠️ 二次调用不覆盖已存在的种子（否则每次启动都把用户写的记忆洗回出厂）', async () => {
  const before = await fsp.readFile(MEMORY_INDEX_FILE, 'utf8');
  await fsp.appendFile(MEMORY_INDEX_FILE, '\n- 用户自己写的一行\n', 'utf8');
  const { created, existed } = await ensureMemoryStore();
  assert.equal(created.length, 0, '不该有任何新建');
  assert.equal(existed, Object.keys(MEMORY_SEED_FILES).length);
  const after = await fsp.readFile(MEMORY_INDEX_FILE, 'utf8');
  assert.ok(after.startsWith(before));
  assert.ok(after.includes('用户自己写的一行'), '用户内容必须活下来');
});

test('ensureProjectMemory 建目录 + 建带仓库路径头的索引', async () => {
  const idx = await ensureProjectMemory('C:\\ws\\zen-gitsync');
  assert.ok(idx);
  await fsp.access(path.join(MEMORY_DIR, 'projects', projectSlug('C:\\ws\\zen-gitsync'), 'lessons'));
  await fsp.access(path.join(MEMORY_DIR, 'projects', projectSlug('C:\\ws\\zen-gitsync'), 'archive'));
  const text = await fsp.readFile(idx, 'utf8');
  assert.ok(text.includes('C:\\ws\\zen-gitsync'), '头里必须记着仓库绝对路径（slug 规则变了还能认回来）');
});

test('ensureProjectMemory 幂等：已存在的索引不被重写', async () => {
  const idx = projectIndexFile('C:\\ws\\zen-gitsync');
  await fsp.appendFile(idx, '\n- [手写条目](lessons/x.md) — 摘要\n', 'utf8');
  await ensureProjectMemory('C:\\ws\\zen-gitsync');
  const text = await fsp.readFile(idx, 'utf8');
  assert.ok(text.includes('手写条目'), '重复调用不能吃掉已有条目');
});

test('ensureProjectMemory 对非法路径返回空串而不是建出垃圾目录', async () => {
  assert.equal(await ensureProjectMemory(''), '');
  assert.equal(await ensureProjectMemory(null), '');
});

test('renderProjectIndexHeader 把三条硬约束写进头里', () => {
  const h = renderProjectIndexHeader('C:\\x');
  assert.match(h, /≤40 条/);
  assert.match(h, /只有命中本行才去 Read/);
  assert.match(h, /不写"我做了什么"/);
});

test('读取函数对不存在的文件返回空串，不抛错', async () => {
  assert.equal(await readProjectIndex('C:\\never-existed-repo'), '');
  assert.equal(typeof await readGlobalIndex(), 'string');
});

test('种子文件本身要满足预算（它就是每台机器的初始索引）', () => {
  for (const [rel, content] of Object.entries(MEMORY_SEED_FILES)) {
    assert.ok(Buffer.byteLength(content, 'utf8') <= 6000, `${rel} 种子 ${Buffer.byteLength(content, 'utf8')}B 过大`);
  }
  // 规范里写死的三条预算，种子必须自洽
  assert.match(MEMORY_SEED_FILES['INDEX.md'], /≤30 行/);
  assert.match(MEMORY_SEED_FILES['GLOBAL.md'], /≤40 行/);
  assert.match(MEMORY_SEED_FILES['RULES.md'], /≤25 行/);
});
