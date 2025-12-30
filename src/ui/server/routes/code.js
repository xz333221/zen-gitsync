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
