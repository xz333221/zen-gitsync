import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { __testables, registerAiDiffSummaryRoutes } from './aiDiffSummary.js';

const { collectDiff, createContentOnlyStream, createSummaryCache, truncateOverallDiff } = __testables;

function registerTestRoute({ execGitCommand, cache, callLlmStreamImpl, cwd }) {
  let handler;
  const app = {
    post(_path, ...handlers) { handler = handlers.at(-1); }
  };
  registerAiDiffSummaryRoutes({
    app,
    execGitCommand,
    cache,
    callLlmStreamImpl,
    getCwd: () => cwd,
    configManager: {
      readRawConfigFile: async () => ({
        models: [{ id: 'model-1', baseURL: 'https://example.test', model: 'summary-model', isDefault: true }]
      })
    }
  });
  return handler;
}

async function invokeRoute(handler, body) {
  let output = '';
  const req = { body, socket: { once() {} } };
  const res = {
    set() {},
    flushHeaders() {},
    write(chunk) { output += chunk; },
    end() {}
  };
  await handler(req, res);
  return output.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5).trim()));
}

test('inline think blocks are removed even when tags are split across chunks', () => {
  const output = [];
  const stream = createContentOnlyStream((content) => output.push(content));
  for (const chunk of ['<thi', 'nk>internal reasoning</th', 'ink>final ', 'summary']) {
    stream.feed(chunk);
  }
  stream.flush();
  assert.equal(output.join(''), 'final summary');
});

test('overall worktree diff includes untracked file content', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-ai-diff-'));
  try {
    await fs.writeFile(path.join(cwd, 'new.txt'), 'untracked content', 'utf8');
    const execGitCommand = async (args) => {
      if (args[0] === 'diff') return { stdout: 'diff --git a/a.txt b/a.txt\n+tracked\n' };
      if (args[0] === 'ls-files') return { stdout: 'new.txt\0' };
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    };

    const result = await collectDiff({
      execGitCommand,
      scope: 'overall',
      source: 'worktree',
      file: '',
      hash: '',
      cwd
    });

    assert.match(result.diffText, /diff --git a\/a\.txt b\/a\.txt/);
    assert.match(result.diffText, /diff --git a\/new\.txt b\/new\.txt/);
    assert.match(result.diffText, /\+untracked content/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('overall truncation samples every changed file', () => {
  const source = Array.from({ length: 8 }, (_, index) => (
    `diff --git a/file-${index}.js b/file-${index}.js\n` + `+${String(index).repeat(800)}\n`
  )).join('');

  const result = truncateOverallDiff(source, 2400);
  for (let index = 0; index < 8; index += 1) {
    assert.match(result, new RegExp(`file-${index}\\.js`));
  }
  assert.ok(result.length <= 2400);
});

test('route rejects invalid source and non-hash commit revisions before calling git', async () => {
  let handler;
  const app = {
    post(_path, ...handlers) { handler = handlers.at(-1); }
  };
  let gitCalls = 0;
  registerAiDiffSummaryRoutes({
    app,
    execGitCommand: async () => { gitCalls += 1; return { stdout: '' }; },
    configManager: { readRawConfigFile: async () => ({ models: [{}] }) }
  });

  async function invoke(body) {
    let output = '';
    const req = { body, socket: { once() {} } };
    const res = {
      set() {},
      flushHeaders() {},
      write(chunk) { output += chunk; },
      end() {}
    };
    await handler(req, res);
    return output;
  }

  assert.match(await invoke({ scope: 'file', source: 'stash', file: 'a.txt' }), /BAD_REQUEST/);
  assert.match(await invoke({ scope: 'overall', source: 'commit', hash: '--help' }), /BAD_REQUEST/);
  assert.equal(gitCalls, 0);
});

test('commit summaries persist across cache instances and skip git on a hit', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-ai-summary-cache-'));
  let gitCalls = 0;
  let llmCalls = 0;
  const execGitCommand = async () => {
    gitCalls += 1;
    return { stdout: 'diff --git a/a.js b/a.js\n+const value = 1;\n' };
  };
  const callLlmStreamImpl = async (_model, _prompt, onDelta) => {
    llmCalls += 1;
    onDelta({ content: 'cached commit summary' });
    return { aborted: false };
  };

  try {
    const body = { scope: 'overall', source: 'commit', hash: 'abcdef1', locale: 'zh' };
    const firstHandler = registerTestRoute({
      execGitCommand,
      cache: createSummaryCache({ directory: cacheDir }),
      callLlmStreamImpl,
      cwd: 'C:/repo'
    });
    const first = await invokeRoute(firstHandler, body);

    const secondHandler = registerTestRoute({
      execGitCommand,
      cache: createSummaryCache({ directory: cacheDir }),
      callLlmStreamImpl,
      cwd: 'C:/repo'
    });
    const second = await invokeRoute(secondHandler, body);

    assert.equal(first.at(-1).cached, false);
    assert.equal(second.at(-1).cached, true);
    assert.equal(second[0].content, 'cached commit summary');
    assert.equal(llmCalls, 1);
    assert.equal(gitCalls, 1);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('worktree cache follows actual diff content and bypassCache forces regeneration', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-ai-summary-cache-'));
  let diffText = 'diff --git a/a.js b/a.js\n+const value = 1;\n';
  let llmCalls = 0;
  const execGitCommand = async (args) => {
    if (args[0] === 'diff') return { stdout: diffText };
    if (args[0] === 'ls-files') return { stdout: '' };
    throw new Error(`unexpected git command: ${args.join(' ')}`);
  };
  const callLlmStreamImpl = async (_model, _prompt, onDelta) => {
    llmCalls += 1;
    onDelta({ content: `worktree summary ${llmCalls}` });
    return { aborted: false };
  };

  try {
    const handler = registerTestRoute({
      execGitCommand,
      cache: createSummaryCache({ directory: cacheDir }),
      callLlmStreamImpl,
      cwd: 'C:/repo'
    });
    const body = { scope: 'overall', source: 'worktree', locale: 'zh' };

    assert.equal((await invokeRoute(handler, body)).at(-1).cached, false);
    assert.equal((await invokeRoute(handler, body)).at(-1).cached, true);
    assert.equal(llmCalls, 1);

    diffText = 'diff --git a/a.js b/a.js\n+const value = 2;\n';
    assert.equal((await invokeRoute(handler, body)).at(-1).cached, false);
    assert.equal(llmCalls, 2);

    assert.equal((await invokeRoute(handler, { ...body, bypassCache: true })).at(-1).cached, false);
    assert.equal(llmCalls, 3);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
