// memoryContext.js 的单测。
//
// 纯函数、不碰文件系统（见该文件头注释），所以直接喂入参断输出即可 ——
// 与 envContext.test.js 同一个理由，也正是它要保持纯的原因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryPointerBlock,
  MEMORY_BLOCK_MAX_BYTES,
  MEMORY_BLOCK_LEVEL,
} from './memoryContext.js';

const DIR = '/home/u/.zen-gitsync/memory';
const PIDX = `${DIR}/projects/my-repo/INDEX.md`;

test('没有 memoryDir → 完全不注入', () => {
  const { block, level } = buildMemoryPointerBlock({});
  assert.equal(block, '');
  assert.equal(level, MEMORY_BLOCK_LEVEL.NONE);
});

test('只有全局层：给全局索引路径，明说本项目还没有条目', () => {
  const { block, level } = buildMemoryPointerBlock({ memoryDir: DIR });
  assert.equal(level, MEMORY_BLOCK_LEVEL.GLOBAL_ONLY);
  assert.ok(block.includes(`${DIR}/INDEX.md`));
  assert.ok(block.includes('本项目还没有记忆库条目'));
  // 捕获段里仍会出现 lessons/ —— Agent 收尾时要知道往哪儿写；
  // 这里断言的是**不出现项目索引路径**（没有的路径给了就是骗 Agent）。
  assert.ok(!block.includes(`${DIR}/projects/`));
  assert.ok(!block.includes('本项目索引'));
});

test('有项目层：标为 PROJECT 并点名本项目索引', () => {
  const { block, level } = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX });
  assert.equal(level, MEMORY_BLOCK_LEVEL.PROJECT);
  assert.ok(block.includes(PIDX));
  assert.ok(!block.includes('本项目还没有记忆库条目'));
});

test('capture=false → 保留召回纪律、砍掉捕获纪律', () => {
  const withCap = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX, capture: true });
  const noCap = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX, capture: false });
  assert.ok(withCap.block.includes('收尾时'));
  assert.ok(!noCap.block.includes('收尾时'));
  // 砍的只是长的那段，召回指针必须还在 —— 那才是这个块存在的理由
  assert.ok(noCap.block.includes(PIDX));
  assert.ok(noCap.block.length > 0);
  assert.ok(Buffer.byteLength(noCap.block, 'utf8') < Buffer.byteLength(withCap.block, 'utf8'));
});

test('块本身不能超预算（这是它替代"索引全文进 prompt"的前提）', () => {
  const { block } = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX });
  assert.ok(
    Buffer.byteLength(block, 'utf8') <= MEMORY_BLOCK_MAX_BYTES,
    `块 ${Buffer.byteLength(block, 'utf8')}B 超过 ${MEMORY_BLOCK_MAX_BYTES}B 预算`
  );
});

test('超预算时降级：砍捕获段、保住召回指针（不静默产出超大 prompt）', () => {
  const { block } = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX, capture: true });
  const recallAt = block.indexOf('不要预加载全部 lessons');
  const captureAt = block.indexOf('收尾时');
  assert.ok(recallAt > 0, '召回纪律必须在');
  assert.ok(captureAt > recallAt, '捕获纪律必须排在召回纪律之后');
});

test('纪律里必须写死两条硬约束：懒加载 + 索引缺一不可', () => {
  const { block } = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX });
  assert.match(block, /不要预加载全部 lessons/);
  assert.match(block, /archive/);
  assert.match(block, /没索引的记忆等于不存在/);
  assert.match(block, /以后怎么做/);
});

test('续接场景（capture 由调用方关掉）不产生空块', () => {
  const { block } = buildMemoryPointerBlock({ memoryDir: DIR, projectIndexFile: PIDX, capture: false });
  assert.ok(block.trim().length > 0);
  assert.ok(block.includes(PIDX), '关掉捕获纪律不能把召回指针一起关掉');
});
