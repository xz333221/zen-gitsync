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
// 智能体页面的两个「广场」后端:Skill 广场 + MCP 广场。
//
// 设计要点
// ────────
// 1) **按来源分组**。每个来源是一个独立的 provider,有自己的抓取与归一化逻辑;
//    请求时并行 allSettled,单个来源失败只让那一组带上 error,不影响其他组 ——
//    第三方目录站掉线是很常见的事,不能让整页变空。
// 2) **内置精选离线可用**。每个类型的 builtin 组是静态数据,不联网也有内容;
//    联网来源失败时用户至少还能看到它们。内置条目的仓库与 npm 包名都经过实际校验,
//    不是凭印象写的占位数据。
// 3) **两个安装目标**。
//    - project: <cwd>/.claude/skills/<id>/ 与 <cwd>/.mcp.json(项目级,生态通行约定)
//    - global : ~/.zen-gitsync/ai/skills/<id>/ 与 ~/.zen-gitsync/ai/mcp.json
//               (即「g ai 智能体」,对所有项目生效;路径常量在 src/paths.js)
//    路径与 g ai 的读取端(src/cli/ai/skills.js、src/cli/ai/mcp.js)共用同一份常量,
//    改这里不会出现"装了但读不到"。
// 4) 所有来自网络的值在落盘前都要过白名单校验(仓库名 / 包名 / 子路径),
//    因为这些值最终会变成 git clone 与 npm install 的参数 —— 网络数据不可信。
//
// 数据来源(2026-09 实测可用性见每个 provider 的注释)
// ────────────────────────────────────────────────
//   Skill: Anthropic 官方仓库 / SkillsMP / 社区精选合集 / GitHub 搜索 / npm
//   MCP  : MCP 官方注册表 / Smithery / npm / GitHub 搜索
//   不可用:Glama(需 API key)、PulseMCP(v0.1 起需 key,v0beta 已下线)

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asyncRoute, HttpError } from '../../utils/asyncRoute.js';
import { AI_SKILLS_DIR, AI_MCP_FILE } from '../../../../paths.js';

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 12_000;
const CLONE_TIMEOUT_MS = 180_000;
const NPM_TIMEOUT_MS = 180_000;
// 单个来源最多返回多少条 —— 再多用户也不会翻,反而拖慢首屏
const MAX_PER_SOURCE = 24;
// npm 搜索接口的 size 上限设小一点:它的结果噪声比目录站大得多
const MAX_PER_NPM = 20;
// 联网结果的进程内缓存。目录站几乎没有秒级变化,5 分钟足够新鲜。
const CACHE_TTL_MS = 5 * 60_000;

// ── 校验白名单 ────────────────────────────────────────────────
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/;
const SAFE_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const SAFE_REPOSITORY = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
// 仓库内子路径:禁止绝对路径与任何 .. 片段
const SAFE_SUBPATH = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._\-/]{1,200}$/;

// ── 来源定义 ──────────────────────────────────────────────────
// kind: 'builtin' 静态数据 | 'live' 联网抓取
// live 的来源都会经过 provider 函数,失败时只影响本组。

const SKILL_SOURCES = [
  { id: 'builtin', label: '内置精选', kind: 'builtin', homepage: 'https://github.com/anthropics/skills' },
  { id: 'official', label: 'Anthropic 官方仓库', kind: 'live', homepage: 'https://github.com/anthropics/skills' },
  { id: 'skillsmp', label: 'SkillsMP', kind: 'live', homepage: 'https://skillsmp.com' },
  { id: 'awesome', label: '社区精选合集', kind: 'live', homepage: 'https://github.com/ComposioHQ/awesome-claude-skills' },
  { id: 'github', label: 'GitHub 搜索', kind: 'live', homepage: 'https://github.com/search?q=claude+skill' },
  { id: 'npm', label: 'npm', kind: 'live', homepage: 'https://www.npmjs.com/search?q=claude%20skill' },
];

const MCP_SOURCES = [
  { id: 'builtin', label: '内置精选', kind: 'builtin', homepage: 'https://github.com/modelcontextprotocol/servers' },
  { id: 'registry', label: 'MCP 官方注册表', kind: 'live', homepage: 'https://registry.modelcontextprotocol.io' },
  { id: 'smithery', label: 'Smithery', kind: 'live', homepage: 'https://smithery.ai' },
  { id: 'npm', label: 'npm', kind: 'live', homepage: 'https://www.npmjs.com/search?q=mcp-server' },
  { id: 'github', label: 'GitHub 搜索', kind: 'live', homepage: 'https://github.com/search?q=mcp-server' },
];

// ── 内置精选(离线可用,仓库/包名均已核验) ────────────────────
// Anthropic 官方仓库的 skills/ 目录下实际存在这些子目录。
const ANTHROPIC_SKILLS = [
  ['docx', '生成与编辑 Word 文档:修订、批注、样式与格式。'],
  ['pdf', '提取文本与表格、合并拆分、批注 PDF。'],
  ['pptx', '读取、生成与调整幻灯片版式与模板。'],
  ['xlsx', '电子表格处理:公式、图表、数据变换。'],
  ['skill-creator', '把一套可复用的工作流写成标准 SKILL.md(造 skill 的 skill)。'],
  ['mcp-builder', '按规范实现一个 MCP 服务器。'],
  ['webapp-testing', '用 Playwright 驱动浏览器,自动化测试本地 Web 应用。'],
  ['frontend-design', '做出视觉系统完整、可访问性达标的前端界面。'],
  ['canvas-design', '画布/图形类设计产出。'],
  ['doc-coauthoring', '与用户协作撰写长文档。'],
  ['algorithmic-art', '程序化生成艺术图形。'],
  ['brand-guidelines', '把品牌规范落到具体产出上。'],
];

// superpowers 是社区里最成体系的 skill 库(skills/ 目录下逐个可独立安装)
const SUPERPOWERS_SKILLS = [
  ['systematic-debugging', '结构化的缺陷定位流程:先找根因再提修复。'],
  ['test-driven-development', 'TDD 循环:先写失败测试,再实现。'],
  ['writing-plans', '把需求拆成可执行的实施计划。'],
  ['requesting-code-review', '发起代码评审时的组织与自检清单。'],
  ['verification-before-completion', '交付前的验证清单:证据驱动,不靠"应该没问题"。'],
];

const BUILTIN_SKILLS = [
  ...ANTHROPIC_SKILLS.map(([name, description]) => ({
    id: `anthropic-${name}`,
    name,
    description,
    repository: 'anthropics/skills',
    subpath: `skills/${name}`,
    upstream: `https://github.com/anthropics/skills/tree/main/skills/${name}`,
    tags: ['official'],
  })),
  ...SUPERPOWERS_SKILLS.map(([name, description]) => ({
    id: `superpowers-${name}`,
    name,
    description,
    repository: 'obra/superpowers',
    subpath: `skills/${name}`,
    upstream: `https://github.com/obra/superpowers/tree/main/skills/${name}`,
    tags: ['community', 'workflow'],
  })),
];

const BUILTIN_MCPS = [
  {
    id: 'mcp-filesystem',
    name: 'Filesystem',
    description: '在显式授权的目录里读写文件。',
    package: '@modelcontextprotocol/server-filesystem',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '${project}'],
    upstream: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    tags: ['official', 'files'],
  },
  {
    id: 'mcp-memory',
    name: 'Memory',
    description: '基于知识图谱的长期记忆,跨会话记住事实与关系。',
    package: '@modelcontextprotocol/server-memory',
    upstream: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    tags: ['official', 'memory'],
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking',
    description: '把复杂问题拆成可修订的连续思考步骤。',
    package: '@modelcontextprotocol/server-sequential-thinking',
    upstream: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    tags: ['official', 'reasoning'],
  },
  {
    id: 'mcp-everything',
    name: 'Everything (示例服务器)',
    description: '官方参考实现,涵盖 prompts/resources/tools 全套能力,适合验证链路。',
    package: '@modelcontextprotocol/server-everything',
    upstream: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    tags: ['official', 'reference'],
  },
  {
    id: 'mcp-github',
    name: 'GitHub',
    description: '操作仓库、Issue、Pull Request 与代码搜索。',
    package: '@modelcontextprotocol/server-github',
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    upstream: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    tags: ['official', 'github'],
  },
  {
    id: 'mcp-context7',
    name: 'Context7',
    description: '拉取任意库的最新版文档与代码示例,避免模型凭记忆写过期 API。',
    package: '@upstash/context7-mcp',
    upstream: 'https://github.com/upstash/context7',
    tags: ['docs', 'popular'],
  },
  {
    id: 'mcp-playwright',
    name: 'Playwright',
    description: '浏览器自动化:打开页面、点击、截图、取 DOM。',
    package: '@playwright/mcp',
    upstream: 'https://github.com/microsoft/playwright-mcp',
    tags: ['browser', 'popular'],
  },
  {
    id: 'mcp-chrome-devtools',
    name: 'Chrome DevTools',
    description: '直接操作真实 Chrome:性能轨迹、网络、控制台。',
    package: 'chrome-devtools-mcp',
    upstream: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    tags: ['browser'],
  },
];

// ── 工具函数 ──────────────────────────────────────────────────

function normalizeType(value) {
  return value === 'mcp' ? 'mcp' : value === 'skill' ? 'skill' : '';
}

function sourcesFor(type) {
  return type === 'mcp' ? MCP_SOURCES : SKILL_SOURCES;
}

function safeId(value) {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return id.slice(0, 80) || 'extension';
}

function clampText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isSafeSubpath(value) {
  return SAFE_SUBPATH.test(String(value || ''));
}

function resolveProjectPath(value, fallback) {
  const raw = String(value || fallback || '').trim();
  if (!raw) throw new HttpError(400, '项目路径不能为空');
  return path.resolve(raw);
}

async function assertDirectory(cwd) {
  const stat = await fs.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) throw new HttpError(400, `项目目录不存在: ${cwd}`);
  return cwd;
}

function githubHeaders() {
  // 未认证的 GitHub API 是 60 次/小时(按 IP),搜索接口更紧。
  // 让用户可以用 GH_TOKEN / GITHUB_TOKEN 提额,没配也能用,只是更早限流。
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'zen-gitsync-agent-marketplace' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'zen-gitsync-agent-marketplace', ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'zen-gitsync-agent-marketplace', ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

// ── 缓存 ──────────────────────────────────────────────────────
/** @type {Map<string, { expires: number, value: unknown }>} */
const cache = new Map();

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  // 失败不写缓存:目录站偶发抖动时,下一次搜索应该立刻重试而不是等 TTL
  const value = await loader();
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

// ── provider: Skill ───────────────────────────────────────────

// builtin:纯静态,不联网
function builtinSkills() {
  return BUILTIN_SKILLS.map(item => ({ ...item, type: 'skill' }));
}

// Anthropic 官方仓库:用 GitHub contents API 列出 skills/ 下的目录。
// 这是所有 skill 的"源头",目录结构稳定(path = skills/<name>)。
// contents API 不返回描述,所以用内置表里的描述补上(两边都以目录名为键),
// 补不到的条目在前端只显示名字,不会假装有描述。
async function officialSkills() {
  const data = await fetchJson('https://api.github.com/repos/anthropics/skills/contents/skills', { headers: githubHeaders() });
  if (!Array.isArray(data)) throw new Error('GitHub 返回结构异常');
  const described = new Map(ANTHROPIC_SKILLS);
  return data
    .filter(entry => entry?.type === 'dir' && SAFE_ID.test(entry.name))
    .map(entry => ({
      id: `anthropic-${entry.name}`,
      type: 'skill',
      name: entry.name,
      description: described.get(entry.name) || '',
      repository: 'anthropics/skills',
      subpath: `skills/${entry.name}`,
      upstream: entry.html_url,
      tags: ['official'],
    }));
}

// SkillsMP:第三方 skill 目录站,给的是 owner/repo + 仓库内路径,可直接安装。
async function skillsmpSkills(query) {
  const params = new URLSearchParams({ limit: String(MAX_PER_SOURCE) });
  // 只在有关键词时才带 search 参数 —— 传空的 search= 会被它当非法请求打回 400(实测)
  if (query) params.set('search', query);
  const data = await fetchJson(`https://skillsmp.com/api/skills?${params}`);
  const list = Array.isArray(data?.skills) ? data.skills : [];
  return list.map(item => {
    const repository = [item.route?.ownerSlug, item.route?.repoSlug].filter(Boolean).join('/');
    if (!SAFE_REPOSITORY.test(repository)) return null;
    // sourceSkillPath 形如 .agents/skills/agent-transcript/SKILL.md —— 取它所在的目录
    const sourcePath = String(item.route?.sourceSkillPath || item.path || '');
    const subpath = sourcePath.replace(/\/?SKILL\.md$/i, '');
    return {
      id: `skillsmp-${safeId(item.id || `${repository}-${item.name}`)}`,
      type: 'skill',
      name: clampText(item.name, 80),
      description: clampText(item.description, 400),
      author: item.author || '',
      repository,
      subpath: subpath && isSafeSubpath(subpath) ? subpath : '',
      branch: item.branch || '',
      stars: Number(item.stars) || 0,
      upstream: item.githubUrl || `https://github.com/${repository}`,
      tags: ['skillsmp'],
    };
  }).filter(Boolean);
}

// 社区精选合集:README 是标准的 "### 分类" + "- [名字](链接) - 描述" 结构。
// 链接可能是 github 仓库/子目录,也可能是站点首页 —— 后者不可安装,只展示。
async function awesomeSkills(query) {
  const readme = await fetchText('https://api.github.com/repos/ComposioHQ/awesome-claude-skills/readme', {
    headers: { ...githubHeaders(), Accept: 'application/vnd.github.raw' },
  });
  const q = String(query || '').toLowerCase();
  const items = [];
  let category = '';
  const lines = readme.split(/\r?\n/);

  for (const line of lines) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) { category = heading[1].trim(); continue; }
    const entry = /^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*(?:[-–—]\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const [, rawName, rawUrl, rawDescription = ''] = entry;
    // 跳过目录(TOC)条目:它们指向页内锚点
    if (rawUrl.startsWith('#')) continue;

    const name = clampText(rawName, 80);
    const description = clampText(rawDescription.replace(/\*By \[[^\]]*\]\([^)]*\)\*/g, ''), 400);
    if (q && !`${name} ${description} ${category}`.toLowerCase().includes(q)) continue;

    const target = resolveSkillTarget(rawUrl);
    if (!target) continue;
    items.push({
      id: `awesome-${safeId(`${target.repository}-${target.subpath || 'root'}`)}`,
      type: 'skill',
      name,
      description: description || category,
      repository: target.repository,
      subpath: target.subpath,
      upstream: target.upstream,
      tags: [category].filter(Boolean),
    });
    if (items.length >= MAX_PER_SOURCE) break;
  }
  return items;
}

// 把合集里的链接翻译成「仓库 + 仓库内子路径」。不认识的形状返回 null。
function resolveSkillTarget(rawUrl) {
  const url = String(rawUrl || '').trim();

  // 相对路径 → 相对该合集仓库自身(合集里也有自带 skill)
  if (url.startsWith('./') || url.startsWith('../')) {
    const subpath = url.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!isSafeSubpath(subpath)) return null;
    return { repository: 'ComposioHQ/awesome-claude-skills', subpath, upstream: `https://github.com/ComposioHQ/awesome-claude-skills/tree/main/${subpath}` };
  }

  const github = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)\/(.+?))?\/?$/.exec(url);
  if (!github) return null;
  const repository = `${github[1]}/${github[2]}`;
  if (!SAFE_REPOSITORY.test(repository)) return null;
  let subpath = (github[4] || '').replace(/\/?SKILL\.md$/i, '').replace(/\/+$/, '');
  if (subpath && !isSafeSubpath(subpath)) subpath = '';
  return { repository, subpath, upstream: url };
}

// GitHub 仓库搜索:补集用,搜"skill 集合型仓库"。
async function githubSkills(query) {
  return searchGithubRepositories({ query, suffix: 'claude skill', type: 'skill' });
}

async function githubMcps(query) {
  return searchGithubRepositories({ query, suffix: 'mcp server', type: 'mcp' });
}

async function searchGithubRepositories({ query, suffix, type }) {
  const q = encodeURIComponent(`${query} ${suffix}`.trim());
  const data = await fetchJson(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${MAX_PER_SOURCE}`, { headers: githubHeaders() });
  const list = Array.isArray(data?.items) ? data.items : [];
  return list.map(item => {
    const fullName = String(item.full_name || '');
    if (!SAFE_REPOSITORY.test(fullName)) return null;
    return {
      id: `github-${safeId(fullName)}`,
      type,
      name: clampText(item.name || fullName, 80),
      description: clampText(item.description || 'GitHub repository', 400),
      repository: fullName,
      subpath: '',
      stars: Number(item.stargazers_count) || 0,
      upstream: item.html_url || `https://github.com/${fullName}`,
      tags: Array.isArray(item.topics) ? item.topics.slice(0, 5) : [],
    };
  }).filter(Boolean);
}

// npm:skill 这个品类在 npm 上没有规范约定,搜出来噪声很大,
// 所以只在用户真的输入了关键词时才查。
async function npmSkills(query) {
  if (!query) return [];
  const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${query} claude skill`)}&size=${MAX_PER_NPM}`);
  return normalizeNpmSearch(data, 'skill');
}

function normalizeNpmSearch(data, type) {
  const objects = Array.isArray(data?.objects) ? data.objects : [];
  return objects.map(entry => {
    const name = String(entry?.package?.name || '').trim();
    if (!name || !SAFE_PACKAGE.test(name)) return null;
    return {
      id: `npm-${safeId(name.replace(/^@/, '').replace('/', '-'))}`,
      type,
      name: clampText(entry.package.name, 80),
      description: clampText(entry.package.description || 'npm package', 400),
      package: name,
      repository: '',
      upstream: entry.package?.links?.npm || `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
      downloads: Number(entry.downloads?.weekly) || 0,
      tags: ['npm'],
    };
  }).filter(Boolean);
}

// ── provider: MCP ─────────────────────────────────────────────

function builtinMcps() {
  return BUILTIN_MCPS.map(item => ({ ...item, type: 'mcp', command: 'npx' }));
}

// MCP 官方注册表:canonical 数据源,直接给出 npm identifier 与所需环境变量,
// 是"能一键装"比例最高的来源。version=latest 过滤掉历史版本(否则同一个 server
// 会返回几十条)。
async function registryMcps(query) {
  const params = new URLSearchParams({ version: 'latest', limit: String(MAX_PER_SOURCE) });
  if (query) params.set('search', query);
  const data = await fetchJson(`https://registry.modelcontextprotocol.io/v0.1/servers?${params}`);
  const list = Array.isArray(data?.servers) ? data.servers : [];

  return list.map(entry => {
    const server = entry?.server;
    if (!server) return null;
    const displayName = server.title || String(server.name || '').split('/').pop() || server.name;
    // 优先取 npm 包(能直接 npx 起来);其余(pypi/nuget/oci)标记为不可一键安装
    const npmPackage = (server.packages || []).find(pkg => pkg?.registryType === 'npm' && SAFE_PACKAGE.test(String(pkg.identifier || '')));
    const remote = (server.remotes || [])[0]?.url;
    const env = npmPackage?.environmentVariables || [];
    const requiredEnv = env.filter(item => item?.isRequired).map(item => String(item.name || '')).filter(Boolean);

    const args = npmPackage
      ? ['-y', String(npmPackage.identifier), ...(npmPackage.runtimeArguments || []).map(arg => String(arg.value ?? ''))]
      : null;

    return {
      id: `registry-${safeId(String(server.name || displayName))}`,
      type: 'mcp',
      name: clampText(displayName, 80),
      description: clampText(server.description, 400),
      publisher: String(server.name || '').split('/')[0] || '',
      version: server.version || '',
      package: npmPackage ? String(npmPackage.identifier) : '',
      command: npmPackage ? 'npx' : '',
      args,
      envKeys: requiredEnv,
      // 只给了 remote 端点的 server:官方 stdio 客户端连不上,
      // 前端据此显示"需远程桥接"而不是给一个会失败的安装按钮。
      transport: npmPackage ? 'stdio' : (remote ? 'remote' : 'unknown'),
      remoteUrl: remote || '',
      repository: String(server.repository?.url || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
      upstream: server.repository?.url || `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(server.name || '')}`,
      tags: ['registry'],
    };
  }).filter(Boolean);
}

// Smithery:偏"托管 + 一键接入"的目录站,自带 verified / useCount 等信号。
async function smitheryMcps(query) {
  const params = new URLSearchParams({ pageSize: String(MAX_PER_SOURCE) });
  if (query) params.set('q', query);
  const data = await fetchJson(`https://registry.smithery.ai/servers?${params}`);
  const list = Array.isArray(data?.servers) ? data.servers : [];
  return list.filter(item => item && !item.unlisted && !item.inactive).map(item => {
    const qualified = String(item.qualifiedName || item.displayName || '').trim();
    return {
      id: `smithery-${safeId(item.id || qualified)}`,
      type: 'mcp',
      name: clampText(item.displayName || qualified, 80),
      description: clampText(item.description, 400),
      publisher: item.namespace || '',
      package: '',
      command: '',
      args: null,
      envKeys: [],
      // Smithery 上大量 server 是托管型(remote + isDeployed),没有本地 npm 包
      transport: item.remote ? 'remote' : 'unknown',
      remoteUrl: item.homepage || 'https://smithery.ai',
      verified: !!item.verified,
      uses: Number(item.useCount) || 0,
      upstream: item.homepage || `https://smithery.ai/server/${encodeURIComponent(qualified)}`,
      tags: ['smithery'],
    };
  });
}

// npm:按 keywords 筛,比自由文本准得多
async function npmMcps(query) {
  const text = query ? `${query} mcp-server` : 'keywords:mcp-server';
  const data = await fetchJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${MAX_PER_NPM}`);
  return normalizeNpmSearch(data, 'mcp').map(item => ({
    ...item,
    command: 'npx',
    args: ['-y', item.package],
    transport: 'stdio',
    envKeys: [],
  }));
}

// ── 分组建构 ──────────────────────────────────────────────────

const PROVIDERS = {
  skill: {
    builtin: () => builtinSkills(),
    official: () => officialSkills(),
    skillsmp: ({ query }) => skillsmpSkills(query),
    awesome: ({ query }) => awesomeSkills(query),
    github: ({ query }) => (query ? githubSkills(query) : Promise.resolve([])),
    npm: ({ query }) => npmSkills(query),
  },
  mcp: {
    builtin: () => builtinMcps(),
    registry: ({ query }) => registryMcps(query),
    smithery: ({ query }) => smitheryMcps(query),
    npm: ({ query }) => npmMcps(query),
    github: ({ query }) => (query ? githubMcps(query) : Promise.resolve([])),
  },
};

function cacheKey(type, source, query) {
  return `${type}|${source}|${String(query || '').toLowerCase()}`;
}

/**
 * 并行抓取所有来源,按来源分组返回。
 * 单个来源失败 → 该组 status='error' 并带上可读原因,其他组不受影响。
 *
 * @param {{ type: string, query?: string, sources?: string[] }} options
 */
async function buildGroups({ type, query = '', sources } = {}) {
  const definitions = sourcesFor(type).filter(source => !sources || sources.includes(source.id));
  const providers = PROVIDERS[type];

  const settled = await Promise.all(definitions.map(async definition => {
    const provider = providers[definition.id];
    if (!provider) {
      return { ...definition, status: 'error', error: '未实现的来源', items: [] };
    }
    try {
      const items = await cached(cacheKey(type, definition.id, query), () => provider({ query }));
      const limited = (Array.isArray(items) ? items : []).slice(0, MAX_PER_SOURCE);
      return { ...definition, status: 'ok', items: limited, count: limited.length };
    } catch (err) {
      const message = err?.name === 'AbortError' ? '请求超时' : String(err?.message || err);
      return { ...definition, status: 'error', error: message, items: [], count: 0 };
    }
  }));

  return settled;
}

// ── 安装目标 ──────────────────────────────────────────────────

function normalizeTarget(value) {
  return value === 'global' ? 'global' : 'project';
}

/**
 * 把 target + type 翻译成落盘位置。
 * 项目级与全局级的 skill 目录形状刻意保持一致,读取端才能共用一套解析逻辑。
 */
function targetPaths({ type, target, cwd }) {
  if (target === 'global') {
    return type === 'skill'
      ? { root: AI_SKILLS_DIR, file: '', label: 'g ai 智能体' }
      : { root: '', file: AI_MCP_FILE, label: 'g ai 智能体' };
  }
  return type === 'skill'
    ? { root: path.join(cwd, '.claude', 'skills'), file: '', label: path.basename(cwd) || cwd }
    : { root: '', file: path.join(cwd, '.mcp.json'), label: path.basename(cwd) || cwd };
}

// ── 已安装扫描 ────────────────────────────────────────────────

function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const attrs = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line);
    if (kv) attrs[kv[1].toLowerCase()] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return attrs;
}

async function installedSkillsIn(root, target) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    const attrs = parseFrontmatter(raw);
    items.push({
      id: entry.name,
      type: 'skill',
      name: clampText(attrs.name || entry.name, 80),
      description: clampText(attrs.description || '', 400),
      dir: path.join(root, entry.name),
      target,
      installed: true,
    });
  }
  return items;
}

async function readMcpFile(file) {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) return { mcpServers: {} };
  try {
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    return { ...parsed, mcpServers: servers && typeof servers === 'object' ? servers : {} };
  } catch {
    return { mcpServers: {} };
  }
}

async function installedMcpsIn(file, target) {
  const config = await readMcpFile(file);
  return Object.entries(config.mcpServers).map(([id, server]) => ({
    id,
    type: 'mcp',
    name: clampText(server?.name || id, 80),
    description: clampText(server?.description || '', 400),
    package: server?.package || '',
    command: server?.command || '',
    args: Array.isArray(server?.args) ? server.args : [],
    envKeys: Object.keys(server?.env || {}),
    file,
    target,
    installed: true,
  }));
}

/** 同时列出项目级与全局级已安装项。/cwd 不可用时只列全局。 */
async function listInstalled({ type, cwd }) {
  const items = [];
  if (type === 'skill') {
    if (cwd) items.push(...await installedSkillsIn(path.join(cwd, '.claude', 'skills'), 'project'));
    items.push(...await installedSkillsIn(AI_SKILLS_DIR, 'global'));
  } else {
    if (cwd) items.push(...await installedMcpsIn(path.join(cwd, '.mcp.json'), 'project'));
    items.push(...await installedMcpsIn(AI_MCP_FILE, 'global'));
  }
  return items;
}

// ── 安装 ──────────────────────────────────────────────────────

async function exists(target) {
  return await fs.stat(target).then(() => true).catch(() => false);
}

function gitBinary() {
  return process.platform === 'win32' ? 'git.exe' : 'git';
}

function npmBinary() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/**
 * 只拉取仓库里的某个子目录。
 * 用 --filter=blob:none --sparse 是为了对付 monorepo ——
 * 直接 --depth 1 全量克隆一个几万文件的仓库只为拿一个 skill 太浪费。
 * sparse 不被支持(旧版 git / 服务端限制)时回落到普通浅克隆。
 */
async function cloneSubdirectory({ repository, subpath, dest }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-gitsync-skill-'));
  const url = `https://github.com/${repository}.git`;
  try {
    let sparseOk = false;
    if (subpath) {
      try {
        await execFileAsync(gitBinary(), ['clone', '--depth', '1', '--filter=blob:none', '--sparse', url, temp], {
          timeout: CLONE_TIMEOUT_MS, windowsHide: true,
        });
        await execFileAsync(gitBinary(), ['-C', temp, 'sparse-checkout', 'set', subpath], {
          timeout: CLONE_TIMEOUT_MS, windowsHide: true,
        });
        sparseOk = true;
      } catch {
        // 目录里可能已经有半成品,清掉重来
        await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(temp, { recursive: true });
      }
    }
    if (!sparseOk) {
      await execFileAsync(gitBinary(), ['clone', '--depth', '1', url, temp], { timeout: CLONE_TIMEOUT_MS, windowsHide: true });
    }

    const requested = subpath ? path.join(temp, subpath) : '';
    const candidates = [requested, path.join(temp, 'skills'), temp].filter(Boolean);
    let source = null;
    for (const candidate of candidates) {
      if (await exists(path.join(candidate, 'SKILL.md'))) { source = candidate; break; }
    }
    // 再退一步:找仓库里任意一层含 SKILL.md 的目录(只扫两层,避免在 monorepo 里乱窜)
    if (!source) {
      const top = await fs.readdir(temp, { withFileTypes: true }).catch(() => []);
      for (const dir of top.filter(entry => entry.isDirectory() && entry.name !== '.git')) {
        if (await exists(path.join(temp, dir.name, 'SKILL.md'))) { source = path.join(temp, dir.name); break; }
        const inner = await fs.readdir(path.join(temp, dir.name), { withFileTypes: true }).catch(() => []);
        let hit = null;
        for (const sub of inner.filter(entry => entry.isDirectory())) {
          if (await exists(path.join(temp, dir.name, sub.name, 'SKILL.md'))) { hit = path.join(temp, dir.name, sub.name); break; }
        }
        if (hit) { source = hit; break; }
      }
    }
    if (!source) throw new HttpError(422, `仓库 ${repository} 里没有找到 SKILL.md`);

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(source, dest, { recursive: true, force: false });
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

async function installSkill({ item, target, cwd }) {
  const paths = targetPaths({ type: 'skill', target, cwd });
  const id = safeId(item.id || item.name);
  if (!SAFE_ID.test(id)) throw new HttpError(400, 'Skill 名称不合法');
  const dest = path.join(paths.root, id);
  if (await exists(dest)) throw new HttpError(409, `该 Skill 已安装在${paths.label}(目录已存在)`);

  // 来源一:GitHub 仓库(可选子目录)+ 仓库根还有 SKILL.md 的简单仓库
  const repository = String(item.repository || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '');
  if (repository && SAFE_REPOSITORY.test(repository)) {
    const subpath = item.subpath && isSafeSubpath(item.subpath) ? String(item.subpath) : '';
    await cloneSubdirectory({ repository, subpath, dest });
    return { id, type: 'skill', name: item.name || id, target, dir: dest, source: repository };
  }

  // 来源二:直接给一份 SKILL.md 正文(前端"粘贴导入"用)
  if (typeof item.content === 'string' && item.content.trim()) {
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, 'SKILL.md'), item.content, 'utf8');
    return { id, type: 'skill', name: item.name || id, target, dir: dest, source: 'inline' };
  }

  throw new HttpError(400, '该条目没有可安装的仓库地址');
}

async function installMcp({ item, target, cwd }) {
  const packageName = String(item.package || '').trim();
  const isStdio = !!packageName;
  // 只有 remote 端点的 server:用 mcp-remote 桥接成 stdio,
  // 否则 g ai 的 stdio 客户端根本连不上。这是生态里的通行做法。
  const bridge = !isStdio && item.remoteUrl ? 'mcp-remote' : '';

  if (!isStdio && !bridge) {
    throw new HttpError(422, '该 MCP 服务没有提供 npm 包或远程端点,暂时无法一键安装');
  }
  if (isStdio && !SAFE_PACKAGE.test(packageName)) throw new HttpError(400, 'MCP npm 包名不合法');

  const paths = targetPaths({ type: 'mcp', target, cwd });
  const id = safeId(item.id || packageName || item.name);
  if (!SAFE_ID.test(id)) throw new HttpError(400, 'MCP 标识不合法');

  const config = await readMcpFile(paths.file);
  if (Object.prototype.hasOwnProperty.call(config.mcpServers, id)) {
    throw new HttpError(409, `该 MCP 服务已安装在${paths.label}`);
  }

  // 项目级顺手 npm install 一次:把版本钉进 package.json,启动也更快。
  // 失败不阻断 —— npx 运行时仍会按需下载,只是慢一点。
  //
  // 全局目标**故意不做**预装:g ai 起的 MCP 子进程 cwd 是当前项目,
  // 装到 ~/.zen-gitsync/ai/node_modules 里 npx 根本解析不到,等于白装一份;
  // npx 自己的缓存本来就是按用户全局共享的,首次启动下载一次即可。
  let installWarning = '';
  const primary = isStdio ? packageName : bridge;
  if (target === 'project') {
    try {
      await execFileAsync(npmBinary(), ['install', '--save-dev', primary], { cwd, timeout: NPM_TIMEOUT_MS, windowsHide: true });
    } catch (err) {
      installWarning = `npm install 未成功(${clampText(err.message, 200)}),已写入配置,首次启动时会由 npx 按需下载`;
    }
  }

  const args = isStdio
    ? (Array.isArray(item.args) && item.args.length ? item.args : ['-y', packageName])
    : ['-y', bridge, String(item.remoteUrl)];
  const replaceProject = value => String(value).replaceAll('${project}', cwd || process.cwd());

  // 安装时顺手收集环境变量(弹窗里用户填的)。只收合法的标识符键,
  // 值为空的键跳过 —— 留给用户以后手改配置文件,而不是写一个空值进去让 server 起不来。
  const env = {};
  if (item.env && typeof item.env === 'object') {
    for (const [key, value] of Object.entries(item.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) continue;
      const text = String(value ?? '').trim();
      if (text) env[key] = clampText(text, 2000);
    }
  }
  // 还缺哪些必填环境变量,记下来给 UI 提示"装好了但还差配置"
  const missingEnv = (Array.isArray(item.envKeys) ? item.envKeys : []).filter(key => !env[key]);

  config.mcpServers[id] = {
    name: item.name || id,
    description: clampText(item.description || '', 400),
    command: 'npx',
    args: args.map(replaceProject),
    env,
    // 记下来给 UI 提示"这个 server 需要哪些环境变量",也便于卸载时回溯
    requiredEnv: missingEnv,
    package: isStdio ? packageName : bridge,
    ...(item.transport === 'remote' ? { transport: 'remote', remoteUrl: item.remoteUrl } : {}),
  };

  await fs.mkdir(path.dirname(paths.file), { recursive: true });
  await fs.writeFile(paths.file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { id, type: 'mcp', name: item.name || id, target, file: paths.file, envKeys: missingEnv, warning: installWarning };
}

async function uninstall({ type, id, target, cwd }) {
  if (!SAFE_ID.test(id)) throw new HttpError(400, '参数不合法');
  const paths = targetPaths({ type, target, cwd });
  if (type === 'skill') {
    const root = path.resolve(paths.root);
    const victim = path.resolve(root, id);
    // 双重防线:即便前面的白名单被绕过,也不允许删到目录树外面
    if (!victim.startsWith(`${root}${path.sep}`)) throw new HttpError(400, '路径不合法');
    if (!(await exists(victim))) throw new HttpError(404, '该 Skill 未安装');
    await fs.rm(victim, { recursive: true, force: true });
    return { id, type, target };
  }

  const config = await readMcpFile(paths.file);
  if (!Object.prototype.hasOwnProperty.call(config.mcpServers, id)) throw new HttpError(404, '该 MCP 服务未安装');
  delete config.mcpServers[id];
  await fs.writeFile(paths.file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { id, type, target };
}

// ── 路由注册 ──────────────────────────────────────────────────

export function registerAgentMarketplaceRoutes({ app, getCurrentProjectPath }) {
  // 来源清单(前端用来渲染筛选器,不依赖具体抓取结果)
  app.get('/api/agent/marketplace/sources', asyncRoute(async (req, res) => {
    const type = normalizeType(req.query?.type);
    if (!type) throw new HttpError(400, '未知扩展类型');
    res.json({
      success: true,
      type,
      sources: sourcesFor(type).map(({ id, label, kind, homepage }) => ({ id, label, kind, homepage })),
    });
  }));

  // 广场主接口:按来源分组返回可安装条目
  app.get('/api/agent/marketplace/catalog', asyncRoute(async (req, res) => {
    const type = normalizeType(req.query?.type);
    if (!type) throw new HttpError(400, '未知扩展类型');
    const query = String(req.query?.q || '').trim().slice(0, 120);
    const requested = String(req.query?.sources || '').split(',').map(part => part.trim()).filter(Boolean);
    const known = new Set(sourcesFor(type).map(source => source.id));
    const sources = requested.filter(id => known.has(id));

    const cwd = resolveProjectPath(req.query?.cwd, getCurrentProjectPath?.());
    const [groups, installed] = await Promise.all([
      buildGroups({ type, query, sources: sources.length ? sources : undefined }),
      listInstalled({ type, cwd }).catch(() => []),
    ]);

    // 已安装标记:同 id 或(package + target)命中
    const installedKeys = new Set(installed.map(item => `${item.target}:${item.id}`));
    const installedPackages = new Set(installed.map(item => item.package).filter(Boolean));
    for (const group of groups) {
      for (const item of group.items) {
        item.installed = installedPackages.has(item.package)
          || installedKeys.has(`project:${safeId(item.id)}`)
          || installedKeys.has(`global:${safeId(item.id)}`);
        item.installable = type === 'skill'
          ? !!(item.repository || item.content)
          : !!(item.package || item.remoteUrl);
      }
    }

    res.json({ success: true, type, query, cwd, groups, installed });
  }));

  app.get('/api/agent/marketplace/installed', asyncRoute(async (req, res) => {
    const type = normalizeType(req.query?.type);
    if (!type) throw new HttpError(400, '未知扩展类型');
    const cwd = resolveProjectPath(req.query?.cwd, getCurrentProjectPath?.());
    const items = await listInstalled({ type, cwd });
    res.json({ success: true, type, cwd, items });
  }));

  app.post('/api/agent/marketplace/install', asyncRoute(async (req, res) => {
    const type = normalizeType(req.body?.type);
    if (!type) throw new HttpError(400, '未知扩展类型');
    const target = normalizeTarget(req.body?.target);
    const cwd = resolveProjectPath(req.body?.cwd, getCurrentProjectPath?.());
    const item = req.body?.item && typeof req.body.item === 'object' ? req.body.item : {};
    if (!item.id && !item.name && !item.package) throw new HttpError(400, '缺少要安装的条目');

    // 项目级安装必须落在真实存在的项目目录里;全局级只需要数据目录可写
    if (target === 'project') await assertDirectory(cwd);

    const installed = type === 'skill'
      ? await installSkill({ item, target, cwd })
      : await installMcp({ item, target, cwd });

    // 装完立刻让缓存失效,避免刚装的条目在列表里还是"未安装"
    cache.clear();
    res.json({ success: true, target, cwd, item: installed });
  }));

  app.delete('/api/agent/marketplace/item/:type/:id', asyncRoute(async (req, res) => {
    const type = normalizeType(req.params.type);
    if (!type) throw new HttpError(400, '未知扩展类型');
    const target = normalizeTarget(req.query?.target);
    const cwd = resolveProjectPath(req.query?.cwd, getCurrentProjectPath?.());
    const id = decodeURIComponent(String(req.params.id || ''));
    const result = await uninstall({ type, id, target, cwd });
    cache.clear();
    res.json({ success: true, ...result });
  }));
}
