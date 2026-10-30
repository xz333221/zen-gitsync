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
// ─────────────────────────────────────────────────────────────
// 默认模型失败时的「换模型重试」层
//
// 背景：本项目里所有 AI 驱动的内容（AI 启动建议 / 差异说明 / 目录解读 /
// 代码分析 / 提交信息）以前都写死「取 isDefault 的那一个，失败就报错」。
// 默认模型这个月的额度用完之后，这些功能会**整块不可用** —— 明明设置里还配着
// 好几个能用的模型。
//
// 这一层的口径：
//   1) 候选来源就是 config.json 的 models[]，默认模型排第一，其余按配置顺序跟在后面；
//   2) 同一个 baseURL+model 只算一个（重复添加的条目不该被重试两次）；
//   3) 最多试 MAX_FALLBACK_MODELS 个 —— 候选多了会让「全都失败」变成 3×超时的等待；
//   4) 用户主动取消（AbortError）不算失败，不该被下一个模型悄悄续上；
//   5) 已经往外吐过内容的流式调用不能换模型（会重复输出半截内容），由调用方通过
//      isFatal 判定，本层只负责「能不能继续」这件事的分发。
// ─────────────────────────────────────────────────────────────

/** 一次请求最多尝试几个模型（默认 + 备用） */
export const MAX_FALLBACK_MODELS = 3;

/**
 * 归一化 baseURL：去尾部斜杠 + 小写，只用于去重。
 * 用户可能把 `.../v1/` 和 `.../v1` 各配一遍，那是同一个端点。
 * @param {unknown} value
 * @returns {string}
 */
function normalizedBase(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

/** 只认非空字符串 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 模型的展示名：优先用户起的名字，其次模型名。
 * @param {{name?: string, model?: string}} model
 * @returns {string}
 */
export function modelLabel(model) {
  return text(model?.name) || text(model?.model) || '未命名模型';
}

/**
 * 判断一个错误是不是「用户取消」。
 * node-fetch 抛 AbortError，axios 风格是 CanceledError / ERR_CANCELED。
 * @param {any} err
 * @returns {boolean}
 */
export function isAbortLikeError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const code = String(err.code || '');
  return name === 'AbortError' || name === 'CanceledError'
    || code === 'ABORT_ERR' || code === 'ERR_CANCELED';
}

/** 错误文案：空错误也得有个能看的说法，否则界面上就是一行空白 */
function errorMessage(err) {
  return String(err?.message || err || '').trim() || '未知错误';
}

/**
 * 把 config.json 的 models[] 整理成「默认模型优先」的候选链。
 *
 * @param {Array<object>} models
 * @param {object} [opts]
 * @param {number} [opts.limit=MAX_FALLBACK_MODELS] 最多返回几个（<=0 表示不限）
 * @param {boolean} [opts.defaultFirst=true] 是否把 isDefault 提到第一位。
 *        调用方已经排好序（例如用户显式指定的模型要打头）时传 false。
 * @returns {Array<object>}
 */
export function buildModelFallbackChain(models, { limit = MAX_FALLBACK_MODELS, defaultFirst = true } = {}) {
  const list = Array.isArray(models) ? models : [];
  const seen = new Set();
  const usable = [];

  for (const model of list) {
    if (!model || typeof model !== 'object') continue;
    // 缺 endpoint / 缺模型名的条目发出去也只能报错，直接跳过
    if (!text(model.baseURL) || !text(model.model)) continue;
    const key = `${normalizedBase(model.baseURL)}\u0000${text(model.model).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(model);
  }

  const defaultIndex = defaultFirst ? usable.findIndex(m => m.isDefault) : -1;
  const ordered = defaultIndex > 0
    ? [usable[defaultIndex], ...usable.slice(0, defaultIndex), ...usable.slice(defaultIndex + 1)]
    : usable;

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : ordered.length;
  return ordered.slice(0, cap);
}

/**
 * 给「全都失败」的错误补上每个模型各自的报错，否则界面上只剩最后那个模型的文案，
 * 用户看不出到底试过谁、前一个为什么不行。
 */
function decorateError(err, attempts) {
  // 只试了一个（没发生切换）→ 原样抛，保持各调用点此前的错误文案与错误类型
  if (attempts.length <= 1) return err;
  const detail = attempts.map(a => `${a.label}（${a.message}）`).join('；');
  const wrapped = new Error(`所有 AI 模型都调用失败：${detail}`);
  wrapped.attempts = attempts;
  wrapped.cause = err;
  // 保留最后一次的错误码：路由层靠 code 区分 TIMEOUT / NO_JSON 等分支
  if (err && typeof err === 'object' && err.code !== undefined) wrapped.code = err.code;
  return wrapped;
}

/**
 * 依次用候选模型执行 run(model)，前一个失败才换下一个。
 *
 * @param {Array<object>} chain - buildModelFallbackChain 的结果
 * @param {(model: object, index: number) => Promise<any>} run
 * @param {object} [opts]
 * @param {(err: any, model: object, index: number) => boolean} [opts.isFatal]
 *        返回 true = 这个错误不该换模型（用户取消 / 流里已经吐过内容）
 * @param {(info: {error: any, from: object, to: object, index: number}) => void} [opts.onFallback]
 *        发生切换时的回调（调用方拿去打日志 / 提示）
 * @returns {Promise<{result: any, model: object, attempts: Array<object>}>}
 *          result 是 run 的返回值，model 是**真正成功**的那个模型
 * @throws {Error} 全部失败时抛出（带 attempts），或首个致命错误原样抛出
 */
export async function runWithModelFallback(chain, run, opts = {}) {
  const list = Array.isArray(chain) ? chain.filter(Boolean) : [];
  const { isFatal, onFallback } = opts;
  if (list.length === 0) throw new Error('未配置 AI 模型');

  const attempts = [];
  for (let i = 0; i < list.length; i += 1) {
    const model = list[i];
    try {
      const result = await run(model, i);
      return { result, model, attempts };
    } catch (err) {
      attempts.push({ model, label: modelLabel(model), message: errorMessage(err), error: err });
      let fatal = isAbortLikeError(err);
      if (!fatal && typeof isFatal === 'function') {
        try {
          fatal = Boolean(isFatal(err, model, i));
        } catch {
          fatal = false;
        }
      }
      if (fatal || i === list.length - 1) throw decorateError(err, attempts);
      try {
        onFallback?.({ error: err, from: model, to: list[i + 1], index: i });
      } catch { /* 日志回调自己出错不该影响重试 */ }
    }
  }

  // 循环正常结束只可能是 list 为空（已在上面拦掉），这里只是给 TS / 读者一个明确出口
  throw decorateError(attempts[attempts.length - 1]?.error || new Error('AI 调用失败'), attempts);
}

export default {
  MAX_FALLBACK_MODELS,
  buildModelFallbackChain,
  isAbortLikeError,
  modelLabel,
  runWithModelFallback,
};
