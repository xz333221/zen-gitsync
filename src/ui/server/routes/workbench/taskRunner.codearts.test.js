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

// codearts 执行器（华为云码道 CLI）的回归测试（2026-10-25）。
//
// 钉住的口径（**event fixtures 全部取自本机 26.10.9 的真实输出**，
// 不是照文档抄的）：
//   1. 白名单 / 归一化里有 codearts（config.js 与 taskRunner 两份清单一致）
//   2. spawn argv：run --format json --auto [+ -s <ses_id>]；
//      --auto 必须带（默认档是 sandbox，沙箱里 git 读不到真实仓库状态，
//      而派发链要 agent 自己 commit）；不出现 --model（跟随它自己的配置）
//   3. 子进程环境：必须复刻 codearts.cmd 那串 OPENCODE_* / KERNEL_* ——
//      少了它们它会去读用户自己那套 opencode 的配置与 db；且刻意**不抄**
//      NODE_TLS_REJECT_UNAUTHORIZED=0（shim 里有，抄进来会污染本进程所有 TLS）
//   4. 事件映射：它是 opencode 的 fork，事件流与 OpenCode 逐字同构
//      （step_start / text / reasoning / tool_use / step_finish / error），
//      handler 直接转调 createOpencodeEventHandler —— 这里仍钉一遍，
//      因为它哪天改协议时这条会先红
//   5. 它会往项目根写 .codeartsdoer/（且该文件不在它自己的 .gitignore 里），
//      launcher 要往 .git/info/exclude 补一行，且要幂等、非仓库目录不炸
//
// 隔离策略同 taskRunner.pi.test.js：import taskRunner.js 之前把
// USERPROFILE/HOME 指向 mkdtemp 沙箱（taskRunner → jobStore import 时就会 hydrate）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 环境隔离:必须在 import taskRunner.js 之前完成 ----
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'zen-taskrunner-codearts-test-'));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const {
  createCodeArtsEventHandler,
  buildCodeArtsArgs,
  buildCodeArtsEnv,
  resolveCodeArtsExe,
  ensureCodeArtsGitExclude,
  TASK_EXECUTORS,
  EXECUTOR_LAUNCHERS,
  EXECUTOR_HANDLERS,
  normalizeTaskExecutor,
} = await import(pathToFileURL(path.join(__dirname, 'taskRunner.js')).href);

// ── 真实事件 fixture（本机 26.10.9 跑 "运行 git branch --show-current" 的输出）──
const SES = 'ses_e8d69660cffe8XcrTbjDt67x01';
const FIXTURE = [
  { type: 'step_start', timestamp: 1792923814179, sessionID: SES, part: { id: 'prt_1', messageID: 'msg_1', sessionID: SES, type: 'step-start' } },
  {
    type: 'tool_use', timestamp: 1792923815513, sessionID: SES,
    part: {
      id: 'prt_2', messageID: 'msg_1', sessionID: SES, type: 'tool', tool: 'bash', callID: 'chatcmpl-tool-b8c7',
      state: {
        status: 'completed',
        input: { command: 'git branch --show-current', description: '显示当前Git分支名' },
        output: 'master\n',
        metadata: { executeMode: 'auto_mode', exit: 0, timedOut: false },
        title: '显示当前Git分支名',
      },
    },
  },
  {
    type: 'step_finish', timestamp: 1792923815810, sessionID: SES,
    part: { id: 'prt_3', reason: 'tool-calls', messageID: 'msg_1', sessionID: SES, type: 'step-finish', tokens: { total: 11257, input: 8634, output: 36 }, cost: 0 },
  },
  { type: 'step_start', timestamp: 1792923817908, sessionID: SES, part: { id: 'prt_4', messageID: 'msg_2', sessionID: SES, type: 'step-start' } },
  { type: 'text', timestamp: 1792923818587, sessionID: SES, part: { id: 'prt_5', messageID: 'msg_2', sessionID: SES, type: 'text', text: 'master' } },
  { type: 'step_finish', timestamp: 1792923818596, sessionID: SES, part: { id: 'prt_6', reason: 'stop', messageID: 'msg_2', sessionID: SES, type: 'step-finish', tokens: { total: 11284 }, cost: 0 } },
];

/** 造一个和 handler 契约一致的 job + 收集器 */
function makeHarness() {
  const job = { id: 'job-1', claudeSessionId: '', agentError: '' };
  const out = { text: '', thinking: '', tools: [] };
  const handler = createCodeArtsEventHandler(
    job,
    (t) => { out.text += t; },
    (t) => { out.thinking += t; },
    { record: (call) => out.tools.push(call) }
  );
  return { job, out, handler };
}

test('normalizeTaskExecutor：codearts 在白名单里，非法值回落 claude', () => {
  assert.deepEqual(TASK_EXECUTORS, ['claude', 'opencode', 'codex', 'codebuddy', 'pi', 'codearts']);
  assert.equal(normalizeTaskExecutor('codearts'), 'codearts');
  assert.equal(normalizeTaskExecutor('CodeArts'), 'codearts');
  assert.equal(normalizeTaskExecutor(' codearts '), 'codearts');
  // 历史默认不能变：老配置 / 老 job 缺 executor 时仍落在 claude
  assert.equal(normalizeTaskExecutor(undefined), 'claude');
  assert.equal(normalizeTaskExecutor('cursor'), 'claude');
});

test('launcher / handler 两张表都登记了 codearts（与 TASK_EXECUTORS 对齐）', () => {
  for (const id of TASK_EXECUTORS) {
    assert.equal(typeof EXECUTOR_LAUNCHERS[id], 'function', `${id} 缺 launcher`);
    assert.equal(typeof EXECUTOR_HANDLERS[id], 'function', `${id} 缺 handler`);
  }
});

test('buildCodeArtsArgs：run --format json --auto，不带 --model / --sandbox', () => {
  const args = buildCodeArtsArgs('');
  assert.deepEqual(args, ['run', '--format', 'json', '--auto']);
  // 跟随 CLI 自己的模型配置（与另五家同一口径）
  assert.ok(!args.includes('--model'));
  // ⚠️ 必须 --auto：默认档是 sandbox，沙箱里 git 读不到真实仓库状态，
  // 而派发链要 agent 自己 commit。两个开关互斥，别同时出现。
  assert.ok(!args.includes('--sandbox'));
});

test('buildCodeArtsArgs：有续接 id 时追加 -s <id>（原地续，sessionID 不变）', () => {
  const args = buildCodeArtsArgs(SES);
  assert.deepEqual(args, ['run', '--format', 'json', '--auto', '-s', SES]);
});

test('buildCodeArtsEnv：复刻 shim 的 OPENCODE_* / KERNEL_*，但不抄关证书校验那个开关', () => {
  const had = {};
  const pollution = {
    CODEARTS_CLI_AK: 'ak-from-env',
    CODEARTS_CLI_SK: 'sk-from-env',
  };
  for (const [k, v] of Object.entries(pollution)) { had[k] = process.env[k]; process.env[k] = v; }
  // 这条要断言"我们不主动设"，所以先确保父进程里没有（有的话会原样继承，
  // 那属于用户自己的运行环境，不该被 launcher 悄悄改掉）
  had.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    const env = buildCodeArtsEnv();
    // 身份：少了这两个它会去读 ~/.config/opencode 与 ~/.local/share/opencode 的 db
    assert.equal(env.SCENARIO, 'codeartsdoer');
    assert.equal(env.KERNEL_DATA_DIR, path.join(sandbox, '.codeartsdoer', 'cli-data'));
    assert.equal(env.KERNEL_CONFIG_DIR, path.join(sandbox, '.codeartsdoer'));
    assert.equal(env.OPENCODE_CONFIG, path.join(sandbox, '.codeartsdoer', 'codearts_cli.json'));
    assert.equal(env.OPENCODE_CONFIG_FILE, 'codearts_cli.json,codearts_cli.jsonc');
    assert.equal(env.PLUGIN_ENV, 'hc');
    // 关自动更新 / 关遥测（与另几家同一性质）
    assert.equal(env.CODEARTS_DISABLE_AUTO_UPDATE, 'true');
    assert.equal(env.OMO_SEND_ANONYMOUS_TELEMETRY, '0');
    assert.equal(env.LANG, 'zh_CN.UTF-8');
    // AK/SK 从父进程继承（这是它唯一的鉴权方式）
    assert.equal(env.CODEARTS_CLI_AK, 'ak-from-env');
    assert.equal(env.CODEARTS_CLI_SK, 'sk-from-env');
    // ⚠️ shim 里有 NODE_TLS_REJECT_UNAUTHORIZED=0，刻意不抄：
    // 它会关掉本进程派生出的所有 TLS 校验。实测不设也能正常连华为云。
    assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  } finally {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('resolveCodeArtsExe：沙箱里没装时回落，不抛异常', () => {
  const got = resolveCodeArtsExe();
  assert.equal(typeof got.exe, 'string');
  assert.ok(got.exe.length > 0);
  assert.ok(Array.isArray(got.prefixArgs));
});

test('handler：sessionID → claudeSessionId（续接走同一个字段）', () => {
  const { job, handler } = makeHarness();
  for (const evt of FIXTURE) handler(evt);
  assert.equal(job.claudeSessionId, SES);
  assert.equal(job.agentError, '');
});

test('handler：正文与工具调用（completed → done，output 带上）', () => {
  const { out, handler } = makeHarness();
  for (const evt of FIXTURE) handler(evt);
  assert.equal(out.text, 'master');
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'bash');
  assert.equal(out.tools[0].status, 'done');
  assert.match(String(out.tools[0].output), /master/);
});

test('handler：error 事件落 agentError（只记第一条）', () => {
  const { job, handler } = makeHarness();
  handler({ type: 'error', sessionID: SES, error: { name: 'ProviderError', data: { message: '额度已用完' } } });
  handler({ type: 'error', sessionID: SES, error: { name: 'Other', data: { message: '第二条不该覆盖' } } });
  assert.equal(job.agentError, '额度已用完');
});

test('handler：非 JSON 行（免费套餐的"模型排队"提示）不会写进正文', () => {
  // 解析层（runSingleSubtask / runExternalTurn）负责 try/catch 跳过非 JSON；
  // 这里钉住"即使错误地喂进来也不会污染正文"。
  const { out, job, handler } = makeHarness();
  assert.doesNotThrow(() => handler(null));
  assert.doesNotThrow(() => handler('模型排队'));
  assert.doesNotThrow(() => handler({ type: 'unknown-event' }));
  assert.equal(out.text, '');
  assert.equal(job.agentError, '');
});

test('ensureCodeArtsGitExclude：写 <repo>/.git/info/exclude，幂等，非仓库目录不炸', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'zen-codearts-exclude-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const excludeFile = path.join(repo, '.git', 'info', 'exclude');

  ensureCodeArtsGitExclude(repo);
  const first = fs.readFileSync(excludeFile, 'utf8');
  assert.ok(first.split(/\r?\n/).includes('.codeartsdoer/'));

  // 再跑一次不能重复加行
  ensureCodeArtsGitExclude(repo);
  const second = fs.readFileSync(excludeFile, 'utf8');
  assert.equal(second, first);

  // 非仓库目录：静默返回
  const plain = mkdtempSync(path.join(os.tmpdir(), 'zen-codearts-plain-'));
  assert.doesNotThrow(() => ensureCodeArtsGitExclude(plain));
});

test('ensureCodeArtsGitExclude：补了 exclude 之后 .codeartsdoer/ 不算脏', () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'zen-codearts-dirty-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });

  // 模拟 codearts 跑完留下的东西
  fs.mkdirSync(path.join(repo, '.codeartsdoer'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.codeartsdoer', 'mem-exp-config.json'), '{}\n');
  const dirtyBefore = execFileSync('git', ['status', '--short'], { cwd: repo }).toString();
  assert.match(dirtyBefore, /\.codeartsdoer/);

  ensureCodeArtsGitExclude(repo);
  const dirtyAfter = execFileSync('git', ['status', '--short'], { cwd: repo }).toString();
  assert.equal(dirtyAfter.trim(), '');
});
