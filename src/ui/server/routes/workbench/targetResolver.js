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
// 「这条指令该落到哪个项目」—— 全局唯一实现。
//
// 在调度台上敲一条指令时，用户不必先选项目：落到哪由这里决定。四级优先级，
// 从「最确定的意图」往下退：
//
//   1. explicit —— 调用方明确指定（用户在左栏选中了具体项目）。
//      显式意图永远最优先，不做任何"更聪明"的覆盖，否则用户会发现
//      「我明明选了它，却派到别处去了」。
//   2. mention  —— 指令原文里点名的项目（名字或完整路径）。纯字符串匹配，
//      零延迟零成本，覆盖「给 article-generator 加个功能」这类绝大多数写法。
//   3. agent    —— 交给模型判断。只有前两级都没命中才走这里（要等一次网络往返）；
//      失败、超时、编了个不存在的路径 —— 一律静默降级，绝不阻塞派发。
//   4. default  —— 都没命中，用调用方给的默认项目（应用当前项目）。
//
// 返回值里的 source 是给 UI 用的：让界面能如实说明「这个落点是怎么来的」。
// 判错了的时候，用户至少知道该怪谁 —— 是模型猜的，还是压根没识别出来。
//
// 纯逻辑 + 单次可注入的模型调用，单测不碰网络（见 targetResolver.test.js）。

import { canonicalProjectPath, projectName } from './projectRegistry.js';
import { callLlmJson } from './llmClient.js';

/** 落点来源。UI 按它选文案，服务端不写死任何面向界面的中文 */
export const TARGET_SOURCE = {
  EXPLICIT: 'explicit',
  MENTION: 'mention',
  AGENT: 'agent',
  DEFAULT: 'default',
};

export const TARGET_SOURCES = Object.values(TARGET_SOURCE);

/** 算作「词内字符」的集合：出现在 token 两侧就说明它只是某个长词的一部分 */
const WORD_CHAR = /[a-z0-9_-]/i;

/**
 * 在 text 里找 token 的「成词」出现位置，找不到返回 -1。
 *
 * 为什么非要卡边界：项目名经常互为前缀 —— 清单里同时有 `claw-management`
 * 与 `claw-management-api`、`claw-sdd` 与 `claw-sdd-project`。
 * 光用 includes/indexOf，指令里写 `claw-management-api` 会先命中 `claw-management`，
 * 改动就落到隔壁项目去了。
 */
export function indexOfToken(text, token) {
  const needle = String(token || '');
  if (!needle) return -1;
  const hay = String(text || '').toLowerCase();
  const low = needle.toLowerCase();
  let from = 0;
  for (;;) {
    const i = hay.indexOf(low, from);
    if (i < 0) return -1;
    const before = i > 0 ? hay[i - 1] : '';
    const after = i + low.length < hay.length ? hay[i + low.length] : '';
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return i;
    from = i + 1;
  }
}

/**
 * 规则匹配：指令原文里点名的项目。
 *
 * 优先级：完整路径（rank 3）> 项目名成词出现（rank 2）。
 * 同级里取「匹配到的 token 更长」的那个 —— 更长即更具体，
 * 用来压住 `claw-management` / `claw-management-api` 这类同族名。
 *
 * @param {string} text           指令原文
 * @param {object[]} projects     buildProjectEntries 的输出（{name, path, key}）
 * @returns {{ project: object, matched: string } | null}
 */
export function matchProjectMention(text, projects) {
  const src = String(text || '');
  if (!src) return null;
  const list = (Array.isArray(projects) ? projects : []).filter(p => p && p.key && p.path);
  if (!list.length) return null;

  const lower = src.toLowerCase();
  let best = null;

  for (const p of list) {
    const path = String(p.path || '').trim();
    const name = String(p.name || projectName(path)).trim();

    let matched = '';
    let rank = 0;
    if (path && lower.includes(path.toLowerCase())) {
      // 完整路径是最强信号：肯把路径敲全的人不会是在打比方
      matched = path;
      rank = 3;
    } else if (name && indexOfToken(lower, name) >= 0) {
      matched = name;
      rank = 2;
    }
    if (!matched) continue;

    if (!best || rank > best.rank || (rank === best.rank && matched.length > best.matched.length)) {
      best = { project: p, matched, rank };
    }
  }

  return best ? { project: best.project, matched: best.matched } : null;
}

/**
 * 让模型判断落点（第 3 级）。
 *
 * 只在规则匹配不到时调用。返回的路径**必须是清单里真实存在的那一条**：
 * 模型编出来的路径一律当作"没判断出来"。宁可退到默认项目，
 * 也不能凭空造一个不存在的工作目录 —— 那会让派发在下一步直接报「项目目录不存在」，
 * 用户看到的是"派发失败"，比"派到默认项目"难懂得多。
 *
 * @returns {{ project: object, reason: string } | null}
 */
export async function pickProjectByAgent({
  text,
  projects,
  model,
  timeoutMs = 15000,
  // 注入点：单测靠它替换掉真实网络调用（默认就是 callLlmJson）
  callJson = callLlmJson,
} = {}) {
  const list = (Array.isArray(projects) ? projects : []).filter(p => p && p.key && p.path);
  if (!model || !list.length) return null;

  const catalogue = list
    .map((p, i) => `${i + 1}. ${p.name || projectName(p.path)} | ${p.path}`)
    .join('\n');

  const prompt = `你在「多项目编排台」里做一次路由判断：用户刚发了一条指令，请判断它应该在下面哪个项目里执行。

可选项目（序号. 名称 | 绝对路径）：
${catalogue}

指令原文：
"""
${String(text || '').slice(0, 2000)}
"""

判断规则：
1. 指令直接提到某个项目名或路径 —— 选它。
2. 指令描述的内容明显属于某个项目（例如"修一下文章生成器的导出"对应 article-generator，如果它在上面）—— 选它。
3. 只要不能确定，就返回空字符串。**不要猜**：猜错的代价是把改动做到错误的仓库里，比退到默认项目严重得多。

只返回 JSON：
{
  "projectPath": "选中的项目绝对路径，必须是上面列出的路径原样复制；不确定就填空字符串",
  "reason": "一句话说明依据"
}`;

  const out = await callJson(model, prompt, { timeoutMs });
  const picked = canonicalProjectPath(out && out.projectPath ? out.projectPath : '');
  if (!picked) return null;
  const hit = list.find(p => p.key === picked);
  if (!hit) return null;
  return { project: hit, reason: String((out && out.reason) || '').slice(0, 200) };
}

/**
 * 解析指令的落点项目。
 *
 * @param {object}   input
 * @param {string}   input.text         指令原文
 * @param {object[]} input.projects     候选项目（{name, path, key}）
 * @param {string}   input.explicitPath 调用方显式指定的路径（空 = 没指定，走判断）
 * @param {string}   input.defaultPath  兜底路径（一般是应用当前项目）
 * @param {function} [input.getModel]   懒取模型配置。**只有真的要走第 3 级时才会被调用** ——
 *                                      常见情况（指令里点名了项目）不该为读一次 config 付成本
 * @param {number}   [input.agentTimeoutMs]
 * @param {function} [input.onAgentError] 模型判断失败时的回调（调用方记日志用）。
 *                                        不抛错：判断失败不该让整条指令派不出去
 * @param {function} [input.pickByAgent]  注入点：单测替换第 3 级，避免真发网络请求
 * @returns {Promise<{ path: string, name: string, source: string, matched: string, reason: string }>}
 */
export async function resolveInstructionTarget({
  text = '',
  projects = [],
  explicitPath = '',
  defaultPath = '',
  getModel = null,
  agentTimeoutMs = 15000,
  onAgentError = null,
  pickByAgent = pickProjectByAgent,
} = {}) {
  const list = (Array.isArray(projects) ? projects : [])
    .filter(p => p && p.key && p.path)
    .map(p => ({ ...p, name: p.name || projectName(p.path) }));
  const byKey = new Map(list.map(p => [p.key, p]));

  // ── 1. 显式指定 ──────────────────────────────────────────────────
  const explicit = String(explicitPath || '').trim();
  if (explicit) {
    const hit = byKey.get(canonicalProjectPath(explicit));
    return {
      path: hit ? hit.path : explicit,
      name: hit ? hit.name : projectName(explicit),
      source: TARGET_SOURCE.EXPLICIT,
      matched: '',
      reason: '',
    };
  }

  // ── 2. 指令原文里点名 ────────────────────────────────────────────
  const mention = matchProjectMention(text, list);
  if (mention) {
    return {
      path: mention.project.path,
      name: mention.project.name,
      source: TARGET_SOURCE.MENTION,
      matched: mention.matched,
      reason: '',
    };
  }

  // ── 3. 模型判断 ──────────────────────────────────────────────────
  if (typeof getModel === 'function') {
    try {
      const model = await getModel();
      if (model) {
        const picked = await pickByAgent({ text, projects: list, model, timeoutMs: agentTimeoutMs });
        if (picked) {
          return {
            path: picked.project.path,
            name: picked.project.name,
            source: TARGET_SOURCE.AGENT,
            matched: '',
            reason: picked.reason,
          };
        }
      }
    } catch (err) {
      if (typeof onAgentError === 'function') onAgentError(err);
    }
  }

  // ── 4. 默认项目 ──────────────────────────────────────────────────
  const fallback = String(defaultPath || '').trim();
  const def = byKey.get(canonicalProjectPath(fallback));
  const defPath = def ? def.path : fallback;
  return {
    path: defPath,
    name: def ? def.name : projectName(defPath),
    source: TARGET_SOURCE.DEFAULT,
    matched: '',
    reason: '',
  };
}
