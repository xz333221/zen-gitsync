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
// 「图片 → 文字」预处理单测（imageDescribe.js + pdfText 的 describeImage 分支）。
//
// 这里刻意**不联网**：描述本身是 `callLlmStream` 的事，测它等于测网关。
// 钉的是这一层的契约 ——
//   · 只挑图片附件（别把 PDF / 日志也送去"看图"）；
//   · 描述失败 / 文件不存在 / 超大 → 返回 null 且不抛（预处理不许掐断派发）；
//   · 一张图失败后不再继续烧额度；
//   · buildAttachmentBlock 把描述**紧跟在该图路径之下**，多图时不串位。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  pickImageAttachments,
  createImageDescriber,
} from './imageDescribe.js';
import { buildAttachmentBlock } from './pdfText.js';
import { shouldDescribeImages } from './taskRunner.js';

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-imgdesc-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('pickImageAttachments: 只挑图片，且要求有绝对路径', () => {
  const list = [
    { ext: 'png', absolutePath: '/a/x.png' },
    { ext: 'JPG', absolutePath: '/a/y.JPG' },
    { ext: 'pdf', absolutePath: '/a/doc.pdf' },
    { ext: 'png' }, // 没有路径：跳过
    null,
  ];
  const picked = pickImageAttachments(list);
  assert.deepEqual(picked.map(a => a.ext), ['png', 'JPG']);
  assert.deepEqual(pickImageAttachments(undefined), []);
  assert.deepEqual(pickImageAttachments([]), []);
});

test('createImageDescriber: 没有模型 / 文件不存在时返回 null，不抛', async () => {
  const noModel = await createImageDescriber({ model: null });
  assert.equal(await noModel({ absolutePath: '/a/x.png' }), null);

  const withModel = await createImageDescriber({ model: { model: 'stub' } });
  // 文件不存在 → 读盘失败被吞掉，返回 null（退化成"只给路径"）
  assert.equal(await withModel({ absolutePath: '/definitely/not/here.png' }), null);
});

test('createImageDescriber: 同一张图只问一次，一张失败后熔断不再继续', async () => {
  const calls = [];
  const describe = await createImageDescriber({
    model: { model: 'stub' },
    // 第一张成功、第二张失败、第三张本应被跳过（熔断）
    describe: async (filePath) => {
      calls.push(filePath);
      if (filePath.endsWith('bad.png')) return null;
      return `描述 ${path.basename(filePath)}`;
    },
  });

  assert.equal(await describe({ absolutePath: '/x/one.png' }), '描述 one.png');
  assert.equal(await describe({ absolutePath: '/x/one.png' }), '描述 one.png'); // 命中缓存
  assert.deepEqual(calls, ['/x/one.png'], '同一张图不该问第二遍');

  assert.equal(await describe({ absolutePath: '/x/bad.png' }), null);
  assert.deepEqual(calls, ['/x/one.png', '/x/bad.png']);

  // 已经失败过 → 后面的图直接跳过，连"问一次"都不做（一次派发挂十张截图时
  // 不该为了十张全失败各烧一次额度）
  assert.equal(await describe({ absolutePath: '/x/later.png' }), null);
  assert.deepEqual(calls, ['/x/one.png', '/x/bad.png']);
});

test('createImageDescriber: 超过 maxImages 的部分不描述', async () => {
  const calls = [];
  const describe = await createImageDescriber({
    model: { model: 'stub' },
    maxImages: 2,
    describe: async (filePath) => { calls.push(filePath); return 'ok'; },
  });
  for (const n of ['a', 'b', 'c']) {
    await describe({ absolutePath: `/x/${n}.png` });
  }
  assert.deepEqual(calls, ['/x/a.png', '/x/b.png']);
});

test('buildAttachmentBlock: 描述紧跟在该图路径之后，多图不串位', async () => {
  const a = tmpFile('one.png', 'x');
  const b = tmpFile('two.png', 'y');
  const desc = { [a]: '第一张：红色方块', [b]: '第二张：蓝色方块' };
  const { block, describedCount } = await buildAttachmentBlock(
    [{ absolutePath: a, ext: 'png', mimeType: 'image/png' },
      { absolutePath: b, ext: 'png', mimeType: 'image/png' }],
    { describeImage: async (att) => desc[att.absolutePath] || null },
  );

  assert.equal(describedCount, 2);
  const lines = block.split('\n');
  const ai = lines.findIndex(l => l.includes(a));
  const bi = lines.findIndex(l => l.includes(b));
  // 描述块夹在"图 A 路径"与"图 B 路径"之间 → A 的描述紧跟 A
  assert.ok(ai >= 0 && bi > ai);
  const between = lines.slice(ai, bi).join('\n');
  assert.ok(between.includes('第一张：红色方块'), 'A 的描述应紧跟在 A 之后');
  assert.ok(!between.includes('第二张'), 'B 的描述不能跑到 A 后面');
  assert.ok(block.includes('2 张图片已转成文字描述'), '汇总行要说明转了几张');
});

test('buildAttachmentBlock: 没给 describeImage 时行为不变（老形态）', async () => {
  const a = tmpFile('one.png', 'x');
  const { block, describedCount } = await buildAttachmentBlock([
    { absolutePath: a, ext: 'png', mimeType: 'image/png' },
  ]);
  assert.equal(describedCount, 0);
  assert.ok(!block.includes('<image_description>'));
  assert.ok(block.includes(a));
});

test('shouldDescribeImages: 载体 > 任务 > 执行器兜底（codearts 默认开）', () => {
  // 执行器兜底：只有 codearts 读不了图，别家能直接看
  assert.equal(shouldDescribeImages({}, {}, 'codearts'), true);
  assert.equal(shouldDescribeImages({}, {}, 'claude'), false);
  assert.equal(shouldDescribeImages({}, {}, 'opencode'), false);

  // 任务上记过的选择优先于执行器兜底（重跑沿用派发那一刻的勾选）
  assert.equal(shouldDescribeImages({ imageText: false }, {}, 'codearts'), false);
  assert.equal(shouldDescribeImages({ imageText: true }, {}, 'claude'), true);

  // 载体上的值优先于任务（同一条任务重跑时换了选择）
  assert.equal(shouldDescribeImages({ imageText: true }, { imageText: false }, 'codearts'), false);
});
