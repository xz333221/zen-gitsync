// clone.js 单元测试
// 模式参照 remotes.test.js:node:test + 假 app 捕获 handler + 注入 runCloneImpl 替身。
// 关键:所有用例都不联网、不真跑 git —— runCloneImpl 一律换成计数用的替身,
// 唯一的"真实"依赖是本地文件系统(校验父目录要用 fs.stat)。
//
// 克隆成功后路由会调 rememberRepo() 把落点登记进本机仓库清单(「已克隆」徽标用),
// 那一步会**写盘** —— 必须先把缓存路径指到临时文件,否则测试会往用户真实的
// ~/.zen-gitsync/local-repos.json 里塞一堆 os.tmpdir() 下的假记录。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { registerGitCloneRoutes, repoNameFromUrl, describeCloneError } from './clone.js';
import { resetLocalRepoScan } from '../../utils/localRepoScan.js';
import { HttpError } from '../../utils/asyncRoute.js';

// 缓存路径必须在**任何用例跑起来之前**指到临时文件。写在 import 之间没用
// (ESM 的 import 全部提升),好在 cacheFilePath() 是每次调用才读 env,
// 所以放在这里同样生效 —— 真正要防的是"用例跑的时候还指着家目录"。
const CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-clone-cache-'));
process.env.ZEN_LOCAL_REPOS_CACHE = path.join(CACHE_DIR, 'local-repos.json');

after(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

// ── 测试工具 ─────────────────────────────────────────────────────────────

function makeApp() {
  const handlers = {};
  const app = {
    get(p, ...hs) { handlers[`GET ${p}`] = hs.at(-1); },
    post(p, ...hs) { handlers[`POST ${p}`] = hs.at(-1); }
  };
  return { app, handlers };
}

async function invoke(handler, body = {}) {
  let statusCode = 200;
  let payload;
  const req = { body, method: 'POST', path: '/api/clone' };
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; }
  };
  await handler(req, res, () => {});
  return { statusCode, payload };
}

/** 注册路由并返回 handler;runCloneImpl 默认是个永远不该被调到的替身 */
function register(runCloneImpl = async () => { throw new Error('不该真的跑 git clone'); }) {
  const { app, handlers } = makeApp();
  registerGitCloneRoutes({ app, runCloneImpl });
  return handlers['POST /api/clone'];
}

/** 建一个临时父目录,返回路径(用例结束自己删) */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zen-clone-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── repoNameFromUrl ─────────────────────────────────────────────────────

test('repoNameFromUrl:从各种地址形态里取出仓库名', () => {
  assert.equal(repoNameFromUrl('git@github.com:xz333221/zen-gitsync.git'), 'zen-gitsync');
  assert.equal(repoNameFromUrl('https://gitee.com/xz_web/xiangyu-sites'), 'xiangyu-sites');
  // 尾斜杠 + .git 同时出现
  assert.equal(repoNameFromUrl('https://github.com/a/b.git/'), 'b');
  // ssh:// 形式(带端口)也走同一条路径
  assert.equal(repoNameFromUrl('ssh://git@github.com:22/a/b.git'), 'b');
  // 取不出来 → 空串,由调用方兜底成 repository
  assert.equal(repoNameFromUrl(''), '');
  assert.equal(repoNameFromUrl('   '), '');
  // 只有纯路径分隔符才真的取不出东西;根地址(没有仓库段)会退化成 host,
  // 不是空串 —— 钉住这个行为,免得以后误以为它一定是"干净"的仓库名
  assert.equal(repoNameFromUrl('/'), '');
  assert.equal(repoNameFromUrl('https://github.com/'), 'github.com');
});

// ── describeCloneError ──────────────────────────────────────────────────

test('describeCloneError:超时说人话,其余透出 git 的最后一行', () => {
  assert.match(describeCloneError({ killed: true }), /超时/);
  assert.match(describeCloneError({ signal: 'SIGTERM' }), /超时/);
  assert.equal(
    describeCloneError({ stderr: 'Cloning into...\nwarning: 一些警告\nfatal: repository not found\n' }),
    'fatal: repository not found'
  );
  assert.equal(describeCloneError({ message: 'spawn git ENOENT' }), 'spawn git ENOENT');
  assert.equal(describeCloneError({}), '克隆失败');
});

// ── 正常路径 ────────────────────────────────────────────────────────────

test('克隆成功:在父目录下建出以仓库名命名的子目录', async () => {
  const parent = tmpDir();
  const seen = [];
  const handler = register(async (args) => { seen.push(args); });

  const { payload } = await invoke(handler, {
    url: 'git@github.com:xz333221/zen-gitsync.git',
    parentDir: parent
  });

  assert.equal(payload.success, true);
  assert.equal(payload.path, path.join(path.resolve(parent), 'zen-gitsync'));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    url: 'git@github.com:xz333221/zen-gitsync.git',
    parentDir: path.resolve(parent),
    target: path.join(path.resolve(parent), 'zen-gitsync')
  });

  cleanup(parent);
});

test('地址取不出仓库名时,兜底成 repository 而不是拼出一个父目录本身', async () => {
  const parent = tmpDir();
  const seen = [];
  const handler = register(async (args) => { seen.push(args); });

  // '/' 这种地址 assertGitRemoteUrl 放行(本地路径形态),但取不出仓库名
  const { payload } = await invoke(handler, { url: '/', parentDir: parent });

  assert.equal(payload.success, true);
  assert.equal(seen[0].target, path.join(path.resolve(parent), 'repository'));

  cleanup(parent);
});

// ── 拒绝的入参 ──────────────────────────────────────────────────────────

test('地址非法:空 / ext:: / 把"远程名 + 地址"一起粘进来 —— 一律拒绝且不跑 git', async () => {
  const parent = tmpDir();
  let called = 0;
  const handler = register(async () => { called += 1; });

  for (const url of ['', '   ', 'ext::sh -c whoami', 'origin git@gitee.com:x/y.git']) {
    const { payload } = await invoke(handler, { url, parentDir: parent });
    assert.equal(payload.success, false, `url=${JSON.stringify(url)}`);
    assert.ok(payload.error, `url=${JSON.stringify(url)} 应带错误说明`);
  }
  assert.equal(called, 0, '入参不合法时一次都不该执行 git clone');

  cleanup(parent);
});

test('父目录：不存在 / 不是目录 / 相对路径 —— 一律拒绝且不跑 git', async () => {
  const parent = tmpDir();
  const filePath = path.join(parent, 'a-file.txt');
  fs.writeFileSync(filePath, 'x');
  let called = 0;
  const handler = register(async () => { called += 1; });

  const cases = [
    [path.join(parent, 'not-exist'), /不存在/],
    [filePath, /不是文件夹/],
    ['relative/dir', /绝对路径/],
    ['', /缺少目标文件夹/]
  ];
  for (const [parentDir, pattern] of cases) {
    const { payload } = await invoke(handler, {
      url: 'git@github.com:a/b.git',
      parentDir
    });
    assert.equal(payload.success, false, `parentDir=${parentDir}`);
    assert.match(payload.error, pattern);
  }
  assert.equal(called, 0);

  cleanup(parent);
});

test('目标子目录已存在：先拦下,把路径说清楚,不去撞 git 那句英文报错', async () => {
  const parent = tmpDir();
  fs.mkdirSync(path.join(parent, 'zen-gitsync'));
  let called = 0;
  const handler = register(async () => { called += 1; });

  const { payload } = await invoke(handler, {
    url: 'git@github.com:xz333221/zen-gitsync.git',
    parentDir: parent
  });

  assert.equal(payload.success, false);
  assert.match(payload.error, /已存在/);
  assert.match(payload.error, /zen-gitsync/);
  assert.equal(called, 0);

  cleanup(parent);
});

// ── 失败透传 ────────────────────────────────────────────────────────────

test('git 失败:状态码与错误原文透给前端', async () => {
  const parent = tmpDir();
  const handler = register(async () => {
    throw new HttpError(500, 'fatal: could not read from remote repository');
  });

  const { statusCode, payload } = await invoke(handler, {
    url: 'git@github.com:a/b.git',
    parentDir: parent
  });

  assert.equal(statusCode, 500);
  assert.equal(payload.success, false);
  assert.match(payload.error, /could not read from remote repository/);

  cleanup(parent);
});

// ── 克隆成功后登记本机仓库清单 ──────────────────────────────────────────

test('克隆成功:落点被登记进本机仓库清单,徽标不必等下一次全盘重扫', async () => {
  const parent = tmpDir();
  const cachePath = process.env.ZEN_LOCAL_REPOS_CACHE;
  const prevRepo = path.join(parent, 'already-known');

  // 造一份"上次全盘扫的结果":登记只该往里加一条,不能把整份盖掉
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      scannedAt: 1,
      scannedDirs: 2,
      roots: ['X:/'],
      repos: { [prevRepo]: 'https://gitee.com/xz_web/xiangqi.git' }
    }),
    'utf8'
  );
  resetLocalRepoScan();

  const handler = register(async () => {});
  const { payload } = await invoke(handler, {
    url: 'git@github.com:xz333221/zen-gitsync.git',
    parentDir: parent
  });
  assert.equal(payload.success, true);

  const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(raw.repos[payload.path], 'git@github.com:xz333221/zen-gitsync.git');
  assert.equal(raw.repos[prevRepo], 'https://gitee.com/xz_web/xiangqi.git', '旧记录必须还在');
  // 登记 ≠ 重扫:时间戳保持原样,否则前端会以为"刚扫过"
  assert.equal(raw.scannedAt, 1);

  cleanup(parent);
});
