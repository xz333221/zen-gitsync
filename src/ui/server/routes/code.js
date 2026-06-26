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
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeOutputs(outputs) {
  if (!isPlainObject(outputs)) return {};

  const result = {};
  const entries = Object.entries(outputs);

  for (const [key, val] of entries) {
    const safeKey = String(key || '').trim();
    if (!safeKey) continue;
    if (safeKey.length > 64) continue;

    if (val === undefined || val === null) {
      result[safeKey] = '';
      continue;
    }

    if (typeof val === 'string') {
      result[safeKey] = val;
      continue;
    }

    if (typeof val === 'number' || typeof val === 'boolean') {
      result[safeKey] = String(val);
      continue;
    }

    try {
      result[safeKey] = JSON.stringify(val);
    } catch {
      result[safeKey] = String(val);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// 隔离 worker 的内联源码
//
// 设计目标(SEC-RCE-1):
//   1. 用 node:worker_threads 隔离执行,代码拿不到主进程 process / require / 原型链
//   2. 用 vm.runInNewContext + codeGeneration:{strings:false,wasm:false}
//      阻断 Function()/eval/wasm 逃逸
//   3. sandbox 只暴露 param + input + 简易 console,其余全局一概不挂
//   4. 主进程通过 postMessage 接受输出,有超时强杀兜底
//
// 注意:此 worker 不 require 任何东西,直接接 workerData,主进程用
// eval:true 加载。所以即使攻击者写出 require('fs') 也会因为
// require 未注入而抛 ReferenceError。
// ─────────────────────────────────────────────────────────────────────────────
const ISOLATED_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

// 简易 console — 把 log/error 转给主进程,避免被 throw 中断业务流程
function safeStringify(v) {
  try {
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const safeConsole = {
  log: (...args) => parentPort.postMessage({ type: 'log', data: args.map(safeStringify) }),
  info: (...args) => parentPort.postMessage({ type: 'log', data: args.map(safeStringify) }),
  warn: (...args) => parentPort.postMessage({ type: 'log', data: args.map(safeStringify), level: 'warn' }),
  error: (...args) => parentPort.postMessage({ type: 'log', data: args.map(safeStringify), level: 'error' }),
};

// sandbox 只挂白名单:input / param / console / main 占位
const sandbox = {
  input: workerData.input,
  param: workerData.param,
  main: undefined,
  console: safeConsole,
};

const context = vm.createContext(sandbox, {
  name: 'zen-code-node-sandbox',
  codeGeneration: {
    // 关键:strings:false 阻断 Function()/eval 构造可执行字符串;
    // wasm:false 阻断 WebAssembly.compile 跳出沙箱。
    strings: false,
    wasm: false,
  },
});

const script = new vm.Script(workerData.wrapped, {
  filename: 'code-node.js',
});

let result;
try {
  result = script.runInContext(context);
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  process.exit(0);
}

const mainFn = context.main || sandbox.main;
if (typeof mainFn !== 'function') {
  parentPort.postMessage({ type: 'error', message: '未找到 main(param) 函数' });
  process.exit(0);
}

let finalResult = result;
try {
  finalResult = mainFn(workerData.param || {});
} catch (e) {
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  process.exit(0);
}

parentPort.postMessage({ type: 'done', outputs: finalResult });
`;

// 单条执行的最大耗时 — 不可绕过,worker 仍会跑但主进程会立刻返回错误
const HARD_TIMEOUT_MS = 3000;
// 单条执行的内存上限 — 64MB,超过则 worker 被 Node 杀掉
const MAX_HEAP_MB = 64;

function runIsolated({ script, input, param }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { worker.terminate(); } catch { /* ignore */ }
      resolve(payload);
    };

    let worker;
    try {
      worker = new Worker(ISOLATED_WORKER_SOURCE, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: MAX_HEAP_MB,
          maxYoungGenerationSizeMb: 16,
        },
      });
    } catch (err) {
      return finish({ ok: false, error: `创建隔离 worker 失败: ${err?.message || err}` });
    }

    const hardTimer = setTimeout(() => {
      finish({ ok: false, error: `脚本执行超时(>${HARD_TIMEOUT_MS}ms),已强制终止` });
    }, HARD_TIMEOUT_MS);

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'done') {
        clearTimeout(hardTimer);
        finish({ ok: true, outputs: msg.outputs });
      } else if (msg.type === 'error') {
        clearTimeout(hardTimer);
        finish({ ok: false, error: msg.message || '脚本执行报错' });
      } else if (msg.type === 'log') {
        // console 输出:不打日志(避免污染主进程日志 + 防止无限刷屏),
        // 用户如有需要可在 param 里挂回调
      }
    });

    worker.on('error', (err) => {
      clearTimeout(hardTimer);
      finish({ ok: false, error: `worker 错误: ${err?.message || err}` });
    });

    worker.on('exit', (code) => {
      clearTimeout(hardTimer);
      // code=1 通常是未捕获异常,我们已经在 message/error 里处理过
      // code=0 是正常路径。如果还没 settle,补一个兜底
      if (!settled) {
        finish({ ok: false, error: `worker 异常退出(exit code=${code})` });
      }
    });

    worker.postMessage({
      wrapped: `"use strict";\n${script}\n`,
      input: typeof input === 'string' ? input : '',
      param: (param && typeof param === 'object' && !Array.isArray(param)) ? param : {},
    });
  });
}

export function registerCodeRoutes({ app }) {
  app.post('/api/execute-code-node', async (req, res) => {
    try {
      const { script, input, param } = req.body || {};

      if (!script || typeof script !== 'string' || !script.trim()) {
        return res.status(400).json({ success: false, error: 'script 不能为空' });
      }

      // 限制脚本长度,防止单请求塞一个 1MB 的"脚本"进来阻塞 worker
      const MAX_SCRIPT_LEN = 20000;
      if (script.length > MAX_SCRIPT_LEN) {
        return res.status(400).json({ success: false, error: `script 过长(>${MAX_SCRIPT_LEN} 字符)` });
      }

      const inputText = typeof input === 'string' ? input : (input === undefined || input === null ? '' : String(input));
      const paramObj = (param && typeof param === 'object' && !Array.isArray(param)) ? param : {};

      const result = await runIsolated({ script, input: inputText, param: paramObj });

      if (!result.ok) {
        return res.status(400).json({ success: false, error: result.error });
      }

      const outputs = normalizeOutputs(result.outputs);
      return res.json({ success: true, outputs });
    } catch (error) {
      return res.status(500).json({ success: false, error: error?.message || String(error) });
    }
  });
}