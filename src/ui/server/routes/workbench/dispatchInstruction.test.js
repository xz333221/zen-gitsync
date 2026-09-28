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

// 共用派发器的回归测试。
//
// 守的是 2026-09-28 这次改造立下的三条：
//   1. 派发只有**一份实现** —— HTTP 端点与内置智能体的 dispatch_task 工具都落到这里。
//      本文件直接测这份实现；两个入口各自的"取字段 / 压成字符串"由
//      agentRoutes.test.js 与 scripts/verify-workbench-agent-dispatch.mjs 覆盖。
//   2. 闸门语义不变：autoRun=false 或调度暂停 → 只建任务不执行（指令流水里写明原因）。
//   3. 落点依据如实记录（explicit / mention / agent / default），
//      它是用户在活动流里回答"为什么派到这儿了"的唯一依据。
//
// 隔离：必须在 import 之前把 USERPROFILE/HOME 指向 mkdtemp 沙箱 ——
// dispatchInstruction.js 会经 shared.js 算出 tasks.json / orchestrator.json 的真实路径，
// 不隔离就是在用户真实的 ~/.zen-gitsync 上写任务（同 jobStore.test.js 的做法）。
//
// 执行入口用 runTask 注入口桩掉：真跑一次会 spawn 用户本机的 claude CLI。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');

// ---- 环境隔离:必须在 import 之前完成 ----
const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'zgs-dispatch-test-'));
const savedEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
};
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
delete process.env.HOMEDRIVE;
delete process.env.HOMEPATH;

const load = p => import(pathToFileURL(path.join(projectRoot, p)).href);
const { createDispatcher, resolveExecutor } = await load('src/ui/server/routes/workbench/dispatchInstruction.js');
const { readOrchestrator, setOrchestratorActive, setDefaultPrompt } = await load('src/ui/server/routes/workbench/orchestratorStore.js');
const { readJson, TASKS_FILE } = await load('src/ui/server/routes/workbench/shared.js');

// 两个项目目录：proj 是"选中/当前"的落点，other 用来证明显式指定优先于默认
const proj = path.join(fakeHome, 'proj-alpha');
const other = path.join(fakeHome, 'proj-beta');

/** 记录被派出去的执行（不真的 spawn 本地 CLI） */
const launched = [];

function makeDispatcher(overrides = {}) {
  return createDispatcher({
    configManager: {
      getRecentDirectories: async () => [proj, other],
      readRawConfigFile: async () => ({ models: [] }),
      // 全局默认执行器：默认测例里用 codex，好和"回落 claude"区分开
      loadConfig: async () => ({ taskExecutor: 'codex' }),
      ...overrides.configManager,
    },
    getCurrentProjectPath: () => proj,
    runTask: (...args) => { launched.push(args); return Promise.resolve(); },
  });
}

const readTasks = async () => (await readJson(TASKS_FILE, { tasks: [] })).tasks || [];

before(async () => {
  await fs.mkdir(proj, { recursive: true });
  await fs.mkdir(other, { recursive: true });
});

after(async () => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
});

test('派发建出一条任务，标题取首行、正文是整段指令', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const result = await dispatchInstruction({
    text: '给登录模块补错误处理\n第二行是细节',
    // 只建不跑：这一条测的是"任务长什么样"，不是执行
    autoRun: false,
  });

  assert.equal(result.ran, false);
  assert.equal(result.task.projectPath, proj);
  assert.equal(result.task.title, '给登录模块补错误处理');
  assert.equal(result.task.desc, '给登录模块补错误处理\n第二行是细节');
  assert.equal(result.task.status, 'todo');
  assert.equal(result.instruction.status, 'created');
  assert.equal(result.instruction.taskId, result.task.id);
  assert.equal(result.executor, null, '只建不跑时不该去解析执行器');

  const tasks = await readTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, result.task.id);
});

test('落点：显式指定优先于默认项目，并如实记进指令流水', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const result = await dispatchInstruction({
    text: '把 README 的安装步骤补齐',
    projectPath: other,
    autoRun: false,
  });
  assert.equal(result.task.projectPath, other);
  assert.equal(result.instruction.targetSource, 'explicit');
  assert.equal(result.target.path, other);
});

test('落点：没给目标时退到默认项目，依据记为 default', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const result = await dispatchInstruction({ text: '随便做点什么', autoRun: false });
  assert.equal(result.task.projectPath, proj);
  assert.equal(result.instruction.targetSource, 'default');
});

test('调度暂停时只建任务不执行，指令流水写明原因', async () => {
  const { dispatchInstruction } = makeDispatcher();
  await setOrchestratorActive(false);
  try {
    const before = launched.length;
    const result = await dispatchInstruction({ text: '暂停期间派一条', autoRun: true });
    assert.equal(result.schedulingActive, false);
    assert.equal(result.ran, false);
    assert.match(result.instruction.reason, /调度已暂停/);
    assert.equal(launched.length, before, '暂停期间不该有任何执行');
    assert.equal(result.executor, null);
  } finally {
    await setOrchestratorActive(true);
  }
});

test('autoRun=true 且调度中：交给执行入口，执行器按参数 > 配置默认解析', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const explicit = await dispatchInstruction({ text: '显式指定 opencode', autoRun: true, executor: 'opencode' });
  assert.equal(explicit.ran, true);
  assert.equal(explicit.executor, 'opencode');
  assert.equal(launched.length, 1);
  // 传给执行入口的是 (task, virtualSub, repoPath, branch, { executor })
  const [task, sub, repoPath, branch, opts] = launched[0];
  assert.equal(task.id, explicit.task.id);
  assert.equal(sub.id, `${explicit.task.id}__simple`, '一条任务 = 一次会话，运行载体的 id 仍是 __simple');
  assert.equal(sub.promptOverride, task.simpleOverride);
  assert.equal(repoPath, proj);
  assert.equal(branch, '');
  assert.deepEqual(opts, { executor: 'opencode' });

  // 不指定 → 配置里的全局默认（本例是 codex）
  const fallback = await dispatchInstruction({ text: '跟随全局默认', autoRun: true });
  assert.equal(fallback.executor, 'codex');

  // 非法值 → 回落 claude（resolveExecutor 的回落链）
  const bad = await dispatchInstruction({ text: '执行器写错了', autoRun: true, executor: 'not-a-cli' });
  assert.equal(bad.executor, 'codex', '非法值先归一到 undefined，再走配置默认');
  const { dispatchInstruction: noCfg } = createDispatcher({
    configManager: { getRecentDirectories: async () => [proj], readRawConfigFile: async () => ({ models: [] }) },
    getCurrentProjectPath: () => proj,
    runTask: () => Promise.resolve(),
  });
  const noCfgResult = await noCfg({ text: '连配置都读不到', autoRun: true });
  assert.equal(noCfgResult.executor, 'claude', '配置读不出来时回落 claude，而不是派发失败');
});

test('默认提示词按落点项目解析并抄进任务；显式关掉时不带', async () => {
  await setDefaultPrompt('派发时先跑一遍 lint');
  try {
    const { dispatchInstruction } = makeDispatcher();
    const withPrompt = await dispatchInstruction({ text: '带默认提示词', autoRun: false });
    assert.match(withPrompt.task.simpleOverride, /先跑一遍 lint/);
    assert.equal(withPrompt.instruction.promptSource !== '', true);

    const without = await dispatchInstruction({ text: '这次不带', autoRun: false, useDefaultPrompt: false });
    assert.equal(without.task.simpleOverride, '');
    assert.equal(without.instruction.promptSource, '');
  } finally {
    await setDefaultPrompt('');
  }
});

test('空指令 / 超长指令一律 400，不留下任务', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const before = (await readTasks()).length;
  await assert.rejects(() => dispatchInstruction({ text: '   ' }), err => err.statusCode === 400 && /指令内容不能为空/.test(err.message));
  await assert.rejects(() => dispatchInstruction({ text: 'x'.repeat(4001) }), err => err.statusCode === 400 && /指令过长/.test(err.message));
  assert.equal((await readTasks()).length, before);
});

test('目标目录不存在：记一条 rejected 流水再抛 400', async () => {
  const { dispatchInstruction } = makeDispatcher();
  const missing = path.join(fakeHome, 'not-created-yet');
  await assert.rejects(
    () => dispatchInstruction({ text: '派到一个不存在的目录', projectPath: missing, autoRun: false }),
    err => err.statusCode === 400 && /项目目录不存在/.test(err.message),
  );
  const state = await readOrchestrator();
  const rejected = state.instructions.filter(i => i.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, '项目目录不存在');
  assert.equal(rejected[0].projectPath, missing);
});

test('resolveExecutor：显式 > 配置默认 > claude', async () => {
  assert.equal(await resolveExecutor('opencode', null), 'opencode');
  assert.equal(await resolveExecutor('', { loadConfig: async () => ({ taskExecutor: 'codex' }) }), 'codex');
  assert.equal(await resolveExecutor('', { loadConfig: async () => ({ taskExecutor: 'nope' }) }), 'claude');
  assert.equal(await resolveExecutor('', { loadConfig: async () => { throw new Error('读盘炸了'); } }), 'claude');
});
