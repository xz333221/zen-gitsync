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
// 项目图标：给项目清单里的每个项目找一枚「它自己的图标」（favicon）。
//
// 起因：左栏项目行一律画同一枚文件夹图标 —— 十几个项目排在一起，除了名字没有任何
// 可辨识的东西。而项目自己本来就带着 favicon（`public/favicon.svg`、`index.html` 里
// 声明的 `<link rel="icon">`），拿它当行图标既准确又零维护：项目换了图标，这里跟着换。
//
// 两条取图路径，**按可信度排序**：
//   1. `index.html` 里声明的 `<link rel="icon">` —— 那是这个项目在浏览器标签页上真实
//      显示的那枚图，由项目自己维护，最权威；顺带覆盖「图标不叫 favicon」的项目
//      （`/brand.svg`、`/icon_144.png` 这类）。
//   2. 扫盘找到的 `favicon.{svg,png,webp,ico}` —— 覆盖没有 index.html 的项目
//      （后端服务、多子项目仓库、只有构建产物的仓库）。
//
// 扫盘是**有界**的：相对项目根最多往下两层（正好覆盖 `frontend/public/favicon.svg`
// 这一档，实测本机三十几个项目全落在这两层里），列目录总数封顶，`node_modules` /
// `.git` / 各种缓存目录直接不进；`dist` / `build` / `docs` 这类目录**排到最后**
// （它们动辄上千个目录，先扫会把预算烧光，而里面的 favicon 通常只是 `public/` 那份的副本）。
//
// 结果按 TTL 缓存：看板是 5s 轮询的，没有缓存等于每 5 秒把三十几个项目重新走一遍盘。
//
// 安全边界（与 projectRegistry / `/api/recent_directories/git-state` 同一条口径）：
//   本模块只回答「这个目录里有没有图标」，路径全部来自服务端可信来源；
//   对外暴露的读取端点另有白名单校验（见 routes/workbench/index.js 的 project-icon 路由）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeDirKey } from '../../utils/directoryGitState.js';

/** 图标探测结果的缓存 TTL。favicon 几乎不变，5 分钟一次足够跟得上「项目换了图标」 */
export const ICON_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 认的图标后缀 → MIME。**键的顺序就是同目录同名时的优先级**：
 * svg 是矢量的，缩到 14px 的行内图标最锐利，所以排在 ico 前面。
 */
export const ICON_MIME = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
});

const EXT_RANK = new Map(Object.keys(ICON_MIME).map((ext, i) => [ext, i]));

/**
 * 扫盘认的文件名（小写，含后缀）。刻意**只认 favicon 本体**：
 * `favicon-dark.svg` 是暗色变体、`favicon-preview.png` / `favicon-sizes.png` 是设计稿
 * 预览图 —— 把它们当图标摆到行上都是错的，所以这里用精确名单而不是 `favicon*` 通配。
 */
const FAVICON_NAMES = new Set(Object.keys(ICON_MIME).map(ext => `favicon${ext}`));

/** 相对项目根最多往下走两层。再深就不是「项目的图标」而是某个角落里的图片了 */
const MAX_DEPTH = 2;
/** 一次探测最多列多少个目录（预算烧光就用手上已有的候选，不再往深走） */
const MAX_DIRS = 200;
/** 最多解析几个 index.html（多子项目仓库里可能有好几个） */
const MAX_HTML_FILES = 8;
/** index.html 只读头部这么多字节：`<link rel="icon">` 一定在 head 里 */
const MAX_HTML_BYTES = 64 * 1024;
/** 超过这个大小的不当图标用（正常 favicon 是 KB 级，几 MB 的一定是别的东西） */
const MAX_ICON_BYTES = 1024 * 1024;

/** 完全不进的目录（小写比较）。全是依赖 / 版本控制 / 缓存 / 用户数据目录 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.git-worktrees', '.trash',
  '.idea', '.vscode', '.vs', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', 'virtualenv', 'target', 'vendor', 'pods', '.gradle', '.cxx',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.angular', '.output', '.vercel', '.netlify',
  '.cache', '.parcel-cache', '.turbo', '.pnpm-store', '.npm', '.yarn', '.cargo',
  '.rustup', '.m2', '.local', '.config', '.android', '.ollama', '.claude', '.cursor',
  'coverage', '.nyc_output', '.terraform', '.docker', '.history',
  'appdata', 'library', 'saved games', 'application data',
  'tmp', 'temp', '.tmp', 'logs', 'log', 'cache',
]);

/** 排到最后再扫的目录（不跳过：有的仓库只有构建产物里带 favicon） */
const LATE_DIRS = new Set([
  'dist', 'build', 'out', 'output', 'release', 'public-build', 'bundle',
  'docs', 'doc', 'documentation', 'demo', 'demos', 'example', 'examples',
  'test', 'tests', '__tests__', 'e2e', 'spec', 'specs', 'playground', 'samples',
  'backup', 'bak', 'old', 'archive', 'legacy', 'node_modules.bak',
]);

/**
 * 从 HTML 文本里抠出图标地址。纯函数，单测覆盖。
 *
 * 认 `rel` 里含 `icon` 的全部写法：`icon` / `shortcut icon` / `apple-touch-icon` /
 * `mask-icon`（`-` 是词边界，所以 `\bicon\b` 一次覆盖完）。
 *
 * 返回**按后缀优先级排好序**的地址列表（svg 在前）—— 项目同时声明 ico 与 svg 时
 * 拿 svg 那个，与上面 ICON_MIME 的顺序同源。同优先级保持文档顺序（Array#sort 稳定）。
 */
export function parseIconHrefs(html) {
  const out = [];
  const tagRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(String(html || '')))) {
    const tag = m[0];
    const rel = attrOf(tag, 'rel');
    if (!rel || !/\bicon\b/i.test(rel)) continue;
    const href = normalizeHref(attrOf(tag, 'href'));
    if (href) out.push(href);
  }
  return out.sort((a, b) => rankOfHref(a) - rankOfHref(b));
}

/** 取标签上某个属性的值（双引号 / 单引号 / 无引号三种写法）。纯函数 */
function attrOf(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = String(tag || '').match(re);
  if (!m) return '';
  return String(m[2] ?? m[3] ?? m[4] ?? '').trim();
}

/**
 * 把 href 归一成能用的地址。纯函数。
 * 剥掉 vite / CRA 的模板占位符（`%BASE_URL%favicon.ico`）与 HTML 实体，
 * `data:` 内联图标直接丢掉（几十 KB 的 base64 塞进接口不值当）。
 */
function normalizeHref(href) {
  const h = String(href || '')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/^%[A-Z_]+%/, '');
  if (!h || /^data:/i.test(h)) return '';
  return h;
}

/** href 的后缀优先级（认不出的一律垫底）。纯函数 */
function rankOfHref(href) {
  const clean = String(href || '').split('#')[0].split('?')[0];
  const rank = EXT_RANK.get(path.extname(clean).toLowerCase());
  return rank === undefined ? 99 : rank;
}

/** 目标文件是不是确实在项目根里（声明里写 `../../` 的不认）。纯函数 */
function isInside(rootAbs, abs) {
  const rel = path.relative(rootAbs, abs);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 子目录自己是不是一个仓库（有 `.git`，目录或子模块那种文件都算）。
 *
 * 用来把**嵌套的仓库**整支排除掉：`d:\workspace` 这种"装着一堆项目"的目录本身也被
 * 当成一个项目列在左栏里，如果放任往下扫，它会借到某个嵌套项目的图标 —— 行上显示的是
 * 别人的 logo，比显示文件夹图标还糟。嵌套仓库本来就是**另一个项目**（它自己有一行），
 * 不属于当前这一支。
 */
async function isNestedRepo(abs) {
  try {
    await fs.access(path.join(abs, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** 读文件头部若干字节（index.html 可能很大，图标声明一定在最前面） */
async function readHead(abs) {
  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(MAX_HTML_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_HTML_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * 一个候选文件能不能当图标用：后缀在白名单里、在项目根内、大小正常。
 * 不满足 → null（不抛：探测链路上任何一个候选不合格都只是"换下一个"）。
 */
async function statIcon(abs, rootAbs) {
  const mime = ICON_MIME[path.extname(abs).toLowerCase()];
  if (!mime) return null;
  if (!isInside(rootAbs, abs)) return null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile() || st.size === 0 || st.size > MAX_ICON_BYTES) return null;
    return {
      abs,
      rel: path.relative(rootAbs, abs).split(path.sep).join('/'),
      mime,
      mtimeMs: Math.round(st.mtimeMs || 0),
    };
  } catch {
    return null;
  }
}

/**
 * 把一个 href 解析成图标文件。纯逻辑 + 若干次 stat。
 *
 * 相对地址（`./favicon.svg`、`favicon.svg`）先按 html 所在目录解，再试它的 `public/`、
 * `static/` —— vite / CRA 把 `public/` 里的东西挂在站点根，`index.html` 里写的却是
 * `/favicon.svg`，光按字面解会找不到（本机多数项目正是这种写法）。
 * 根绝对地址（`/favicon.svg`）同理，另外再退到项目根（`static/index.html` 里写的
 * `/static/favicon.svg` 就是靠这一条解出来的）。
 */
async function resolveIconHref(href, htmlDirAbs, rootAbs) {
  if (/^https?:\/\//i.test(href) || href.startsWith('//')) {
    const url = href.startsWith('//') ? `https:${href}` : href;
    return { abs: '', rel: '', mime: '', mtimeMs: 0, remote: url };
  }
  const clean = String(href).split('#')[0].split('?')[0];
  if (!clean) return null;
  const candidates = clean.startsWith('/')
    ? [
      path.join(htmlDirAbs, clean.slice(1)),
      path.join(htmlDirAbs, 'public', clean.slice(1)),
      path.join(rootAbs, clean.slice(1)),
      path.join(rootAbs, 'public', clean.slice(1)),
    ]
    : [
      path.join(htmlDirAbs, clean),
      path.join(htmlDirAbs, 'public', clean),
      path.join(htmlDirAbs, 'static', clean),
    ];
  for (const abs of candidates) {
    const hit = await statIcon(abs, rootAbs);
    if (hit) return hit;
  }
  return null;
}

/** 某个 index.html 声明的第一个「真的存在」的图标 */
async function iconFromHtml(htmlAbs, rootAbs) {
  let html = '';
  try {
    html = await readHead(htmlAbs);
  } catch {
    return null;
  }
  for (const href of parseIconHrefs(html)) {
    const hit = await resolveIconHref(href, path.dirname(htmlAbs), rootAbs);
    if (hit) return hit;
  }
  return null;
}

/**
 * 有界扫盘：广度优先 + 目录打分排序，返回候选图标文件与 index.html。
 *
 * 为什么用「排序后取最小」而不是纯队列：预算有限（MAX_DIRS），必须保证被丢掉的
 * 是"最不像放着图标"的那些目录。打分 = 深度 × 10 + 产物目录罚 60 ——
 * 深度主导（浅的永远先扫），罚分只用来把 dist/build/docs 这类推到同深度的后面。
 */
async function walkProject(rootAbs) {
  const files = [];
  const htmls = [];
  const queue = [{ abs: rootAbs, rel: '', depth: 0, late: false }];
  let budget = MAX_DIRS;

  while (queue.length && budget > 0) {
    queue.sort((a, b) => (a.depth * 10 + (a.late ? 60 : 0)) - (b.depth * 10 + (b.late ? 60 : 0)));
    const cur = queue.shift();
    budget -= 1;

    let entries;
    try {
      entries = await fs.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue; // 没权限 / 读不动：这一支放弃，其它分支照常
    }

    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (cur.depth >= MAX_DEPTH) continue;
        const lower = ent.name.toLowerCase();
        if (SKIP_DIRS.has(lower)) continue;
        const abs = path.join(cur.abs, ent.name);
        if (await isNestedRepo(abs)) continue; // 嵌套仓库：它自己是一个项目，别借它的图标
        queue.push({
          abs,
          rel,
          depth: cur.depth + 1,
          late: cur.late || LATE_DIRS.has(lower),
        });
        continue;
      }
      if (!ent.isFile()) continue;
      const lower = ent.name.toLowerCase();
      if (FAVICON_NAMES.has(lower)) {
        files.push({
          abs: path.join(cur.abs, ent.name),
          rel,
          depth: cur.depth,
          ext: path.extname(lower),
          late: cur.late,
        });
      } else if (lower === 'index.html' && htmls.length < MAX_HTML_FILES) {
        htmls.push({ abs: path.join(cur.abs, ent.name), rel, depth: cur.depth, late: cur.late });
      }
    }
  }

  const byScore = (a, b) => (a.depth * 10 + (a.late ? 60 : 0)) - (b.depth * 10 + (b.late ? 60 : 0));
  files.sort((a, b) => byScore(a, b) || EXT_RANK.get(a.ext) - EXT_RANK.get(b.ext));
  htmls.sort(byScore);
  return { files, htmls };
}

/**
 * 在某个目录里找项目图标。找不到返回 null，**永不抛** ——
 * 图标是锦上添花，不能因为它挂掉而让看板接口整个 500。
 *
 * @returns {Promise<null | { abs: string, rel: string, mime: string, mtimeMs: number, remote?: string }>}
 */
export async function findProjectIcon(dir) {
  const raw = typeof dir === 'string' ? dir.trim() : '';
  if (!raw) return null;
  const rootAbs = path.resolve(raw);
  try {
    const st = await fs.stat(rootAbs);
    if (!st.isDirectory()) return null;
  } catch {
    return null; // 目录不存在（清单里那些「目录不存在」的行）：没有图标
  }

  const { files, htmls } = await walkProject(rootAbs);

  // ① 项目自己声明的图标优先 —— 那才是它标签页上真正显示的那枚
  // 产物目录里的 index.html（`dist/index.html`）排到最后：那是构建副本，
  // 项目自己的 `public/favicon.svg` 才是源头（构建副本可能还是旧的图标）。
  for (const html of htmls.filter(h => !h.late)) {
    const hit = await iconFromHtml(html.abs, rootAbs);
    if (hit) return hit;
  }
  // ② 退到扫盘结果
  for (const f of files) {
    const hit = await statIcon(f.abs, rootAbs);
    if (hit) return hit;
  }
  // ③ 最后才认产物目录里那份 index.html（只有构建产物带图标的仓库走得到这里）
  for (const html of htmls.filter(h => h.late)) {
    const hit = await iconFromHtml(html.abs, rootAbs);
    if (hit) return hit;
  }
  return null;
}

const cache = new Map(); // normalizeDirKey(dir) → { ts, icon }

/**
 * 带缓存的探测。看板 5s 轮询一次，命中缓存时只有一次 Map 查表。
 * 探测异常按「没有图标」缓存：宁可这一轮没图标，也不能让轮询反复去踩同一个坑。
 */
export async function getProjectIcon(dir, { ttlMs = ICON_CACHE_TTL_MS } = {}) {
  const key = normalizeDirKey(dir);
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return hit.icon;
  let icon = null;
  try {
    icon = await findProjectIcon(dir);
  } catch {
    icon = null;
  }
  cache.set(key, { ts: Date.now(), icon });
  return icon;
}

async function runWithConcurrency(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 批量探测（项目清单用）。并发上限 4：一次页面加载三十几个项目，
 * 全并发会让慢盘 / 网络盘互相抢 IO。
 *
 * @returns {Promise<Map<string, object|null>>} 以**传入的原始路径**为键
 */
export async function resolveProjectIcons(paths, { ttlMs, concurrency = 4 } = {}) {
  const out = new Map();
  const list = Array.from(new Set(
    (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && p.trim())
  ));
  await runWithConcurrency(list, concurrency, async (p) => {
    out.set(p, await getProjectIcon(p, { ttlMs }));
  });
  return out;
}

/**
 * 图标在前端的地址。
 *
 * 带 `v=<mtime>` 查询参数：图标换了文件内容，地址跟着变，浏览器不会拿旧缓存
 * （路由那边因此可以放心给长缓存）。远程图标（index.html 里写死了 CDN 地址）直接用原地址。
 */
export function projectIconUrl(projectKey, icon) {
  if (!icon) return null;
  if (icon.remote) return icon.remote;
  return `/api/workbench/project-icon?path=${encodeURIComponent(projectKey)}&v=${icon.mtimeMs || 0}`;
}

/** 清缓存（单测用；也留作"用户手动刷新图标"的口子） */
export function clearProjectIconCache() {
  cache.clear();
}
