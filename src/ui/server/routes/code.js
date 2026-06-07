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
import * as vm from 'node:vm';

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

export function registerCodeRoutes({ app }) {
  app.post('/api/execute-code-node', async (req, res) => {
    try {
      const { script, input, param } = req.body || {};

      if (!script || typeof script !== 'string' || !script.trim()) {
        return res.status(400).json({ success: false, error: 'script 不能为空' });
      }

      const inputText = typeof input === 'string' ? input : (input === undefined || input === null ? '' : String(input));

      const paramObj = (param && typeof param === 'object') ? param : undefined;

      const wrapped = `"use strict";\n${script}\n`;

      const sandbox = {
        input: inputText,
        param: paramObj,
        main: undefined
      };

      const context = vm.createContext(sandbox, {
        name: 'code-node-sandbox'
      });

      const vmScript = new vm.Script(wrapped, { filename: 'code-node.js' });

      let result;
      try {
        result = vmScript.runInContext(context, { timeout: 800 });
      } catch (e) {
        return res.status(400).json({ success: false, error: e?.message || String(e) });
      }

      const mainFn = context.main || sandbox.main;
      if (typeof mainFn !== 'function') {
        return res.status(400).json({ success: false, error: '未找到 main(param) 函数' });
      }

      let finalResult = result;
      try {
        finalResult = mainFn(paramObj || {});
      } catch (e) {
        return res.status(400).json({ success: false, error: e?.message || String(e) });
      }

      const outputs = normalizeOutputs(finalResult);

      return res.json({ success: true, outputs });
    } catch (error) {
      return res.status(500).json({ success: false, error: error?.message || String(error) });
    }
  });
}
