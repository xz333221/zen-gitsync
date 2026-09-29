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
// 「这个执行器现在实际在用什么模型」的**只读探测**。
//
// ── 为什么要做这件事 ────────────────────────────────────────────────────────
//
// 工作台派任务时一律**不传模型参数**：claude / opencode / codex 的 spawn argv 里
// 都没有 --model（见 taskRunner.js 的注释与 README 的 argv 清单），模型跟随各自
// CLI 的配置。这条设计是对的 —— 但副作用是界面上**一个执行器的模型都看不到**：
// 底栏那个「默认模型 xxx」是**内置 g ai 引擎**用的 config.models，跟三个执行器
// 毫无关系（agentRoutes.js 里对外部引擎刻意把 session.model 置空也是同一个原因）。
// 于是用户想确认"这活到底是哪个模型跑的"只能去翻三个不同格式的配置文件。
//
// 这里把「读三个配置文件」这件事收口成一个模块，让前端能在选择器里直接显示。
//
// ── 三家配置文件的形状（这是本模块存在的全部理由）────────────────────────
//
//   claude   ~/.claude/settings.json         JSON。模型在 env 里，且有**别名两层**：
//            ANTHROPIC_DEFAULT_SONNET_MODEL 是 CLI 认识的名字
//            （claude-sonnet-5[1M]），..._MODEL_NAME 才是它背后真正的模型
//            （本机经代理指向 deepseek-v4.1-flash）。只报前者等于没报 ——
//            用户看到"claude-sonnet-5"会以为在用官方模型，实际是代理换过的。
//            所以两条都返回，display 优先取 _NAME。
//
//   codex    ~/.codex/config.toml            TOML。顶层 `model = "..."`。
//            ⚠️ 文件里还有 [projects.*] / [mcp_servers.*] 等几十个段，
//            段内也可能出现 model 键 —— 只认**任何 [表头] 之前**的顶层赋值。
//            同段的 model_providers.<id>.name 给出服务商名，一并带出。
//
//   opencode ~/.config/opencode/opencode.json / .jsonc
//            JSONC（带注释与尾逗号）。顶层 `model` 字段，可以是字符串
//            "provider/model-id"，也可以是对象 { model, variant }。
//            **本机这个文件里没写 model** —— opencode 允许启动参数/环境变量注入，
//            配置文件里读不到就是读不到，返回 null 而不是编一个。
//
// ── 三条必须守住的底线 ──────────────────────────────────────────────────────
//
// 1. **纯只读**：只 fs.readFile，一个字节都不写。改用户 CLI 的配置是绝对禁区。
// 2. **不泄露密钥**：codex 的 config.toml 里有 experimental_bearer_token，
//    claude 的 env 里有 ANTHROPIC_API_KEY —— 本模块只取模型名/服务商名，
//    任何 key 字段都不许出现在返回值里（readTomlTopLevel 只取显式白名单里的键）。
// 3. **读不到就是 null**：不猜、不回落成"看起来对"的字符串。前端照实显示
//    「未在配置中指定」，这比显示一个假模型名有用得多。

import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * 从 TOML 文本里取**顶层**（任何 [表头] 之前）的标量键。
 *
 * 为什么不用 TOML 解析库：codex 的 config.toml 结构简单（顶层几个标量 + 一堆段），
 * 而为一个"读一行"引入解析器依赖不划算；本仓库也没有现成的 TOML 依赖。
 * 代价是**只支持顶层标量**——这正是本模块需要的，段内的键一律不取。
 *
 * ⚠️ 刻意不解析行尾注释之外的任何语法：支持单/双引号值、数组（取不到就跳过）、
 * 布尔与数字原样返回字符串。够用且不会把 `[projects.'c:\path']` 这种
 * 引号里带方括号的段头误判成值。
 *
 * ⚠️ 注释行与空行必须 **continue 而不是 break**：真实的 codex config.toml 顶部
 * 常带几行 `#` 说明、键与键之间也常空行；早先这三类一起 break，导致"文件第一行
 * 是注释"时顶层 model 整个读空（返回 {}），表现为界面上 codex 永远显示未配置。
 */
export function readTomlTopLevel(text, keys) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    // 注释 / 空行在顶层键之间是合法的，跳过继续找
    if (!line || line.startsWith('#')) continue;
    // 只有段头才代表"顶层到此结束"：后面的键都属于某个段
    if (line.startsWith('[')) break;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    if (!keys.includes(m[1])) continue;
    const value = m[2].trim();
    // 只收字符串值。数组/内联表一律不取 —— 本模块用不到，硬解只会解错。
    const quoted = value.match(/^(["'])([\s\S]*?)\1\s*(?:#.*)?$/);
    if (quoted) out[m[1]] = quoted[2];
  }
  return out;
}

/**
 * 剥掉 JSONC 的注释与尾逗号，让 JSON.parse 能吃下 opencode.jsonc。
 *
 * 不引依赖的原因同上（只为读一个字段）。实现要点是**必须逐字符走**而不是
 * 正则全局替换 —— 字符串字面量里的 `//`（比如 base_url 带 `https://`）会被误伤，
 * 而本机的 codex/opencode 配置里 URL 是常见值。扫描时记住"在不在字符串里"，
 * 同时处理转义引号 `\"`。
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    // 行注释
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    // 块注释
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // 尾逗号：`{"a":1,}` 与数组里的 `1,]`。这里只处理对象/数组结尾前的那一个逗号。
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function readTextOrNull(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    // 文件不存在 / 无权限 / 是目录 —— 一律当"没配"，不抛
    return null;
  }
}

/**
 * claude：~/.claude/settings.json 的 env 段。
 *
 * 返回两条名字是有意的：
 *   model  = ANTHROPIC_MODEL（若显式指定），否则取 sonnet 档的别名
 *   display= ..._MODEL_NAME，即别名背后真正的模型名
 * 都取不到时返回 null。
 *
 * 为什么按 sonnet → opus → haiku 的顺序找：claude 在没有显式 ANTHROPIC_MODEL 时
 * 会按档位选模型，日常跑任务默认落在 sonnet 档，所以它是最可能生效的那一档。
 */
function detectClaude(env) {
  const pick = (tier) => ({
    alias: env[`ANTHROPIC_DEFAULT_${tier}_MODEL`],
    display: env[`ANTHROPIC_DEFAULT_${tier}_MODEL_NAME`],
  });

  const explicit = env.ANTHROPIC_MODEL;
  if (typeof explicit === 'string' && explicit.trim()) {
    // 显式指定时没有"别名背后"的第二层，但 base_url 仍然要带出来 ——
    // 用户看到 ANTHROPIC_MODEL 是官方名、实际请求打到自建代理，这才是关键信息。
    return { model: explicit.trim(), display: null, provider: env.ANTHROPIC_BASE_URL || null };
  }

  for (const tier of ['SONNET', 'OPUS', 'HAIKU', 'FABLE']) {
    const hit = pick(tier);
    if (!hit.alias && !hit.display) continue;
    return {
      model: hit.alias || null,
      // display 优先：别名背后那个才是用户真正在付钱/发请求的模型
      display: hit.display || null,
      provider: env.ANTHROPIC_BASE_URL || null,
    };
  }
  return null;
}

/** codex：顶层 model + model_providers.<model_provider>.name 的服务商名 */
function detectCodex(toml) {
  const top = readTomlTopLevel(toml, ['model', 'model_provider']);
  if (!top.model) return null;
  const providerId = top.model_provider;
  // 服务商名要进 [model_providers.x] 段里找，段头格式：`[model_providers."custom"]`
  // 或 `[model_providers.custom]`。这里只取「段内第一个 name = 」，够用且不误伤
  // （其他段也有 name 键，但只认 model_providers.* 段）。
  let provider = null;
  if (providerId) {
    const sectionRe = new RegExp(`^\\[model_providers\\.${escapeRe(providerId)}\\]\\s*$`, 'm');
    const m = sectionRe.exec(toml);
    if (m) {
      const rest = toml.slice(m.index + m[0].length);
      const end = rest.search(/^\s*\[/m);
      const body = end >= 0 ? rest.slice(0, end) : rest;
      const name = readTomlTopLevel(body, ['name']).name;
      if (name) provider = name;
    }
  }
  return { model: top.model, display: null, provider };
}

/** opencode：顶层 model，字符串或 { model, variant } 都吃；顺便记 variant */
function detectOpencode(json) {
  const raw = json && json.model;
  if (typeof raw === 'string' && raw.trim()) {
    return { model: raw.trim(), display: null, provider: null };
  }
  if (raw && typeof raw === 'object' && typeof raw.model === 'string' && raw.model.trim()) {
    const variant = typeof raw.variant === 'string' && raw.variant.trim() ? ` (${raw.variant.trim()})` : '';
    return { model: raw.model.trim() + variant, display: null, provider: null };
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 探测三个执行器当前配置的模型。
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir] 测试沙箱用（默认 os.homedir()）
 * @returns {Promise<{ claude: object|null, codex: object|null, opencode: object|null }>}
 *          每项 `{ model, display, provider }`；该执行器没配模型时为 null。
 *
 * 三路并发、互不阻塞：任何一个配置文件读失败都只让**它自己**变成 null。
 */
export async function detectExecutorModels({ homeDir } = {}) {
  const home = homeDir || os.homedir();

  const [claudeRaw, codexRaw, opencodeJsonRaw, opencodeJsoncRaw] = await Promise.all([
    readTextOrNull(path.join(home, '.claude', 'settings.json')),
    readTextOrNull(path.join(home, '.codex', 'config.toml')),
    // .json 优先（标准名），.jsonc 兜底。opencode 两个都认。
    readTextOrNull(path.join(home, '.config', 'opencode', 'opencode.json')),
    readTextOrNull(path.join(home, '.config', 'opencode', 'opencode.jsonc')),
  ]);

  const pickJson = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(stripJsonComments(raw)); } catch { return null; }
  };

  const claudeCfg = pickJson(claudeRaw);
  // ⚠️ 两个文件都要接住：早先这一行只吃了 .json（另一个 promise 被解构丢掉），
  // 于是注释里写的"jsonc 兜底"是死代码 —— 只写了 .jsonc 的机器永远显示未配置。
  const opencodeCfg = pickJson(opencodeJsonRaw) || pickJson(opencodeJsoncRaw);

  return {
    claude: claudeCfg && typeof claudeCfg.env === 'object' && claudeCfg.env
      ? detectClaude(claudeCfg.env)
      : null,
    codex: codexRaw ? detectCodex(codexRaw) : null,
    opencode: detectOpencode(opencodeCfg),
  };
}

/**
 * 探测结果的展示格式化：给出**给人看**的那一个名字。
 *
 * 为什么 display 优先：claude 场景下 model 是 CLI 认识的别名（claude-sonnet-5[1M]），
 * display 才是背后真实的模型（deepseek-v4.1-flash）。给用户看别名等于没回答问题。
 * 两者都有且不同时用 `display` 并把别名放 detail（前端 title 用）。
 */
export function formatExecutorModel(info) {
  // 两个名字全空 = 没探测到，返回 null 让前端走"未在配置中指定"
  if (!info || (!info.model && !info.display)) return null;
  const name = info.display || info.model;
  const detail = info.display && info.model && info.display !== info.model
    ? info.model
    : null;
  return { name, detail: detail || null, provider: info.provider || null };
}
