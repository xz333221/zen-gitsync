// CLI(`g ai`)与 Web 智能体面板之间**共享口径**的一致性守卫。
//
// 为什么需要：同一套逻辑在本仓库反复出现"两边各写一份"的历史 ——
//   路径归一   : projectRegistry.js ↔ 前端 utils/path.ts
//   智能体提示词: agent.js(zh/en) ↔ agentChat.js(zh/en)，共四处
//   上下文准备  : CLI 已改成「条数/字符双预算 + 丢弃项摘录成梗概」，
//                Web 侧还停在「按条数硬切 40 + 纯 splice 丢弃」，而且它的 splice 是
//                **原地**改 session.messages —— 聊久了模型失忆，磁盘上的会话记录还被永久削掉一截
//   LLM 传输    : Web 侧自带的 streamChatOnce 不拦"流被截断但 tool_calls 已部分到达"，
//                半截的参数有可能被拿去执行
// 这类分叉的失效方式是「**不报错，两个入口表现不一样**」，很难被发现。所以这里不验证
// 模型行为（也没法验），只钉住三件事：压缩/传输逻辑各只有一份实现、两个入口都必须走它、
// 口径参数不许在调用点各自硬写。谁要是想再抄一份，就会撞上下面的第三条测试。
//
// 共享模块：src/cli/ai/context.js（上下文）、src/cli/ai/transport.js（传输）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(here, '..', '..', '..', '..');
const SHARED_DIR = path.resolve(SRC_ROOT, 'cli', 'ai');

const CONTEXT_FILE = path.join(SHARED_DIR, 'context.js');
const TRANSPORT_FILE = path.join(SHARED_DIR, 'transport.js');

// 两个入口。CLI 侧的循环在 turn.js，Web 侧在 agentChat.js。
const ENTRY_POINTS = [
  { label: 'CLI(g ai) turn.js', file: path.join(SHARED_DIR, 'turn.js') },
  { label: 'Web 智能体面板 agentChat.js', file: path.join(here, 'agentChat.js') },
];

// 每条共享口径:模块 + 导出名 + 调用点的额外要求
const SHARED = [
  {
    what: '上下文准备',
    module: CONTEXT_FILE,
    exported: 'prepareRequestMessages',
    // 预算只留在共享模块里,调用点必须把 locale 传进去(旧图片占位符要分语言)
    mustPass: [/locale/],
    mustNotPass: [/maxMessages/, /maxChars/],
  },
  {
    what: 'LLM 传输',
    module: TRANSPORT_FILE,
    exported: 'streamChatOnce',
  },
];

const SCAN_EXT = /\.(js|mjs|cjs|ts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'public']);

function walk(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      walk(full, acc);
    } else if (SCAN_EXT.test(name)) acc.push(full);
  }
  return acc;
}

/** 取出 `name(...)` 的实参文本（够用的括号配对，调用点都很简单）。 */
function callArgs(src, name) {
  const at = src.indexOf(name + '(');
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) return src.slice(at + name.length + 1, i); }
  }
  return '';
}

const importLineFor = (src, name) => src.split(/\r?\n/)
  .find(l => /^import\s/.test(l) && new RegExp(`\\b${name}\\b`).test(l));

test('两个入口都从同一份共享模块导入,并真的用它', () => {
  for (const { what, module, exported } of SHARED) {
    for (const { label, file } of ENTRY_POINTS) {
      const src = readFileSync(file, 'utf8');
      const line = importLineFor(src, exported);
      assert.ok(line, `${label} 没有导入 ${exported}（${what}）：必须收敛到共享模块`);
      const spec = /from\s*['"]([^'"]+)['"]/.exec(line)?.[1];
      assert.ok(spec, `${label} 的 import 语句里找不到模块路径`);
      assert.equal(
        path.resolve(path.dirname(file), spec),
        module,
        `${label} 从别处导入了 ${exported}：两个入口必须用同一份实现`,
      );
      // 除了 import 那行之外还得真的出现在别处（被调用、被赋值给变量都算）
      const body = src.split(/\r?\n/).filter(l => l !== line).join('\n');
      assert.match(body, new RegExp(`\\b${exported}\\b`), `${label} 导入了 ${exported} 却没用`);
    }
  }
});

test('口径参数只在共享模块里定义,调用点不许自己硬写', () => {
  const { mustPass = [], mustNotPass = [] } = SHARED[0];
  for (const { label, file } of ENTRY_POINTS) {
    const args = callArgs(readFileSync(file, 'utf8'), 'prepareRequestMessages');
    assert.ok(args !== null, `${label} 没有调用 prepareRequestMessages`);
    for (const re of mustPass) assert.match(args, re, `${label} 的调用漏了 ${re}（旧图片占位符会退化成中文）`);
    for (const re of mustNotPass) {
      assert.doesNotMatch(
        args,
        re,
        `${label} 自己指定了预算（${re}）：预算口径必须留在 context.js，否则两侧又会慢慢漂开`,
      );
    }
  }
});

test('压缩与传输逻辑在生产代码里各只有一处实现', () => {
  // 这些是"再分叉一次"会留下的脚印：本地函数定义与本地上限常量。
  // 只认定义（const/function），不认注释里的提及 —— 注释提到历史是正常的。
  const PRIMITIVES = [
    { what: '本地 sanitizeMessages 定义', re: /function\s+sanitizeMessages\s*\(/ },
    { what: '本地 stripStaleImages 定义', re: /function\s+stripStaleImages\s*\(/ },
    { what: '本地历史裁剪函数', re: /function\s+trimHistory\s*\(/ },
    { what: '本地历史条数上限常量', re: /const\s+MAX_HISTORY_MESSAGES\s*=/ },
    { what: '本地请求副本构造函数', re: /function\s+buildRequestMessages\s*\(/ },
    { what: '本地 LLM 传输函数', re: /function\s+streamChatOnce\s*\(/ },
    { what: '本地 LLM 超时常量', re: /const\s+LLM_TIMEOUT_MS\s*=/ },
  ];
  const owners = new Set([CONTEXT_FILE, TRANSPORT_FILE]);
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    if (owners.has(file) || /\.test\./.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const { what, re } of PRIMITIVES) {
      if (re.test(src)) offenders.push(`${what} → ${path.relative(SRC_ROOT, file)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '检测到第二份压缩/传输实现。CLI 与 Web 必须共用 src/cli/ai/ 下的共享模块，不要各写一遍 —— ' +
      '这条链路的失效方式是"不报错但两个入口表现不一样"，很难被发现。\n' +
      offenders.join('\n'),
  );
});

test('共享模块本身必须导出这些口径', () => {
  const expectations = [
    [CONTEXT_FILE, ['prepareRequestMessages', 'sanitizeMessages', 'stripStaleImages', 'buildRequestMessages']],
    [TRANSPORT_FILE, ['streamChatOnce', 'httpFailure']],
  ];
  for (const [file, names] of expectations) {
    const src = readFileSync(file, 'utf8');
    for (const name of names) {
      assert.match(
        src,
        new RegExp(`(export function|function) ${name}\\s*\\(`),
        `${path.basename(file)} 不再定义 ${name}`,
      );
    }
  }
});

test('两个入口都把推理内容写进 assistant 历史消息', () => {
  // 上游要求（DeepSeek 系 thinking 模式 + tool calls）：回传的历史里，assistant 消息当初产出的
  // reasoning_content 必须原样带回，否则下一轮请求被 400 拒掉：
  //   The `reasoning_content` in the thinking mode must be passed back to the API.
  // 传输层已经把它返回了（streamChatOnce 的 result.reasoning），漏的是"入历史"这一步 ——
  // Web 侧曾经只解构 content/toolCalls，于是纯聊天没事、一调工具就挂，又是两个入口表现分叉。
  // 只认代码行，注释里的提及不算（CLI 是 `assistant.reasoning_content = …`，Web 是 `reasoning_content: …`）。
  for (const { label, file } of ENTRY_POINTS) {
    const code = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.match(code, /reasoning_content/, `${label} 没有把推理内容写进 assistant 历史消息`);
  }
});
