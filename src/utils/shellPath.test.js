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
// shellPath 的回归测试。
//
// 重点守住三件在 Windows 上真的会把功能做坏、但**不会报错**的事：
//   1. PATH 键名大小写 —— 写错会往环境块里塞出两个 PATH 键（"前置了却没生效"的经典成因）；
//   2. 补进去的目录必须在**末尾**（前置会改掉用户既有的命令解析顺序）；
//   3. 只读 HKLM 或只读 HKCU 都不够 —— winget/MSI 写 Machine，npm -g 写 User，
//      漏一侧就是 gh 能装不能用那个 bug（实测踩过）。
//
// 全部用注入的 execFileFn，不碰真实注册表：测试不该依赖"本机恰好装了什么"。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  augmentEnvPath,
  expandVars,
  findPathKey,
  invalidatePathCache,
  isCommandNotFound,
  missingPathDirs,
  parseRegQueryPath,
  pathValueOf,
  readRegistryPathDirs,
  splitPathList,
  withPathValue,
} from './shellPath.js';

/** 造一个假的 `reg query` 输出。 */
const regOut = (value) => `\r\nHKEY_LOCAL_MACHINE\\Sub\\Key\r\n    Path    REG_EXPAND_SZ    ${value}\r\n\r\n`;

/** execFileFn 桩：按注册表键返回 machine / user 两个值，传 null 表示"该键没有 Path"。 */
function regStub({ machine = null, user = null, calls = { n: 0 } } = {}) {
  const fn = async (_file, args) => {
    calls.n += 1;
    const key = String(args?.[1] || '');
    const value = key.includes('Session Manager') ? machine : user;
    if (value == null) {
      const err = new Error('reg query 未找到该值');
      err.code = 1;
      throw err;
    }
    return { stdout: regOut(value) };
  };
  fn.calls = calls;
  return fn;
}

test('parseRegQueryPath: 认得 REG_SZ 与 REG_EXPAND_SZ，没有该值时返回 null', () => {
  assert.equal(parseRegQueryPath(regOut('C:\\A;C:\\B')), 'C:\\A;C:\\B');
  assert.equal(
    parseRegQueryPath('\r\nHKEY\r\n    Path    REG_SZ    C:\\Only\r\n'),
    'C:\\Only',
  );
  assert.equal(parseRegQueryPath('错误: 系统找不到指定的注册表项或值。'), null);
  assert.equal(parseRegQueryPath(''), null);
  // 值名必须整段匹配，别把 `SomePath` / `PathExtra` 当成 Path
  assert.equal(parseRegQueryPath('    SomePath    REG_SZ    C:\\Nope\r\n'), null);
});

test('expandVars: 变量大小写不敏感，展不开就原样保留', () => {
  const env = { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\xuze' };
  assert.equal(expandVars('%SystemRoot%\\system32;%userprofile%\\bin', env), 'C:\\Windows\\system32;C:\\Users\\xuze\\bin');
  // 认不出来时保留原文：宁可子进程里报"路径不存在"，也不能静默删掉一段 PATH
  assert.equal(expandVars('%NOPE%\\x', env), '%NOPE%\\x');
});

test('missingPathDirs: 忽略大小写与结尾分隔符，保持注册表顺序，且自身去重', () => {
  const current = 'C:\\Windows;C:\\Tools\\';
  const dirs = ['c:\\windows', 'C:\\Tools', 'D:\\New', 'd:\\new\\', 'E:\\Other'];
  assert.deepEqual(missingPathDirs(current, dirs), ['D:\\New', 'E:\\Other']);
});

test('withPathValue: 沿用原有键名大小写，绝不出现两个 PATH 键', () => {
  // 这是"前置了却没生效"的成因：node 在 Windows 上拿到的键名可能是 Path 而不是 PATH
  const withCapital = withPathValue({ Path: 'C:\\A', FOO: '1' }, 'C:\\A;C:\\B');
  assert.deepEqual(Object.keys(withCapital).filter((k) => /^path$/i.test(k)), ['Path']);
  assert.equal(withCapital.Path, 'C:\\A;C:\\B');
  assert.equal(withCapital.FOO, '1');

  const withUpper = withPathValue({ PATH: 'C:\\A' }, 'C:\\B');
  assert.deepEqual(Object.keys(withUpper), ['PATH']);

  // 原本两个变体都在（父进程给的环境块有重复键）→ 收敛成一个
  const collapse = withPathValue({ Path: 'old', PATH: 'old2' }, 'new');
  assert.equal(Object.keys(collapse).filter((k) => /^path$/i.test(k)).length, 1);
  assert.equal(collapse.Path, 'new');
  assert.equal(collapse.PATH, undefined);

  // 原本没有 PATH → 补一个
  assert.equal(withPathValue({ FOO: '1' }, 'C:\\X').PATH, 'C:\\X');
});

test('findPathKey / pathValueOf: 键名大小写无关', () => {
  assert.equal(findPathKey({ Path: 'a' }), 'Path');
  assert.equal(findPathKey({ PATH: 'a' }), 'PATH');
  assert.equal(findPathKey({ PATH: 'a', Path: 'b' }), 'PATH');
  assert.equal(findPathKey({ OTHER: 'a' }), null);
  assert.equal(pathValueOf({ PATH: 'a' }), 'a');
  assert.equal(pathValueOf({}), '');
});

test('splitPathList: 丢空白与空段（PATH 里的 ";;" 是历史垃圾）', () => {
  assert.deepEqual(splitPathList('C:\\A;;  C:\\B  ;'), ['C:\\A', 'C:\\B']);
  assert.deepEqual(splitPathList(''), []);
  assert.deepEqual(splitPathList(undefined), []);
  assert.deepEqual(splitPathList('C:\\A;C:\\B', { delimiter: ';' }), ['C:\\A', 'C:\\B']);
});

test('isCommandNotFound: 认得四种"整条命令没被执行过"的说法', () => {
  assert.ok(isCommandNotFound("'gh' 不是内部或外部命令，也不是可运行的程序"));
  assert.ok(isCommandNotFound("'gh' is not recognized as an internal or external command"));
  assert.ok(isCommandNotFound('sh: gh: command not found'));
  assert.ok(isCommandNotFound('', 'spawn gh ENOENT'));

  // 刻意不算：这条可能只是**参数**文件缺失，而调用方会据此重试命令 ——
  // 对有副作用的命令重试是危险的，所以宁可不认
  assert.equal(isCommandNotFound('cat: missing.txt: No such file or directory'), false);
  assert.equal(isCommandNotFound(''), false);
  assert.equal(isCommandNotFound(undefined, null), false);
});

test('readRegistryPathDirs: 非 win32 直接返回空数组，不 spawn 任何东西', async () => {
  const stub = regStub({ machine: 'C:\\A' });
  assert.deepEqual(await readRegistryPathDirs({ platform: 'linux', execFileFn: stub }), []);
  assert.equal(stub.calls.n, 0);
});

test('augmentEnvPath: 非 win32 原样返回同一引用（调用方无需判断平台）', async () => {
  const env = { PATH: '/usr/bin' };
  assert.equal(await augmentEnvPath(env, { platform: 'linux' }), env);
});

test('augmentEnvPath: 把注册表里缺的目录补到**末尾**，原始顺序一个不动', async () => {
  const env = { Path: 'C:\\Windows;C:\\Keep', SystemRoot: 'C:\\Windows' };
  const stub = regStub({
    machine: 'C:\\Program Files\\GitHub CLI;%SystemRoot%\\system32',
    user: 'C:\\Users\\xuze\\AppData\\Local\\Programs\\Fake',
  });
  const out = await augmentEnvPath(env, { platform: 'win32', execFileFn: stub, ttlMs: 0 });

  // 末尾追加 + 变量已展开 + Machine 在 User 之前（与 Windows 自身的拼接顺序一致）
  assert.equal(
    out.Path,
    'C:\\Windows;C:\\Keep;C:\\Program Files\\GitHub CLI;C:\\Windows\\system32;C:\\Users\\xuze\\AppData\\Local\\Programs\\Fake',
  );
  // 键名沿用原有的 Path；同时确认没被塞出第二个 PATH 键
  assert.deepEqual(Object.keys(out).filter((k) => /^path$/i.test(k)), ['Path']);
  // 入参不被改动 —— 这个模块刻意不产生进程级副作用
  assert.equal(env.Path, 'C:\\Windows;C:\\Keep');
  assert.equal(env.PATH, undefined);
});

test('augmentEnvPath: 已经是超集时原样返回同一引用（不白拼一遍 PATH）', async () => {
  const env = { Path: 'C:\\A;C:\\B' };
  const stub = regStub({ machine: 'c:\\a\\', user: 'C:\\B' });
  const out = await augmentEnvPath(env, { platform: 'win32', execFileFn: stub, ttlMs: 0 });
  assert.equal(out, env);
});

test('augmentEnvPath: 注册表读不到（键不存在 / reg 不可用）时静默降级', async () => {
  const env = { Path: 'C:\\A' };
  const stub = regStub({ machine: null, user: null });
  const out = await augmentEnvPath(env, { platform: 'win32', execFileFn: stub, ttlMs: 0 });
  assert.equal(out, env);

  const boom = async () => { throw Object.assign(new Error('reg.exe 被策略禁止'), { code: 'EPERM' }); };
  assert.equal(await augmentEnvPath(env, { platform: 'win32', execFileFn: boom, ttlMs: 0 }), env);
});

test('缓存：TTL 内不重复读注册表，force 会绕过 TTL，ttlMs=0 等于禁用缓存', async () => {
  const env = { Path: 'C:\\Windows' };

  invalidatePathCache();
  const cached = regStub({ machine: 'C:\\First', user: null });
  const first = await augmentEnvPath({ ...env }, { platform: 'win32', execFileFn: cached });
  const second = await augmentEnvPath({ ...env }, { platform: 'win32', execFileFn: cached });
  assert.equal(first.Path, 'C:\\Windows;C:\\First');
  assert.equal(second.Path, 'C:\\Windows;C:\\First');
  // 两次调用都让 augment 生效了，但注册表只读了一轮（machine + user = 2 次）
  assert.equal(cached.calls.n, 2, 'TTL 内应命中缓存，不该重复 spawn reg.exe');

  // force：装完新 CLI 后立刻生效的路径（tools.js 在"命令找不到"时会用这个重试）
  const forced = regStub({ machine: 'C:\\Windows;C:\\Second', user: null });
  const forcedOut = await augmentEnvPath({ ...env }, { platform: 'win32', execFileFn: forced, force: true });
  assert.equal(forcedOut.Path, 'C:\\Windows;C:\\Second');
  assert.equal(forced.calls.n, 2);

  // ttlMs=0：彻底不缓存，每次真读（测试隔离与"宁慢也要新"的场景）
  const uncached = regStub({ machine: 'C:\\Third', user: null });
  await augmentEnvPath({ ...env }, { platform: 'win32', execFileFn: uncached, ttlMs: 0 });
  await augmentEnvPath({ ...env }, { platform: 'win32', execFileFn: uncached, ttlMs: 0 });
  assert.equal(uncached.calls.n, 4);

  invalidatePathCache();
});

test('缓存内容就是注册表目录本身，与"当前进程 PATH 长什么样"无关', async () => {
  // 这条钉住设计意图：缓存的是注册表读取结果（慢的那一步），
  // 而"缺哪些目录"每次都在内存里重新比对 —— 所以进程 PATH 变了不会读到陈旧值
  invalidatePathCache();
  const stub = regStub({ machine: 'C:\\Reg1;C:\\Reg2', user: null });
  const a = await augmentEnvPath({ Path: 'C:\\Reg1' }, { platform: 'win32', execFileFn: stub });
  assert.equal(a.Path, 'C:\\Reg1;C:\\Reg2');
  const b = await augmentEnvPath({ Path: 'C:\\Reg1;C:\\Reg2' }, { platform: 'win32', execFileFn: stub });
  assert.equal(b.Path, 'C:\\Reg1;C:\\Reg2');
  assert.equal(stub.calls.n, 2, '第二轮不该再读注册表');
  invalidatePathCache();
});
