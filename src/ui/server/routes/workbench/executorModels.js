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
// 这里把「读五个 CLI 的配置 / 状态」这件事收口成一个模块，让前端能在选择器里直接显示。
//
// ── 五家配置文件的形状（这是本模块存在的全部理由）────────────────────────
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
//            ⚠️ **但它经常是空的** —— opencode 的 TUI 允许直接选模型，而选择存在
//            自己的 state 里、不回写配置。所以还要读第二处：
//            ~/.local/state/opencode/model.json 的 recent[0]（TUI 最近使用），
//            variant（截图里那个蓝色的 max）在同文件的顶层 variant 表里。
//            两处都没有才算"没指定"，返回值里用 source 区分（config / state）。
//
//   codebuddy ~/.codebuddy/settings.json      JSON。顶层 `model` 字符串
//            （--settings '{"model":"..."}' 的落盘处；没写过就是没配，
//             CLI 用自己的内置默认 —— 那种情况下这里如实报 null）。
//
//   pi       ~/.pi/agent/settings.json         JSON。顶层 `defaultModel` 字符串
//            （官方 settings 文档的 "Startup Model ID"），`defaultProvider` 是它的
//            另一半。配置目录可被 PI_CODING_AGENT_DIR 覆盖（官方环境变量文档），
//            设了就按它的读 —— 否则会把"配了模型"报成"没配"，界面撒谎。
//            ⚠️ **这份文件经常是空的** —— pi 只在用户显式「设为默认」时才写
//            defaultModel（setModel 的 persist 分支），日常直接开 pi 的人那里
//            只有 lastChangelogVersion。所以还要读**第二处**：会话记录
//            ~/.pi/agent/sessions/<cwd>/<时间戳>_<uuid>.jsonl 里最后一条
//            model_change —— pi 每次开会话、每次切模型都追加一条，那才是
//            "CLI 内最近使用"的真值（与 opencode 的 state 同性质，用 source 区分）。
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
function detectOpencodeConfig(json) {
  const raw = json && json.model;
  if (typeof raw === 'string' && raw.trim()) {
    return { model: raw.trim(), display: null, provider: null, source: 'config' };
  }
  if (raw && typeof raw === 'object' && typeof raw.model === 'string' && raw.model.trim()) {
    const variant = typeof raw.variant === 'string' && raw.variant.trim() ? ` (${raw.variant.trim()})` : '';
    return { model: raw.model.trim() + variant, display: null, provider: null, source: 'config' };
  }
  return null;
}

/**
 * opencode 当前用哪个模型：**配置文件优先，没有就退回 TUI 的「最近使用」**。
 *
 * 为什么要读两处 —— opencode 的 TUI 允许直接选模型，而它把选择存在**自己的 state 里
 * 而不是回写配置文件**。本机就是活例子：`~/.config/opencode/opencode.jsonc` 里只有
 * `$schema`（真的没配 model），但 statusline 明确在用 `opencode-go/space-bunny-free`；
 * 那个选择躺在 `~/.local/state/opencode/model.json` 的 `recent[0]`。
 * 只读配置文件的话界面上会显示「未在配置中指定」—— 对一个**正在跑的模型**说"没指定"，
 * 比不说还糟：用户会去翻配置，而配置里确实没有，于是白折腾一场。
 *
 * 两种来源语义不同，用 `source` 区分，前端会照实标出来（同一条模型名，来源不同含义不同）：
 *   config —— 配置文件里写死了，这是"默认模型"
 *   state  —— TUI 上次选的，opencode 下次启动默认还用它
 *
 * variant（截图里那个蓝色的 `max`）在 state 顶层 `variant` 表里，键是 `provider/model`；
 * 也兼容某些版本直接写在 recent 项上的写法。
 */
function detectOpencodeState(json) {
  const recent = json && Array.isArray(json.recent) ? json.recent[0] : null;
  if (!recent || typeof recent.providerID !== 'string' || typeof recent.modelID !== 'string') return null;
  const id = `${recent.providerID}/${recent.modelID}`;
  const own = typeof recent.variant === 'string' ? recent.variant.trim() : '';
  const mapped = typeof json.variant?.[id] === 'string' ? json.variant[id].trim() : '';
  const variant = own || mapped;
  return {
    model: variant ? `${id} (${variant})` : id,
    display: null,
    // provider 不再单列：模型名本身就是 `provider/model` 形态，再报一次只是噪音
    // （`opencode-go/space-bunny-free (max) （… · opencode-go）`）
    provider: null,
    source: 'state',
  };
}

/** 配置里有就用配置的，否则看 TUI 状态；两处都没有才是真的"没指定" */
function detectOpencode(cfgJson, stateJson) {
  return detectOpencodeConfig(cfgJson) || detectOpencodeState(stateJson);
}

/**
 * codebuddy：~/.codebuddy/settings.json 的顶层 model。
 *
 * 与另三家一个重要差别：codebuddy **没有"第二处"**—— TUI 里选的模型会写回
 * settings.json（`codebuddy config set -g model <id>`），不存在 opencode 那种
 * "选择躺在 state 里、配置是空的"分裂。所以读一个文件就够。
 * 没配 → null：CLI 有自己的内置默认（init 事件里能看到，如 fast-model），
 * 但那是 CLI 的默认而不是用户的设置，按本模块的底线不猜、不报。
 */
function detectCodebuddy(json) {
  const raw = json && json.model;
  if (typeof raw === 'string' && raw.trim()) {
    return { model: raw.trim(), display: null, provider: null, source: 'config' };
  }
  return null;
}

/**
 * pi 的配置目录：默认 ~/.pi/agent，PI_CODING_AGENT_DIR 可覆盖（官方环境变量文档）。
 *
 * 相对路径按 home 解析 —— 官方是拿它当路径直接用（相对 cwd），而本模块在
 * 「无 cwd 的全局探测」上下文里跑（见 detectExecutorModels 的签名），
 * 只能拿 home 兜底；绝对路径（实际用法）不受影响。
 */
function piAgentDir(home, env = process.env) {
  const override = typeof env.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR.trim() : '';
  return override ? path.resolve(home, override) : path.join(home, '.pi', 'agent');
}

/**
 * 会话 jsonl 的扫描窗口。模型切换记在**文件尾部**（最近那次），会话开头的
 * model_change 记在**头部**（这个会话起步用的模型）—— 两头各扫一段就覆盖了
 * 真实形态，不必把可能几 MB 的会话整个读进内存。
 */
const PI_SESSION_WINDOW_BYTES = 512 * 1024;

/**
 * 从一段 jsonl 文本里取**最后一条** model_change。
 *
 * 只认 modelId / provider 两个字段并**只返回这两个** —— 会话记录里有用户的
 * 全部对话内容，任何原文都不许进返回值（同"不泄露密钥"那条底线）。
 * 被窗口边界截断的行 JSON.parse 会失败，跳过即可（model_change 行很短，
 * 实际不会被截断）。
 */
function lastModelChange(text) {
  let found = null;
  for (const line of String(text).split('\n')) {
    // 便宜的前置过滤：会话里绝大多数行是消息，先按子串筛掉，省一次 JSON.parse
    if (!line.includes('"model_change"')) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec || rec.type !== 'model_change') continue;
      if (typeof rec.modelId !== 'string' || !rec.modelId.trim()) continue;
      found = {
        model: rec.modelId.trim(),
        provider: typeof rec.provider === 'string' && rec.provider.trim() ? rec.provider.trim() : null,
      };
    } catch { /* 窗口边界上被截断的行 */ }
  }
  return found;
}

/**
 * 读文件的两端：头部 + 尾部各至多 PI_SESSION_WINDOW_BYTES。
 *
 * 拼接顺序是 头 → 尾，**不能反**：调用方只取"最后一条" model_change，
 * 反过来拼就会把会话开头那个模型当成最近用的。
 *
 * ⚠️ 判"要不要读两段"的条件是 `tailStart === 0`（文件小到一个窗口就装得下），
 * **不能**写成 `tailStart < headLen` —— 那会把 1～2 个窗口大的文件误判成"装得下"，
 * 只返回头部，把尾部那次切模型整个漏掉（本仓库踩过：模型换在文件末尾才看不见）。
 * 1～2 个窗口时两段重叠一段也无所谓，同一行解析两遍结果一样。
 *
 * 中间那条 '\n' 是保险：头部最后一行可能被切成半行，直接拼会跟尾部第一行
 * （同样是被切过的半行）黏成一行 —— 分开至少保证不会拼出一个假记录。
 */
async function readTextWindow(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const headLen = Math.min(size, PI_SESSION_WINDOW_BYTES);
    const head = Buffer.alloc(headLen);
    if (headLen) await handle.read(head, 0, headLen, 0);
    const tailStart = Math.max(0, size - PI_SESSION_WINDOW_BYTES);
    if (tailStart === 0) return head.toString('utf8');
    const tailLen = size - tailStart;
    const tail = Buffer.alloc(tailLen);
    if (tailLen) await handle.read(tail, 0, tailLen, tailStart);
    return head.toString('utf8') + '\n' + tail.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * pi 的「第二处来源」：**最新那个会话记录里最后一条 model_change**。
 *
 * 为什么必须有这一处 —— 与 opencode 同一个理由，只是 pi 的"state"落在会话文件里：
 * ~/.pi/agent/settings.json 的 defaultModel 只在用户显式「设为默认」时才写，
 * 日常直接开 pi 的人那份文件是空的；此时 pi 走自己的回落链（官方 findInitialModel：
 * CLI 参数 → --models 范围 → 会话恢复 → 配置默认 → **第一个有凭据的模型**），
 * 而"到底落了哪个"只写在会话 jsonl 里。只读配置文件的话，界面会对一个**正在跑的
 * 模型**说「未在配置中指定」—— 用户会去翻配置，配置里确实没有，白折腾一场。
 *
 * 取**最后一条**而不是第一条：用户在 TUI 里 `/model` 换过的话，只有最后那条
 * 才是他现在在用的。
 *
 * 会话目录按 cwd 分（sessions/<cwd 编码>/），文件名是
 * `<UTC ISO 时间戳>_<uuid>.jsonl` —— **字典序即时间序**，所以直接比字符串就能
 * 挑出最新的那个，不用对每个文件 stat（跨项目几十个目录时省一轮 I/O）。
 */
async function detectPiSessionState(agentDir) {
  const sessionsDir = path.join(agentDir, 'sessions');
  let dirs;
  try {
    dirs = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null; // 从没跑过 pi / 目录被删 —— 当"没有第二处来源"，不抛
  }

  let newestName = null;
  let newestPath = null;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = path.join(sessionsDir, d.name);
    let files;
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue; // 单个项目目录读不了（权限/竞态删除）不该拖垮整次探测
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (newestName !== null && f <= newestName) continue;
      newestName = f;
      newestPath = path.join(dirPath, f);
    }
  }
  if (!newestPath) return null;

  const state = lastModelChange(await readTextWindow(newestPath));
  return state ? { model: state.model, display: null, provider: state.provider, source: 'state' } : null;
}

/**
 * pi 当前用哪个模型：**配置文件优先，没有就退回会话记录**（同 opencode 的两处口径）。
 *
 * provider 只取 settings 的 defaultProvider（形如 `cc-switch-open-code-go`）——
 * 它和 claude 的 base_url 一样是"这个模型打给谁"，放 detail 里给用户看。
 *
 * ⚠️ 已知的口径差：官方 findInitialModel 要求 defaultProvider 与 defaultModel
 * **同时**存在才认这条默认值，这里只要 defaultModel 就报。这是有意的宽容 ——
 * pi 自己的设置界面（settings-selector）与 setModel(persist) 永远成对写入，
 * 手写只填一半属于畸形配置；此时如实报"配置里写了这个模型"比整块不显示有用。
 */
function detectPi(json, sessionState) {
  const raw = json && json.defaultModel;
  if (typeof raw === 'string' && raw.trim()) {
    const provider = json && typeof json.defaultProvider === 'string' && json.defaultProvider.trim()
      ? json.defaultProvider.trim()
      : null;
    return { model: raw.trim(), display: null, provider, source: 'config' };
  }
  return sessionState;
}

function detectCodeArts(json) {
  // 与 opencode 同一条判定：它是 opencode 的 fork，配置 schema 都写着 opencode.ai/config.json。
  // 顶层 `model` 可以是 "provider/model" 字符串，也可以是 { model, variant } 对象。
  const raw = json && json.model;
  if (typeof raw === 'string' && raw.trim()) {
    return { model: raw.trim(), display: null, provider: null, source: 'config' };
  }
  if (raw && typeof raw === 'object' && typeof raw.model === 'string' && raw.model.trim()) {
    const variant = typeof raw.variant === 'string' && raw.variant.trim() ? ` (${raw.variant.trim()})` : '';
    return { model: raw.model.trim() + variant, display: null, provider: null, source: 'config' };
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 探测六个执行器当前在用的模型。
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir] 测试沙箱用（默认 os.homedir()）
 * @returns {Promise<{ claude: object|null, codex: object|null, opencode: object|null, codebuddy: object|null, pi: object|null, codearts: object|null }>}
 *          每项 `{ model, display, provider, source }`；该执行器没配模型时为 null。
 *          source = 'config'（配置文件里写死的）| 'state'（CLI 自己记的"上次用的"）。
 *
 * 多路并发、互不阻塞：任何一个文件读失败都只让**它自己**变成 null。
 * 两处来源的执行器（opencode / pi）都是 config 优先、state 兜底，
 * 由 detectOpencode / detectPi 各自收口。
 */
export async function detectExecutorModels({ homeDir } = {}) {
  const home = homeDir || os.homedir();
  const piDir = piAgentDir(home);
  // 码道的 OPENCODE_CONFIG / OPENCODE_CONFIG_FILE（见 taskRunner.buildCodeArtsEnv）
  const codeArtsDir = path.join(home, '.codeartsdoer');

  const [claudeRaw, codexRaw, opencodeJsonRaw, opencodeJsoncRaw, opencodeStateRaw, codebuddyRaw, piRaw, piState, codeArtsJsonRaw, codeArtsJsoncRaw] = await Promise.all([
    readTextOrNull(path.join(home, '.claude', 'settings.json')),
    readTextOrNull(path.join(home, '.codex', 'config.toml')),
    // .json 优先（标准名），.jsonc 兜底。opencode 两个都认。
    readTextOrNull(path.join(home, '.config', 'opencode', 'opencode.json')),
    readTextOrNull(path.join(home, '.config', 'opencode', 'opencode.jsonc')),
    // TUI 的"最近使用"（不写回配置文件，见 detectOpencodeState 的注释）
    readTextOrNull(path.join(home, '.local', 'state', 'opencode', 'model.json')),
    // CodeBuddy Code CLI（与 WorkBuddy 桌面版共用的配置目录）
    readTextOrNull(path.join(home, '.codebuddy', 'settings.json')),
    // Pi CLI（配置目录可被 PI_CODING_AGENT_DIR 覆盖，见 piAgentDir）
    readTextOrNull(path.join(piDir, 'settings.json')),
    // Pi 的"最近使用"（defaultModel 只在显式「设为默认」时才写，见 detectPiSessionState）
    detectPiSessionState(piDir),
    // 码道 CLI：文件名由 codearts.cmd 的 OPENCODE_CONFIG_FILE 指定（json 优先、jsonc 兜底）
    readTextOrNull(path.join(codeArtsDir, 'codearts_cli.json')),
    readTextOrNull(path.join(codeArtsDir, 'codearts_cli.jsonc')),
  ]);

  const pickJson = (raw) => {
    if (!raw) return null;
    try { return JSON.parse(stripJsonComments(raw)); } catch { return null; }
  };

  const claudeCfg = pickJson(claudeRaw);
  // ⚠️ 两个文件都要接住：早先这一行只吃了 .json（另一个 promise 被解构丢掉），
  // 于是注释里写的"jsonc 兜底"是死代码 —— 只写了 .jsonc 的机器永远显示未配置。
  const opencodeCfg = pickJson(opencodeJsonRaw) || pickJson(opencodeJsoncRaw);
  const opencodeState = pickJson(opencodeStateRaw);
  const codebuddyCfg = pickJson(codebuddyRaw);
  const piCfg = pickJson(piRaw);
  const codeArtsCfg = pickJson(codeArtsJsonRaw) || pickJson(codeArtsJsoncRaw);

  return {
    claude: claudeCfg && typeof claudeCfg.env === 'object' && claudeCfg.env
      ? detectClaude(claudeCfg.env)
      : null,
    codex: codexRaw ? detectCodex(codexRaw) : null,
    opencode: detectOpencode(opencodeCfg, opencodeState),
    codebuddy: detectCodebuddy(codebuddyCfg),
    pi: detectPi(piCfg, piState),
    codearts: detectCodeArts(codeArtsCfg),
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
  return {
    name,
    detail: detail || null,
    provider: info.provider || null,
    // 来源照实带出去：同一个模型名，"配置里写死的"与"CLI 上次记下的"含义不同
    source: info.source || null,
  };
}
