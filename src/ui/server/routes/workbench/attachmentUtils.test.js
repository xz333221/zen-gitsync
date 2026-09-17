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
// 派发附件暂存区的纯函数单测。
//
// 这一层是**安全边界**：派发时前端只回传 { id, ext }，文件路径完全由服务端拼。
// 所以"无论前端传什么，产物都不会跑出暂存目录"必须由断言钉死 ——
// 一旦 stagingPath 的校验被放松，就等于开了一个任意文件读取/覆盖的口子。
//
// 只测纯函数，不碰真实文件系统：临时目录相关行为（findStagingFile / cleanup）
// 由端到端验证覆盖，避免单测在用户真实的 ~/.zen-gitsync 里制造/删除文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DISPATCH_STAGING_DIR,
  ALLOWED_EXTS,
  isSafeAttId,
  mimeForExt,
  stagingPath,
} from './attachmentUtils.js';

test('stagingPath：合法 id + 白名单后缀 → 落在暂存目录内', () => {
  const p = stagingPath('mu55toof-2555ou', 'png');
  assert.equal(p, path.join(DISPATCH_STAGING_DIR, 'mu55toof-2555ou.png'));
});

test('stagingPath：大写后缀归一成小写', () => {
  assert.equal(
    stagingPath('mu55toof-2555ou', 'PNG'),
    path.join(DISPATCH_STAGING_DIR, 'mu55toof-2555ou.png'),
  );
});

test('stagingPath：id 含路径分隔符 / 上跳 / 空白一律拒绝', () => {
  const bad = ['../../etc/passwd', 'a/b', 'a\\b', '..', '', 'x', 'a b', 'a/../b', 'a'.repeat(70)];
  for (const id of bad) {
    assert.equal(stagingPath(id, 'png'), null, `应拒绝 id=${JSON.stringify(id)}`);
  }
});

test('stagingPath：后缀不在白名单一律拒绝（含可执行文件与拼接花招）', () => {
  const bad = ['exe', 'sh', 'bat', '', '.', 'png/../evil', 'png.exe', '..'];
  for (const ext of bad) {
    assert.equal(stagingPath('mu55toof-2555ou', ext), null, `应拒绝 ext=${JSON.stringify(ext)}`);
  }
});

test('stagingPath：任何输入下产物都不会跳出暂存目录', () => {
  const ids = ['../../evil', '..\\..\\evil', '/abs', 'C:/windows/x', 'a'.repeat(100), 'a--b'];
  const exts = ['png', 'jpg', 'pdf', '../../x', 'exe'];
  for (const id of ids) {
    for (const ext of exts) {
      const p = stagingPath(id, ext);
      if (p === null) continue;
      assert.equal(path.dirname(p), DISPATCH_STAGING_DIR, `产物跑出了暂存目录：${p}`);
    }
  }
});

test('isSafeAttId：只放行 genId 形状', () => {
  assert.ok(isSafeAttId('mu55toof-2555ou'));
  assert.ok(isSafeAttId('abc12'));
  assert.ok(!isSafeAttId('ab'), '太短');
  assert.ok(!isSafeAttId('a'.repeat(70)), '太长');
  assert.ok(!isSafeAttId('has space'));
  assert.ok(!isSafeAttId('has/slash'));
  assert.ok(!isSafeAttId('-leading-dash'), '不能以连字符开头');
  assert.ok(!isSafeAttId(''));
  assert.ok(!isSafeAttId(null));
  assert.ok(!isSafeAttId(42));
});

test('mimeForExt：常见后缀给具体类型，未知回退 octet-stream', () => {
  assert.equal(mimeForExt('png'), 'image/png');
  assert.equal(mimeForExt('JPG'), 'image/jpeg');
  assert.equal(mimeForExt('pdf'), 'application/pdf');
  assert.equal(mimeForExt('exe'), 'application/octet-stream');
  assert.equal(mimeForExt(''), 'application/octet-stream');
});

test('白名单与 mime 映射同源：每个允许的后缀都能反查出具体 mime', () => {
  for (const ext of ALLOWED_EXTS) {
    const m = mimeForExt(ext);
    assert.ok(m && m !== 'application/octet-stream', `${ext} 没有对应的具体 mime`);
  }
});
