// library.js 的单测。
//
// ⚠️ paths.js 在**模块加载时**由 os.homedir() 求值，USERPROFILE/HOME 必须
// 在 import 之前改（Windows 上还要删 HOMEDRIVE/HOMEPATH），否则会写进用户真实的
// ~/.zen-gitsync/memory。
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const SANDBOX = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-memory-lib-'));
for (const k of ['HOMEDRIVE', 'HOMEPATH']) delete process.env[k];
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const { MEMORY_DIR } = await import('../paths.js');
const lib = await import('./library.js');
const { projectSlug } = await import('./store.js');

after(() => fsp.rm(SANDBOX, { recursive: true, force: true }));

const SLUG = projectSlug('C:\\ws\\zen-gitsync');
const PROJ_DIR = path.join(MEMORY_DIR, 'projects', SLUG);

/** 铺一个最小可用的库：全局两篇 + 一个项目里两条有索引 + 一条孤儿经验 */
async function seed() {
  await fsp.mkdir(path.join(PROJ_DIR, 'lessons'), { recursive: true });
  await fsp.writeFile(path.join(MEMORY_DIR, 'INDEX.md'), '# 记忆索引 · 全局\n', 'utf8');
  await fsp.writeFile(path.join(MEMORY_DIR, 'GLOBAL.md'), '# 跨项目经验\n', 'utf8');
  await fsp.writeFile(
    path.join(PROJ_DIR, 'INDEX.md'),
    '# 记忆索引 · 本项目\n\n## 主题\n- [双落盘路径](lessons/jobs-persistence.md) — jobs.json 只在终态 flush\n- [探针假绿](lessons/probe.md) — 别信恒真断言\n',
    'utf8'
  );
  await fsp.writeFile(path.join(PROJ_DIR, 'lessons', 'jobs-persistence.md'), '# 双落盘路径\n\n内容\n', 'utf8');
  await fsp.writeFile(path.join(PROJ_DIR, 'lessons', 'probe.md'), '# 探针假绿\n\n内容\n', 'utf8');
  // 一条**没有索引行**的孤儿经验：界面上要能标出来
  await fsp.writeFile(path.join(PROJ_DIR, 'lessons', 'orphan.md'), '# 孤儿\n', 'utf8');
}

beforeEach(seed);

// ── 形状校验：这是本文件的安全边界，不是可选加固 ─────────────────────
test('isValidScope：只认两种特殊值与「可读部分+6位哈希」', () => {
  assert.equal(lib.isValidScope('global'), true);
  assert.equal(lib.isValidScope('global-index'), true);
  assert.equal(lib.isValidScope(SLUG), true);
  assert.equal(lib.isValidScope(SLUG.replace(/-[0-9a-f]{6}$/, '')), false, '缺哈希后缀');
  assert.equal(lib.isValidScope(SLUG.replace(/-[0-9a-f]{6}$/, '-ZZZZZZ')), false, '哈希必须十六进制');
  assert.equal(lib.isValidScope(''), false);
  assert.equal(lib.isValidScope(null), false);
  assert.equal(lib.isValidScope('../..'), false);
  assert.equal(lib.isValidScope('a/../b-abcdef'), false);
});

test('isValidFile：kebab 文件名 + .md，挡掉 . 与 ..', () => {
  assert.equal(lib.isValidFile('jobs-persistence.md'), true);
  assert.equal(lib.isValidFile('a_b-c.1.md'), true);
  assert.equal(lib.isValidFile('..'), false);
  assert.equal(lib.isValidFile('../evil.md'), false);
  assert.equal(lib.isValidFile('a/b.md'), false);
  assert.equal(lib.isValidFile('a\\b.md'), false);
  assert.equal(lib.isValidFile('evil.txt'), false);
  assert.equal(lib.isValidFile('.hidden.md'), false);
  assert.equal(lib.isValidFile(''), false);
  assert.equal(lib.isValidFile('x'.repeat(200) + '.md'), false);
});

// ── ⚠️ 越界：拼不出 MEMORY_DIR 之外的任何路径 ────────────────────────
test('⚠️ resolveEntryPath：非法入参一律返回空串（结构性防越界）', () => {
  const evil = [
    ['../../.claude/settings.json', 'settings.json'],
    ['global', '../config.json'],
    [SLUG, '../../../config.json'],
    [SLUG, '../../../../.ssh/id_rsa'],
  ];
  for (const [scope, file] of evil) {
    assert.equal(lib.resolveEntryPath(scope, file), '', `${scope}/${file} 不该解析出路径`);
  }
});

test('resolveEntryPath：合法入参只落在三处', () => {
  assert.equal(lib.resolveEntryPath('global', 'GLOBAL.md'), path.join(MEMORY_DIR, 'GLOBAL.md'));
  assert.equal(lib.resolveEntryPath('global-index', 'INDEX.md'), path.join(MEMORY_DIR, 'INDEX.md'));
  assert.equal(
    lib.resolveEntryPath(SLUG, 'probe.md'),
    path.join(MEMORY_DIR, 'projects', SLUG, 'lessons', 'probe.md')
  );
  // global 只认 GLOBAL.md 本体，别的文件名不给
  assert.equal(lib.resolveEntryPath('global', 'INDEX.md'), '');
});

test('⚠️ resolveEntryPath 的产物必须在 MEMORY_DIR 之内（回归守卫）', () => {
  for (const scope of ['global', 'global-index', SLUG]) {
    for (const file of ['a.md', 'probe.md', 'UPPER.MD']) {
      const abs = lib.resolveEntryPath(scope, file);
      if (!abs) continue;
      const rel = path.relative(MEMORY_DIR, abs);
      assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel),
        `${abs} 逃出了 MEMORY_DIR`);
    }
  }
});

// ── 列表 ────────────────────────────────────────────────────────────
test('listEntries：列出 lessons 并标出哪些有索引', async () => {
  const list = await lib.listEntries(SLUG);
  const byName = Object.fromEntries(list.map(e => [e.file, e]));
  assert.equal(list.length, 3);
  assert.equal(byName['jobs-persistence.md'].indexed, true);
  assert.equal(byName['probe.md'].indexed, true);
  assert.equal(byName['orphan.md'].indexed, false, '没有索引行的要标出来');
  assert.equal(byName['jobs-persistence.md'].title, 'jobs-persistence');
});

test('listEntries：slug 不存在 / 非法时返回空数组而不是抛错', async () => {
  assert.deepEqual(await lib.listEntries('no-such-slug-abcdef'), []);
  assert.deepEqual(await lib.listEntries('../evil'), []);
});

test('listScopes：全局两篇 + 项目，且项目带仓库路径', async () => {
  const scopes = await lib.listScopes();
  const s = scopes.find(x => x.scope === SLUG);
  assert.ok(s, '项目 scope 应在列表里');
  assert.equal(s.count, 3);
  const labels = scopes.map(x => x.scope);
  assert.ok(labels.includes('global'));
  assert.ok(labels.includes('global-index'));
  assert.ok(['global', 'global-index'].includes(scopes[0].scope), '全局两篇永远排最上');
});

test('parseIndexLine：从索引行里取出标题与摘要', () => {
  assert.deepEqual(lib.parseIndexLine('- [双落盘路径](lessons/x.md) — 只在终态 flush'),
    { title: '双落盘路径', summary: '只在终态 flush' });
  assert.deepEqual(lib.parseIndexLine('- [探针](lessons/y.md)'), { title: '探针', summary: '' });
  assert.equal(lib.parseIndexLine('## 主题'), null);
  assert.equal(lib.parseIndexLine('随便一行'), null);
});

// ── 读 ──────────────────────────────────────────────────────────────
test('readEntry：正常读 / 不存在 / 超大 / 非法', async () => {
  const ok = await lib.readEntry(SLUG, 'probe.md');
  assert.match(ok.content, /探针假绿/);
  assert.equal((await lib.readEntry(SLUG, 'nope.md')).missing, true);
  assert.equal((await lib.readEntry('../evil', 'x.md')).error, 'invalid');
});

// ── 删：连带清索引行（不留死链）──────────────────────────────────
test('deleteEntry：删文件并连带删掉 INDEX.md 里那一行', async () => {
  const r = await lib.deleteEntry(SLUG, 'probe.md');
  assert.equal(r.removed, true);
  assert.equal(r.indexLineRemoved, true);
  await assert.rejects(fsp.access(path.join(PROJ_DIR, 'lessons', 'probe.md')));
  const idx = await fsp.readFile(path.join(PROJ_DIR, 'INDEX.md'), 'utf8');
  assert.ok(!idx.includes('probe.md'), '索引行必须一起删 —— 留着就是死链');
  assert.ok(idx.includes('jobs-persistence.md'), '别的行不能被误伤');
});

test('deleteEntry：重复删是幂等的（alreadyGone）', async () => {
  await lib.deleteEntry(SLUG, 'probe.md');
  const again = await lib.deleteEntry(SLUG, 'probe.md');
  assert.equal(again.alreadyGone, true);
  assert.equal(again.removed, false);
});

test('deleteEntry：非法入参不删任何东西', async () => {
  for (const [scope, file] of [['../evil', 'x.md'], [SLUG, '../../../config.json'], [SLUG, '..']]) {
    const r = await lib.deleteEntry(scope, file);
    assert.equal(r.error, 'invalid', `${scope}/${file} 应被拒`);
  }
  assert.ok((await lib.listEntries(SLUG)).length >= 3, '种子文件不该被动过');
});

test('deleteEntry：删孤儿（无索引行）不算失败，indexLineRemoved=false', async () => {
  const r = await lib.deleteEntry(SLUG, 'orphan.md');
  assert.equal(r.removed, true);
  assert.equal(r.indexLineRemoved, false, '本来就没索引行可删');
});

test('deleteEntry 不碰 archive/ 里的同名文件', async () => {
  await fsp.mkdir(path.join(PROJ_DIR, 'archive'), { recursive: true });
  const archived = path.join(PROJ_DIR, 'archive', 'probe.md');
  await fsp.writeFile(archived, '历史', 'utf8');
  await lib.deleteEntry(SLUG, 'probe.md');
  assert.equal(await fsp.readFile(archived, 'utf8'), '历史', 'archive 是冻结历史，不该被动');
});
