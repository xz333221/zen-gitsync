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
// 项目图标（favicon）探测的单测。
//
// 这里钉的是几条**容易悄悄错**的判据 —— 错了不会报错，只会在界面上显示一枚错的图：
//   · index.html 里声明的图标优先于扫盘结果（那才是标签页上真正显示的那枚）
//   · `favicon-preview.png` / `favicon-dark.svg` 这类**同名不同用途**的文件不能当图标
//   · 嵌套仓库（自带 `.git` 的子目录）整支跳过：它是另一个项目，不能借它的图标
//   · 产物目录里的副本（`dist/favicon.svg`）输给源头的 `public/favicon.svg`
//   · 声明里写 `../../` 的越界路径不认

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseIconHrefs,
  findProjectIcon,
  getProjectIcon,
  projectIconUrl,
  clearProjectIconCache,
} from './projectIcon.js';

let tmpRoot = '';

beforeEach(async () => {
  clearProjectIconCache();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-icon-'));
});

afterEach(async () => {
  clearProjectIconCache();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  tmpRoot = '';
});

/** 在临时目录里造一棵树；入参是相对路径 → 内容（null 表示建目录） */
async function plant(tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(tmpRoot, rel);
    if (content === null) {
      await fs.mkdir(abs, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return tmpRoot;
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

// ── parseIconHrefs（纯函数） ────────────────────────────────────────────

test('parseIconHrefs 认 icon / shortcut icon / apple-touch-icon / mask-icon 四种写法', () => {
  const html = `
    <link rel="stylesheet" href="/style.css">
    <link rel="icon" href="/a.svg">
    <link rel="shortcut icon" href="/b.ico">
    <link rel="apple-touch-icon" href="/c.png">
    <link rel="mask-icon" href="/d.svg" color="#000">
    <link rel="preload" as="image" href="/e.png">
  `;
  assert.deepEqual(parseIconHrefs(html), ['/a.svg', '/d.svg', '/c.png', '/b.ico']);
});

test('parseIconHrefs 剥掉 %BASE_URL% 占位符与 HTML 实体，丢掉 data: 内联图标', () => {
  const html = `
    <link rel="icon" href="%BASE_URL%favicon.ico">
    <link rel="icon" href="/logo.svg?a=1&amp;b=2">
    <link rel="icon" href="data:image/svg+xml;base64,AAAA">
  `;
  // 排序按后缀：svg 在前（带查询串也算 svg —— 判后缀前会先切掉 ? / #）
  assert.deepEqual(parseIconHrefs(html), ['/logo.svg?a=1&b=2', 'favicon.ico']);
});

test('parseIconHrefs 同名不同后缀时 svg 排前面，同后缀保持文档顺序', () => {
  const html = `
    <link rel="icon" href="/favicon.ico">
    <link rel="icon" href="/favicon.png">
    <link rel="icon" href="/favicon.svg">
    <link rel="icon" href="/second.svg">
  `;
  assert.deepEqual(parseIconHrefs(html), ['/favicon.svg', '/second.svg', '/favicon.png', '/favicon.ico']);
});

test('parseIconHrefs 认无引号 / 单引号写法，rel 大小写不敏感', () => {
  const html = `<link REL=ICON href=/a.svg><link rel='icon' href='/b.svg'>`;
  assert.deepEqual(parseIconHrefs(html), ['/a.svg', '/b.svg']);
});

// ── findProjectIcon（真建目录树） ──────────────────────────────────────

test('index.html 里声明的图标优先于同目录扫到的 favicon', async () => {
  await plant({
    'index.html': '<link rel="icon" href="/brand.svg">',
    'brand.svg': SVG,
    'favicon.ico': SVG,
  });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'brand.svg');
  assert.equal(icon.mime, 'image/svg+xml');
});

test('vite / CRA 那种 public/ 布局：/favicon.svg 解到 public/favicon.svg', async () => {
  await plant({
    'index.html': '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
    'public/favicon.svg': SVG,
  });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'public/favicon.svg');
});

test('没有 index.html 时扫盘：往下两层能找到 frontend/public/favicon.svg', async () => {
  await plant({ 'frontend/public/favicon.svg': SVG });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'frontend/public/favicon.svg');
});

test('favicon 的同名变体不当图标（favicon-dark.svg / favicon-preview.png）', async () => {
  await plant({
    'favicon-dark.svg': SVG,
    'docs/branding/favicon-preview.png': SVG,
    'docs/branding/favicon-sizes.png': SVG,
  });
  assert.equal(await findProjectIcon(tmpRoot), null);
});

test('源头 public/favicon.svg 赢过构建产物 dist/favicon.svg', async () => {
  await plant({
    'public/favicon.svg': SVG,
    'dist/favicon.svg': SVG,
    'dist/index.html': '<link rel="icon" href="/favicon.svg">',
  });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'public/favicon.svg');
});

test('只有构建产物带图标时，仍然认 dist 里那份（late 目录是兜底不是跳过）', async () => {
  await plant({
    'frontend/dist/favicon.svg': SVG,
    'frontend/dist/index.html': '<link rel="icon" href="/favicon.svg">',
  });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'frontend/dist/favicon.svg');
});

test('嵌套仓库（子目录自带 .git）整支跳过 —— 不能借别的项目的图标', async () => {
  await plant({
    'nested-repo/.git/HEAD': 'ref: refs/heads/main\n',
    'nested-repo/public/favicon.svg': SVG,
    'nested-repo/index.html': '<link rel="icon" href="/favicon.svg">',
    'own/public/favicon.svg': SVG,
  });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.rel, 'own/public/favicon.svg');
});

test('index.html 声明里写 ../../ 的越界路径不认，退到项目内的图标', async () => {
  const outside = path.join(os.tmpdir(), `zen-icon-outside-${Date.now()}.svg`);
  await fs.writeFile(outside, SVG);
  try {
    await plant({
      'index.html': `<link rel="icon" href="../../${path.basename(outside)}">`,
      'favicon.ico': SVG,
    });
    const icon = await findProjectIcon(tmpRoot);
    assert.equal(icon.rel, 'favicon.ico');
  } finally {
    await fs.rm(outside, { force: true });
  }
});

test('声明成 .js / .json 的一律不认（只认图标后缀）', async () => {
  await plant({
    'index.html': '<link rel="icon" href="/app.js">',
    'app.js': 'console.log(1)',
  });
  assert.equal(await findProjectIcon(tmpRoot), null);
});

test('目录不存在 / 空目录：返回 null 而不是抛', async () => {
  assert.equal(await findProjectIcon(path.join(tmpRoot, 'nope')), null);
  await plant({ 'empty': null });
  assert.equal(await findProjectIcon(path.join(tmpRoot, 'empty')), null);
});

test('远程图标地址原样返回（项目把图标放在 CDN 上）', async () => {
  await plant({ 'index.html': '<link rel="icon" href="https://cdn.example.com/logo.png">' });
  const icon = await findProjectIcon(tmpRoot);
  assert.equal(icon.remote, 'https://cdn.example.com/logo.png');
  assert.equal(icon.abs, '');
});

// ── 缓存与地址 ────────────────────────────────────────────────────────

test('getProjectIcon 命中 TTL 缓存；ttlMs: 0 时重新走盘', async () => {
  await plant({ 'favicon.svg': SVG });
  assert.equal((await getProjectIcon(tmpRoot)).rel, 'favicon.svg');

  await fs.rm(path.join(tmpRoot, 'favicon.svg'));
  // 默认 TTL 内：仍是缓存里那份（看板 5s 轮询不该反复走盘）
  assert.equal((await getProjectIcon(tmpRoot)).rel, 'favicon.svg');
  // 显式绕过缓存：图标真没了
  assert.equal(await getProjectIcon(tmpRoot, { ttlMs: 0 }), null);
});

test('projectIconUrl：本地图标带 mtime 版本号，远程图标原样，没图标给 null', () => {
  assert.equal(projectIconUrl('c:\\ws\\demo', null), null);
  const url = projectIconUrl('c:\\ws\\demo', { rel: 'public/favicon.svg', mime: 'image/svg+xml', mtimeMs: 1234 });
  assert.equal(url, '/api/workbench/project-icon?path=c%3A%5Cws%5Cdemo&v=1234');
  assert.equal(
    projectIconUrl('c:\\ws\\demo', { remote: 'https://cdn.example.com/logo.png', mtimeMs: 0 }),
    'https://cdn.example.com/logo.png',
  );
});
