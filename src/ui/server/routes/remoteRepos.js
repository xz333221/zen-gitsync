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
// 远程托管平台仓库列表(GitHub / Gitee 两个 Tab 的数据源)。
//
// 为什么是"调 CLI"而不是"直连 API":
//   两个平台都有自己的官方 CLI,凭据由 CLI 自己保管(`gh auth login` /
//   `gitee auth login`)。走 CLI 意味着 ZenGitSync 不需要知道、也不需要转发
//   任何 token —— 我们不碰用户的令牌,只读 CLI 的输出。代价是解析 CLI 的
//   文本/JSON 输出,下面每个解析点都注明了依据。
//
// 为什么两个平台的"是否已登录"判定方式不同(踩过的坑):
//   · gh    : `gh auth status` 未登录时**退出码 1**,看 exit code 即可。
//   · gitee : `gitee auth status` 未登录时**退出码仍然是 0**(实测 v0.3.1),
//            只能解析 `--json` 输出的 status 字段。用退出码判会永远认为"已登录",
//            然后 repo list 报 "Not logged in" —— 所以 gitee 走 JSON 解析。
//
// 为什么安装完能立刻检测到(不必重启服务):
//   winget / npm 装完之后是把目录写进**用户环境变量 Path**,而已经跑起来的
//   node 进程持有的还是老 PATH,`where.exe` 找不到新装的命令。所以这里除了
//   where.exe,还会去读注册表 HKCU\Environment 的 Path 自己拼候选路径
//   (与 fileOpen.js 的 findKimiExecutable 同一套思路),再兜几个装包管理器的
//   默认落点。否则"一键安装 → 自动刷新列表"会在刷新时永远停在"未安装"。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asyncRoute, HttpError } from '../utils/asyncRoute.js';
import { getToolInstallers, launchCommandInTerminal, parseVersionOutput, publicInstallerInfo } from './fileOpen.js';
import logger from '../utils/logger.js';

/** 单条 CLI 命令的超时。gh repo list / gitee repo list 都要联网,
 *  国内直连 GitHub 有时要十几秒;给足余量但不能无限等(前端在轮询)。 */
const CLI_TIMEOUT_MS = 25000;

/** gitee 的分页上限:`--limit` 单页最大 100,翻到第 3 页还没完就停,
 *  避免仓库上千的用户把一次请求拖成十几秒。 */
const GITEE_MAX_PAGES = 3;
const GITEE_PAGE_SIZE = 100;

/** gh repo list 一次拉够。gh 自己会翻页。 */
const GH_LIMIT = 200;

/**
 * provider 白名单。前端只能传这个 key,命令与参数全部由服务端决定 ——
 * 与 /api/install-tool 同一条原则:命令不进请求体。
 */
const PROVIDERS = Object.freeze({
  github: {
    label: 'GitHub',
    cli: 'gh',
    /** 安装白名单里的 key(见 fileOpen.js getToolInstallers)。
     *  注意它和 provider 名不同:provider 叫 github,工具 id 叫 gh。 */
    toolId: 'gh',
    docsUrl: 'https://cli.github.com/',
    loginCommand: 'gh auth login',
    /** 装包管理器(winget / brew / 系统包管理器)可能在 PATH 之外落地的位置 */
    windowsFallbacks: [
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
    ],
    posixFallbacks: ['/usr/local/bin/gh', '/opt/homebrew/bin/gh', '/usr/bin/gh'],
  },
  gitee: {
    label: 'Gitee',
    cli: 'gitee',
    toolId: 'gitee',
    docsUrl: 'https://gitee.com/oschina/gitee-cli',
    loginCommand: 'gitee auth login',
    /** npm 全局安装 → 落点是 npm 的 global bin。Windows 上是 .cmd 垫片。 */
    windowsFallbacks: [],
    posixFallbacks: [],
    npmShimNames: ['gitee.cmd', 'gitee'],
  },
});

/**
 * Windows 上同一个命令可能同时存在多个"文件":
 *   gh.exe(winget/scoop 装的真身) / gh.cmd(npm 垫片) / gh(bash 脚本)
 * npm 在全局 bin 里会同时生成 `gitee`(无扩展名,POSIX sh 脚本)和 `gitee.cmd`,
 * 而 **where.exe 会把无扩展名的那个排在前面**。直接取第一条会在 Windows 上
 * 拿到 bash 脚本,spawn 报 ENOENT,表现为"检测到已安装但版本号是空的"——
 * 一个不会报错、只会静默降级的坑(实测踩到)。所以按扩展名给优先级,
 * 并且最终还要"试跑一次"才算数(见 resolveCli)。
 */
const WIN_EXT_PRIORITY = ['.exe', '.cmd', '.bat'];

function winCandidateScore(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const index = WIN_EXT_PRIORITY.indexOf(ext);
  // 无扩展名(或其它扩展名)排到最后:它在 Windows 上不是可执行文件
  return index >= 0 ? index : WIN_EXT_PRIORITY.length;
}

// ── 可执行文件定位 ───────────────────────────────────────────────────────────

/** 读注册表 HKCU\Environment 的 Path(用户级 PATH)。安装器改的是这里,
 *  而不是当前进程的 process.env.PATH,所以要单独读一次。 */
function readUserPathEntries() {
  if (process.platform !== 'win32') return [];
  const out = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout || '';
  const line = out.split(/\r?\n/).find((l) => /\sPath\s+REG_(?:EXPAND_)?SZ\s+/i.test(l));
  if (!line) return [];
  const raw = line.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/i, '').trim();
  return raw
    .split(';')
    .map((v) => v.trim())
    .filter(Boolean)
    // 用户级 Path 里常见 %USERPROFILE%\... 这类未展开的变量
    .map((v) => v.replace(/%([^%]+)%/g, (_, name) => process.env[name] || ''));
}

/** npm 的全局 bin 目录。`npm prefix -g` 是权威来源,失败时退回 %APPDATA%\npm。 */
function npmGlobalBin() {
  const candidates = [];
  const prefix = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['prefix', '-g'], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout?.trim();
  if (prefix) candidates.push(prefix);
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm'));
  }
  return candidates;
}

async function isFile(p) {
  if (!p) return false;
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * 列出某个 CLI 的**全部**候选可执行文件,已按"能跑起来的可能性"排序。
 * 顺序:
 *   1. where.exe / which 的全部结果(Windows 上按扩展名优先级重排)
 *   2. 注册表用户级 Path 里逐目录拼文件名 —— 装完没重启服务时的关键一步
 *   3. npm 全局 bin(仅声明了 npmShimNames 的 provider)
 *   4. 平台默认落点(Program Files / homebrew / usr-local)
 * 返回空数组表示"没找到"(调用方按"未安装"处理,不是错误)。
 */
export async function listCliExecutables(provider) {
  const config = PROVIDERS[provider];
  if (!config) return [];
  const isWin = process.platform === 'win32';
  const exeNames = isWin ? [`${config.cli}.exe`, `${config.cli}.cmd`, `${config.cli}.bat`, config.cli] : [config.cli];

  const found = [];
  const push = async (candidate) => {
    if (!candidate || found.includes(candidate)) return;
    if (await isFile(candidate)) found.push(candidate);
  };

  // 1. where.exe / which
  const checker = isWin ? 'where.exe' : 'which';
  const where = spawnSync(checker, [config.cli], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0 && where.stdout) {
    const lines = where.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((l) => l && !/^[A-Z_]+=/i.test(l)); // 偶尔混入 "PATH=..." 这类行
    // Windows 上必须重排:where.exe 会把无扩展名的 POSIX 脚本排在 .cmd 前面
    if (isWin) lines.sort((a, b) => winCandidateScore(a) - winCandidateScore(b));
    for (const line of lines) await push(line);
  }

  // 2. 用户级 Path 里的目录
  for (const dir of readUserPathEntries()) {
    for (const name of exeNames) await push(path.join(dir, name));
  }

  // 3. npm 全局 bin(gitee 走 npm 装,垫片名由 provider 声明)
  if (config.npmShimNames) {
    for (const bin of npmGlobalBin()) {
      for (const name of config.npmShimNames) await push(path.join(bin, name));
      // POSIX 上 npm 的垫片在 prefix/bin 下
      if (!isWin) await push(path.join(bin, 'bin', config.cli));
    }
  }

  // 4. 平台默认落点
  const fallbacks = isWin
    ? config.windowsFallbacks
    : [...config.posixFallbacks, path.join(os.homedir(), '.local', 'bin', config.cli)];
  for (const candidate of fallbacks) await push(candidate);

  return found;
}

/**
 * 解析出真正可用的那一个 CLI。
 *
 * 光"文件存在"不够:候选里可能有 Windows 上根本执行不了的 POSIX 垫片。
 * 所以逐个试跑 `--version`,第一个能跑通的才算数,顺手把版本号收下
 * (避免为了拿版本再跑第二遍)。全都不行返回 null。
 */
export async function resolveCli(provider) {
  for (const executable of await listCliExecutables(provider)) {
    const probe = await runCli(executable, ['--version'], { timeoutMs: 15000 });
    if (probe.code === 0) {
      return {
        executable,
        version: parseVersionOutput(`${probe.stdout}\n${probe.stderr}`),
      };
    }
    // ENOENT / EACCES = 这个候选不是可执行文件,换下一个;
    // 其它失败(比如 CLI 自己报错)说明命令是跑得起来的,就用它
    if (!/ENOENT|EACCES|EPERM/i.test(probe.stderr)) {
      return { executable, version: parseVersionOutput(`${probe.stdout}\n${probe.stderr}`) };
    }
  }
  return null;
}

/** 便捷包装:只要第一个候选路径(测试与调试用)。生产路径请用 resolveCli。 */
export async function findCliExecutable(provider) {
  const [first] = await listCliExecutables(provider);
  return first || null;
}

// ── CLI 调用 ────────────────────────────────────────────────────────────────

/**
 * 跑一条 CLI 命令并把 stdout 收全。
 *
 * 全程非交互:GH_PROMPT_DISABLED / GIT_TERMINAL_PROMPT=0 保证需要凭据时
 * **快速失败而不是挂住**(挂住会连带前端轮询一起卡死,与 directoryFetch.js
 * 里 fetch 的处理是同一个考虑)。
 * NO_COLOR + GITEE_NO_UPDATE_NOTIFIER:输出要拿来解析,不能混进 ANSI 色码,
 * 也不要让每次调用都去查一次更新。
 *
 * Windows 上 npm 装出来的是 .cmd 垫片,不能直接 spawn,必须过一层 shell
 * (这里的 args 全部是服务端硬编码常量,不含任何用户输入)。
 */
export function runCli(executable, args, { timeoutMs = CLI_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: useShell,
      env: {
        ...process.env,
        NO_COLOR: '1',
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        GITEE_NO_UPDATE_NOTIFIER: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code, stdout, stderr, timedOut: !!timedOut });
    };

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(-1, false);
    });
    child.on('exit', (code) => finish(code, false));
    setTimeout(() => finish(-1, true), timeoutMs);
  });
}

/** 从 CLI 输出里挑一句能给用户看的话(gitee 把错误打在 stdout,gh 打在 stderr) */
function firstMeaningfulLine(...texts) {
  for (const text of texts) {
    if (!text) continue;
    for (const line of String(text).split(/\r?\n/).map((s) => s.trim())) {
      if (line && !/^\s*$/.test(line)) return line;
    }
  }
  return '';
}

/** 宽松 JSON 解析:容忍 CLI 在 JSON 前面打警告/更新提示行。
 *  只定位第一个 `[` 或 `{` 再整体交给 JSON.parse —— 不做任何字符串清洗,
 *  解析不出来就是 null,由调用方决定怎么降级。 */
export function parseJsonLoose(text) {
  if (!text) return null;
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/** 把 CLI 输出解析成仓库数组。允许裸数组 / {repos} / {data} 三种外壳 ——
 *  gh 是裸数组,官方 gitee-cli 实测也是裸数组,多留两条分支是防它换壳。
 *
 *  注意:纯对象(如 `gitee auth status --json` 的 `{"host":…,"status":…}`)
 *  在这里**返回 null**是正确的 —— 它不是仓库列表。要解析任意 JSON 请用
 *  parseJsonLoose,别拿这个函数去解 auth status(踩过:返回 null 导致
 *  登录态解析静默退化成文本匹配,登录后拿不到用户名)。 */
export function parseRepoJson(text) {
  const parsed = parseJsonLoose(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.repos)) return parsed.repos;
  if (parsed && Array.isArray(parsed.data)) return parsed.data;
  return null;
}

/** 从 CLI 返回的 user 字段里取用户名。这个字段在不同实现里可能是字符串,
 *  也可能是个对象(gitee 的 json tag 同时存在 user / login),两种都要认。 */
export function pickUserName(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    for (const key of ['login', 'name', 'username', 'path']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return null;
}

// ── 各平台适配 ──────────────────────────────────────────────────────────────

/**
 * 解释 `gh auth status` 的结果。
 * gh 未登录时**退出码 1**,已登录时 0 —— 这里可以信退出码;
 * 账号名从 "Logged in to github.com account <name> ..." 里抠。
 */
export function interpretGithubAuthStatus(exitCode, output) {
  if (exitCode !== 0) return { authenticated: false, user: null };
  const account = String(output || '').match(/account\s+([A-Za-z0-9-]+)/i);
  return { authenticated: true, user: account ? account[1] : null };
}

/**
 * 解释 `gitee auth status --json` 的结果。
 *
 * **不能看退出码**(实测 v0.3.1:未登录时退出码也是 0),只能解析 status 字段。
 * status 只有 "logged in" / "not logged in" 两个取值:
 * 先排除否定式、再要求确实出现过 logged in —— 这样将来多出别的状态词时,
 * 宁可判成"未登录"(引导用户去登录)也不要谎报已登录(然后 repo list 报错)。
 *
 * 返回 null 表示 JSON 没解析出来,调用方应该退回文本判断。
 */
export function interpretGiteeAuthStatus(stdout) {
  const parsed = parseJsonLoose(stdout);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || typeof parsed.status !== 'string') {
    return null;
  }
  return {
    authenticated: !/not\s+logged\s+in/i.test(parsed.status) && /logged\s+in/i.test(parsed.status),
    user: pickUserName(parsed.user) || pickUserName(parsed.login),
  };
}

/**
 * 检测 CLI 是否已登录 + 当前账号名。版本号由 resolveCli 试跑时带回,不重复跑。
 */
async function detectCli(provider, executable, version) {
  if (provider === 'github') {
    const authRes = await runCli(executable, ['auth', 'status'], { timeoutMs: 15000 });
    const result = interpretGithubAuthStatus(authRes.code, `${authRes.stdout}\n${authRes.stderr}`);
    return { installed: true, version, ...result };
  }

  const authRes = await runCli(executable, ['auth', 'status', '--json'], { timeoutMs: 15000 });
  const fromJson = interpretGiteeAuthStatus(authRes.stdout);
  if (fromJson) return { installed: true, version, ...fromJson };

  // JSON 解析不出来(版本差异)时退回文本判断
  const text = `${authRes.stdout}\n${authRes.stderr}`;
  return {
    installed: true,
    version,
    authenticated: !/not\s+logged\s+in/i.test(text) && /logged\s+in/i.test(text),
    user: null,
  };
}

/** gh repo list 的 --json 字段 → 统一形状 */
export function normalizeGithubRepos(raw) {
  return raw.map((r) => ({
    name: r.name || '',
    fullName: r.nameWithOwner || r.name || '',
    description: r.description || '',
    isPrivate: !!r.isPrivate,
    isFork: !!r.isFork,
    language: r.primaryLanguage?.name || null,
    stars: typeof r.stargazerCount === 'number' ? r.stargazerCount : 0,
    updatedAt: r.updatedAt || null,
    url: r.url || '',
  }));
}

/** gitee repo list --json 的字段 → 统一形状 */
export function normalizeGiteeRepos(raw) {
  return raw.map((r) => ({
    name: r.name || r.path || '',
    fullName: r.full_name || r.human_name || r.name || '',
    description: r.description || '',
    // gitee 同时给了 private 和 public 两个布尔,优先 private,缺失时用 public 反推
    isPrivate: typeof r.private === 'boolean' ? r.private : r.public === false,
    isFork: !!r.fork,
    language: r.language || null,
    stars: typeof r.stargazers_count === 'number' ? r.stargazers_count : 0,
    updatedAt: r.updated_at || null,
    url: r.html_url || (r.full_name ? `https://gitee.com/${r.full_name}` : ''),
  }));
}

/** 拉当前登录账号的仓库列表。失败时返回 { repos: [], error } 而不是抛 —— 
 *  前端要把这句话渲染在面板里,不是一个 500 弹窗。 */
async function listRepos(provider, executable) {
  if (provider === 'github') {
    const res = await runCli(executable, [
      'repo', 'list',
      '--limit', String(GH_LIMIT),
      '--json', 'name,nameWithOwner,description,isPrivate,isFork,primaryLanguage,stargazerCount,updatedAt,url',
    ]);
    if (res.timedOut) return { repos: [], error: 'gh repo list 超时(25 秒),请检查网络或代理设置' };
    const parsed = parseRepoJson(res.stdout);
    if (!parsed) {
      return { repos: [], error: firstMeaningfulLine(res.stderr, res.stdout) || 'gh repo list 没有返回可解析的数据' };
    }
    return { repos: normalizeGithubRepos(parsed), error: null };
  }

  // gitee:官方 CLI 单页最多 100,手动翻页直到不足一页(上限 GITEE_MAX_PAGES)
  const all = [];
  let truncated = false;
  for (let page = 1; page <= GITEE_MAX_PAGES; page += 1) {
    const res = await runCli(executable, [
      'repo', 'list',
      '--limit', String(GITEE_PAGE_SIZE),
      '--page', String(page),
      '--json=full_name,human_name,name,path,description,private,public,fork,language,stargazers_count,updated_at,html_url',
      '--no-tui',
    ]);
    if (res.timedOut) {
      return { repos: all, error: all.length ? null : 'gitee repo list 超时(25 秒),请检查网络设置' };
    }
    const parsed = parseRepoJson(res.stdout);
    if (!parsed) {
      const message = firstMeaningfulLine(res.stdout, res.stderr) || 'gitee repo list 没有返回可解析的数据';
      return { repos: all, error: all.length ? null : message };
    }
    all.push(...normalizeGiteeRepos(parsed));
    if (parsed.length < GITEE_PAGE_SIZE) break;
    if (page === GITEE_MAX_PAGES) truncated = true;
  }
  return { repos: all, error: null, truncated };
}

// ── 路由 ────────────────────────────────────────────────────────────────────

/**
 * 注册远程仓库相关路由:
 *   GET  /api/remote-repos?provider=github|gitee   探测 + 拉列表
 *   POST /api/remote-repos/login                   在新终端里跑登录命令
 *
 * *Impl 参数只为测试留的注入口(与 getToolInstallers 的 hasCommand、
 * fetchLatestVersion 的 fetchImpl 同一套做法):生产调用不传,走真实实现;
 * 单测传假实现就能把"未安装 / 未登录 / 已登录 / 拉取失败"四条分支全跑一遍,
 * 不必真的装 gh、也不必联网。launchLoginImpl 尤其重要 —— 默认实现会**真的
 * 开一个终端窗口**,单测里绝不能跑到它。
 */
export function registerRemoteReposRoutes({
  app,
  resolveCliImpl = resolveCli,
  detectCliImpl = detectCli,
  listReposImpl = listRepos,
  launchLoginImpl = launchCommandInTerminal,
}) {
  /**
   * GET /api/remote-repos?provider=github|gitee
   *
   * 永远回 200(除非 provider 非法):"没装 CLI"和"装了没登录"都是**正常状态**,
   * 前端据此渲染安装引导 / 登录引导,不是错误。只有真正的失败(CLI 报错、
   * 超时、网络不通)才把原因放进 error 字段,由前端就地展示。
   */
  app.get('/api/remote-repos', asyncRoute(async (req, res) => {
    const provider = String(req.query.provider || '').toLowerCase();
    if (!PROVIDERS[provider]) {
      throw new HttpError(400, 'provider 必须是 github 或 gitee');
    }

    const config = PROVIDERS[provider];
    const installer = getToolInstallers()[config.toolId];
    const base = {
      success: true,
      provider,
      cli: config.cli,
      label: config.label,
      platform: process.platform,
      docsUrl: config.docsUrl,
      loginCommand: config.loginCommand,
      installer: installer ? publicInstallerInfo({ [config.toolId]: installer })[config.toolId] : null,
    };

    const resolved = await resolveCliImpl(provider);
    if (!resolved) {
      return res.json({
        ...base,
        installed: false,
        version: null,
        authenticated: false,
        user: null,
        repos: [],
        truncated: false,
        error: null,
      });
    }

    let detected;
    try {
      detected = await detectCliImpl(provider, resolved.executable, resolved.version);
    } catch (error) {
      logger.info(`[remote-repos] ${provider} 检测失败: ${error.message}`);
      return res.json({
        ...base,
        installed: true,
        version: resolved.version,
        authenticated: false,
        user: null,
        repos: [],
        truncated: false,
        error: `检测 ${config.cli} 状态失败: ${error.message}`,
      });
    }

    if (!detected.authenticated) {
      return res.json({
        ...base,
        ...detected,
        repos: [],
        truncated: false,
        error: null,
      });
    }

    const { repos, error, truncated } = await listReposImpl(provider, resolved.executable);
    res.json({
      ...base,
      ...detected,
      repos,
      truncated: !!truncated,
      error: error || null,
    });
  }));

  /**
   * POST /api/remote-repos/login   body: { provider }
   *
   * 在新终端窗口里跑这个平台的登录命令。
   *
   * 为什么只能"开窗口"而不能真代劳：`gh auth login` / `gitee auth login` 都是
   * **交互式**的（选平台、选协议、走浏览器还是粘贴 token），必须有 TTY ——
   * 被 spawn 出去又没有终端，它直接失败，用户屏幕上什么也看不到。
   * 所以这里只把窗口开起来，后面的问答交给 CLI 自己；这也正合"我们不碰 token"
   * 那条原则：凭据由 CLI 自己收、自己存。
   *
   * 安全边界与 /api/install-tool 完全一致：请求体里只有一个 provider 名，
   * 命令取自服务端 PROVIDERS 白名单常量。
   *
   * 为什么要先 resolveCli（早先省掉的这一步是错的，2026-09-22 实测踩到）：
   *   本进程的 `process.env.PATH` 是启动那一刻的快照。用户刚装好 gh 时，
   *   安装器改的是注册表里的 PATH —— 探测能找到 gh（走注册表 + 默认落点），
   *   界面显示"已安装"，但子进程 cmd 按自己的旧 PATH 找，报
   *   `'gh' 不是内部或外部命令`；而用户自己新开一个 cmd 是好的。
   *   所以这里必须解析出 **CLI 所在的目录**，前置进子进程 PATH 一起带下去。
   *   顺带补上了"没装就别开窗口"的校验 —— 报错比空窗口好懂。
   */
  app.post('/api/remote-repos/login', asyncRoute(async (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    if (!PROVIDERS[provider]) {
      throw new HttpError(400, 'provider 必须是 github 或 gitee');
    }

    const config = PROVIDERS[provider];
    const resolved = await resolveCliImpl(provider);
    if (!resolved) {
      throw new HttpError(400, `未检测到 ${config.cli}，请先完成安装`);
    }

    // 只有绝对路径才取目录：单测里的假实现可能只回一个裸命令名 'gh'，
    // 那种情况取出来是 '.'，前置进 PATH 反而添乱。
    const executableDir = resolved.executable && path.isAbsolute(resolved.executable)
      ? path.dirname(resolved.executable)
      : null;

    await launchLoginImpl(config.loginCommand, { pathDirs: [executableDir] });
    res.json({ success: true });
  }));
}
