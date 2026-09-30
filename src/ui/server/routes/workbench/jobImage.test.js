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
// 正文内嵌图片的路径判定单测（jobImage.js）。
//
// 这个模块是 `/api/workbench/jobs/:id/image` 的**权限边界**：判错一条
// （比如 `..` 没挡住、或把兄弟目录当成了子目录）就等于把整台机器的任意文件
// 开了个读取口子。而它又是纯字符串/路径运算 —— 正是那种"看着对、边界一塌糊涂"
// 的地方，所以边界用例逐条钉在这里。
//
// 路径夹具一律用 `path.resolve` 造，不写死 `C:\…`：这份测试在 Windows 和
// Linux 上都要跑得通（盘符相关的用例单独按 process.platform 分支）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';

import {
  normalizeImagePath,
  imageExtOf,
  isInsideRoot,
  resolveJobImagePath,
  IMAGE_PATH_ERRORS,
  IMAGE_PATH_STATUS,
} from './jobImage.js';

const ROOT = path.resolve(path.join('/tmp', 'ws', 'repo'));
const inside = (...seg) => path.join(ROOT, ...seg);

test('相对路径按仓库根解析（模型常写 docs/screenshots/a.png）', () => {
  const r = resolveJobImagePath({ root: ROOT, requested: 'docs/screenshots/a.png' });
  assert.equal(r.ok, true);
  assert.equal(r.absPath, inside('docs', 'screenshots', 'a.png'));
  assert.equal(r.ext, 'png');
  assert.equal(r.mime, 'image/png');
});

test('仓库内的绝对路径原样通过', () => {
  const abs = inside('docs', 'b.JPEG');
  const r = resolveJobImagePath({ root: ROOT, requested: abs });
  assert.equal(r.ok, true);
  assert.equal(r.absPath, abs);
  // 后缀判定不区分大小写，否则 `A.PNG` 会被当成"不是图片"
  assert.equal(r.ext, 'jpeg');
  assert.equal(r.mime, 'image/jpeg');
});

test('`..` 穿越一律挡掉（相对与绝对两种写法）', () => {
  for (const bad of [
    '../secret.png',
    path.join('docs', '..', '..', 'secret.png'),
    path.resolve(ROOT, '..', 'secret.png'),
    path.resolve(ROOT, '..', '..', 'windows', 'system32', 'x.png'),
  ]) {
    const r = resolveJobImagePath({ root: ROOT, requested: bad });
    assert.equal(r.ok, false, `应当拒绝: ${bad}`);
    assert.equal(r.reason, 'outside-root');
  }
});

test('兄弟目录不是子目录（前缀相同也不行）', () => {
  // 用 startsWith(root) 判权限的经典漏洞：D:\ws\repo-old 会被当成 D:\ws\repo 内部
  const sibling = `${ROOT}-old${path.sep}a.png`;
  assert.equal(isInsideRoot(ROOT, sibling), false);
  const r = resolveJobImagePath({ root: ROOT, requested: sibling });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outside-root');
});

test('仓库根自身不是文件', () => {
  // 目录不是文件 —— realpath 那一步也会拦，但这一层先判掉，省一次读盘
  assert.equal(isInsideRoot(ROOT, ROOT), false);
  // 后缀为空的路径在更前面就被 bad-ext 拦了，走不到这里（两种拒绝都算正常）
  assert.equal(resolveJobImagePath({ root: ROOT, requested: '.' }).ok, false);
});

test('只认图片后缀，其余一律 415', () => {
  for (const bad of ['a.txt', 'a.md', 'a.exe', 'a', 'docs/.env', 'a.png.txt', 'a.png/../b.txt']) {
    const r = resolveJobImagePath({ root: ROOT, requested: bad });
    assert.equal(r.ok, false, `应当拒绝: ${bad}`);
    assert.ok(r.reason === 'bad-ext' || r.reason === 'outside-root', `实际 reason=${r.reason}`);
  }
  // 明确挑一条纯后缀问题，别让上面那条断言把两种情况混着放过
  assert.equal(resolveJobImagePath({ root: ROOT, requested: 'docs/a.txt' }).reason, 'bad-ext');
  assert.equal(IMAGE_PATH_STATUS['bad-ext'], 415);
});

test('空值 / 空白 / NUL 字节不往下走', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}, 'a\u0000.png']) {
    assert.equal(resolveJobImagePath({ root: ROOT, requested: bad }).reason, 'empty');
  }
});

test('仓库路径缺失时不猜、直接拒', () => {
  for (const root of ['', '   ', null, undefined]) {
    const r = resolveJobImagePath({ root, requested: inside('a.png') });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-root');
  }
  assert.equal(IMAGE_PATH_STATUS['no-root'], 400);
});

test('模型给的包裹写法要认（尖括号 / 反引号 / 引号 / file://）', () => {
  assert.equal(normalizeImagePath('  <docs/a.png>  '), 'docs/a.png');
  assert.equal(normalizeImagePath('`docs/a.png`'), 'docs/a.png');
  assert.equal(normalizeImagePath('"docs/a.png"'), 'docs/a.png');
  assert.equal(normalizeImagePath("'docs/a.png'"), 'docs/a.png');
  // 只脱**成对**的包裹：单个尖括号是模型打漏了，脱掉反而会拼出一个它没写过的路径
  assert.equal(normalizeImagePath('<docs/a.png'), '<docs/a.png');

  const viaFileUrl = normalizeImagePath(`file://${ROOT.replace(/\\/g, '/')}/a.png`);
  const r = resolveJobImagePath({ root: ROOT, requested: `file://${ROOT.replace(/\\/g, '/')}/a.png` });
  assert.equal(r.ok, true, `file:// 形式应当能解析，实际: ${JSON.stringify({ viaFileUrl, r })}`);
  assert.equal(r.absPath, inside('a.png'));
});

test('win32 的盘符形式 file:///C:/… 不能把盘符当成相对目录', { skip: process.platform !== 'win32' }, () => {
  // file:///C:/a.png → 去掉协议后是 /C:/a.png，多那个斜杠会让 resolve 把它当相对路径
  assert.equal(normalizeImagePath('file:///C:/ws/a.png'), 'C:/ws/a.png');
  assert.equal(normalizeImagePath('file:///c:\\ws\\a.png'), 'c:\\ws\\a.png');
});

test('跨盘符（win32）判为不在仓库内', { skip: process.platform !== 'win32' }, () => {
  const r = resolveJobImagePath({ root: ROOT, requested: 'D:\\other\\a.png' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outside-root');
});

test('后缀提取：取最后一段，不把目录名当后缀', () => {
  assert.equal(imageExtOf('a/b/c.PNG'), 'png');
  assert.equal(imageExtOf('a.png/b'), '');
  assert.equal(imageExtOf('a.'), '');
  assert.equal(imageExtOf(''), '');
});

test('错误码与文案一一对应（路由按 reason 直接取，不用再猜）', () => {
  for (const reason of Object.keys(IMAGE_PATH_ERRORS)) {
    assert.ok(IMAGE_PATH_STATUS[reason], `reason「${reason}」缺状态码`);
  }
  // 越权是 403、后缀不对是 415：别都糊成 400，排查时看不出是"路径不合法"还是"没权限"
  assert.equal(IMAGE_PATH_STATUS['outside-root'], 403);
});
